import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {createMysqlStore, TaskServer} from '@raven-zero/server';
import type {Task, TaskResult} from '@raven-zero/contracts';
import {startMysql} from './mysql_fixture.js';
import {setTimeout} from 'node:timers/promises';
import {createConnection} from 'mysql2/promise';

let mysql: Awaited<ReturnType<typeof startMysql>>;
before(async () => { mysql = await startMysql(); });
after(async () => { await mysql?.close(); });
const task: Task = {id: 'report', agent: {name: 'simulated', prompt: '生成中文报告'},
  initialization: [], checks: {before: [], after: []}, artifacts: []};

test('启动只核对迁移，显式迁移后任务和执行身份跨服务重启持久化', async () => {
  const config = {socketPath: mysql.socketPath, user: 'root', database: await mysql.database()};
  const store = createMysqlStore(config);
  const host = await createConnection(config);
  try {
    await host.query('CREATE TABLE host_data (value VARCHAR(64) NOT NULL)');
    await host.query("INSERT INTO host_data VALUES ('宿主的数据')");
    await assert.rejects(store.checkCompatibility(), /migration/i);
    const [beforeTables] = await host.query('SHOW TABLES');
    assert.equal(Array.isArray(beforeTables) ? beforeTables.length : 0, 1);
    await store.migrate();
    await store.migrate();
    await store.checkCompatibility();
    const [hostRows] = await host.query('SELECT value FROM host_data');
    assert.deepEqual(hostRows, [{value: '宿主的数据'}]);
    const server = new TaskServer(store);
    const submitted = await server.submit(task);
    assert.equal(submitted.status, 'queued');
    assert.equal(submitted.clientId, null);
    await store.close();
    const reopened = createMysqlStore(config);
    try {
      await reopened.checkCompatibility();
      assert.deepEqual(await new TaskServer(reopened).get(task.id), submitted);
      await assert.rejects(new TaskServer(reopened).submit(task), /already exists/);
    } finally { await reopened.close(); }
  } finally { await host.end(); await store.close(); }
});

test('失联不转派；取消离线执行保持待确认，只有原客户端停止结果释放名额', async () => {
  const store = createMysqlStore({socketPath: mysql.socketPath, user: 'root', database: await mysql.database()});
  try {
    await store.migrate();
    const server = new TaskServer(store);
    const capabilities = {agents: ['simulated'], deliveryComponents: [], slots: 1};
    const owner = await server.registerClient({id: 'offline-owner', capabilities});
    const other = await server.registerClient({id: 'online-other', capabilities});
    await server.submit({...task, id: 'offline'});
    const assigned = await server.claim(owner.token, 0);
    assert.ok(assigned);
    await setTimeout(120);
    assert.equal(await server.claim(other.token, 150), null);
    const cancelled = await server.cancel('offline');
    assert.equal(cancelled.status, 'assigned');
    assert.equal(cancelled.cancellationRequested, true);
    assert.equal(cancelled.clientId, 'offline-owner');
    assert.equal((await server.heartbeat(owner.token, capabilities)).runs[0]?.cancellationRequested, true);
    const result: TaskResult = {runId: assigned.runId, taskId: 'offline', version: 1,
      status: 'succeeded', output: null, checks: [], artifacts: []};
    await assert.rejects(server.reportResult(owner.token, result), /stop confirmation/);
    assert.equal((await server.reportResult(owner.token, {...result, status: 'cancelled'})).task.status, 'cancelled');
    assert.equal((await server.heartbeat(owner.token, capabilities)).runs.length, 0);
    await server.submit({...task, id: 'never-started'});
    assert.equal((await server.cancel('never-started')).status, 'cancelled');
    assert.equal(await server.claim(other.token, 0), null);
    await server.submit({...task, id: 'needs-artifact', artifacts: ['report.txt']});
    const artifact = await server.claim(other.token, 0);
    assert.ok(artifact);
    await assert.rejects(server.reportResult(other.token, {...result, runId: artifact.runId,
      taskId: 'needs-artifact'}), /file artifacts/);
    assert.equal((await server.get('needs-artifact')).status, 'assigned');
  } finally { await store.close(); }
});

test('错误归属不能上报；确认丢失、并发重报和重启补报不重复完成执行', async () => {
  const config = {socketPath: mysql.socketPath, user: 'root', database: await mysql.database()};
  const store = createMysqlStore(config);
  try {
    await store.migrate();
    const server = new TaskServer(store);
    const capabilities = {agents: ['simulated'], deliveryComponents: [], slots: 1};
    const owner = await server.registerClient({id: 'result-owner', capabilities});
    const stranger = await server.registerClient({id: 'stranger', capabilities});
    await server.submit({...task, id: 'result-task'});
    const assigned = await server.claim(owner.token, 0);
    assert.ok(assigned);
    assert.equal(assigned.task.id, 'result-task');
    await assert.rejects(server.progress(stranger.token, assigned.runId, {status: 'working'}), /owner/);
    await server.progress(owner.token, assigned.runId, {status: 'waiting_for_input', reason: '等待中文回答 🐦'});
    assert.equal((await server.get('result-task')).progress?.reason, '等待中文回答 🐦');
    const result: TaskResult = {runId: assigned.runId, taskId: assigned.task.id, version: 1,
      status: 'succeeded', output: {report: '中文 🐦', exact: '9007199254740993', jsonNumber: 1e20, nothing: null}, checks: [], artifacts: []};
    await assert.rejects(server.reportResult(stranger.token, result), /owner/);
    const receipts = await Promise.all(Array.from({length: 5}, () => server.reportResult(owner.token, result)));
    assert.equal(receipts.filter(receipt => !receipt.duplicate).length, 1);
    assert.equal(receipts[0]?.task.status, 'succeeded');
    await assert.rejects(server.reportResult(owner.token, {...result, output: 'different'}), /different/);
    await assert.rejects(server.reportResult(owner.token, {...result, version: 2}), /completed/);
    await assert.rejects(server.progress(owner.token, assigned.runId, {status: 'working'}), /completed/);
    await store.close();
    const reopened = createMysqlStore(config);
    try {
      const restored = new TaskServer(reopened);
      assert.equal((await restored.reportResult(owner.token, result)).duplicate, true);
      assert.deepEqual((await restored.get('result-task')).result, result);
      // Client token and ownership survive restart; completed runs release the slot exactly once.
      await restored.submit({...task, id: 'after-result'});
      assert.equal((await restored.claim(owner.token, 0))?.task.id, 'after-result');
    } finally { await reopened.close(); }
  } finally { await store.close(); }
});

test('能力和名额匹配；同一客户端及不同客户端竞争时执行只有一个归属', async () => {
  const store = createMysqlStore({socketPath: mysql.socketPath, user: 'root', database: await mysql.database()});
  try {
    await store.migrate();
    const server = new TaskServer(store);
    await server.submit(task);
    const capabilities = {agents: ['simulated'], deliveryComponents: [], slots: 1};
    const a = await server.registerClient({id: 'a', capabilities});
    const b = await server.registerClient({id: 'b', capabilities});
    const wrong = await server.registerClient({id: 'wrong', capabilities: {...capabilities, agents: ['other']}});
    const paused = await server.registerClient({id: 'paused', capabilities: {...capabilities, slots: 0}});
    assert.equal(await server.claim(wrong.token, 0), null);
    assert.equal(await server.claim(paused.token, 0), null);
    const claims = await Promise.all(Array.from({length: 10}, (_, i) => server.claim(i % 2 ? a.token : b.token, 0)));
    const assigned = claims.filter(value => value !== null);
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0]?.task.id, 'report');
    const owner = assigned[0]?.clientId === 'a' ? a : b;
    const other = owner === a ? b : a;
    await server.submit({...task, id: 'second'});
    assert.equal(await server.claim(owner.token, 0), null);
    assert.equal((await server.claim(other.token, 0))?.task.id, 'second');
    await server.submit({...task, id: 'git', delivery: {component: 'git-branch', parameters: {}}});
    assert.equal(await server.claim(wrong.token, 0), null);
    await server.heartbeat(wrong.token, {...capabilities, agents: ['simulated']});
    assert.equal(await server.claim(wrong.token, 0), null);
    await server.heartbeat(wrong.token, {...capabilities, deliveryComponents: ['git-branch']});
    assert.equal((await server.claim(wrong.token, 0))?.task.id, 'git');
    await server.revokeClient('wrong');
    await assert.rejects(server.heartbeat(wrong.token, capabilities), /Unauthorized/);
    await assert.rejects(server.claim('invalid-token', 0), /Unauthorized/);
  } finally { await store.close(); }
});
