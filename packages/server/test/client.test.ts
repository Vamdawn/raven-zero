import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import Fastify from 'fastify';
import {createMysqlStore, TaskServer, ravenRoutes} from '@raven-zero/server';
import {ClientManager, HttpTaskServer, SqliteClientStore} from '@raven-zero/client';
import {GitBranchDelivery, LocalTaskRunner, NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';
import type {TaskResult, TaskRun} from '@raven-zero/contracts';
import type {Command, CommandResult} from '@raven-zero/contracts';
import {clientTokenSchema, serverTaskSchema} from '@raven-zero/contracts';
import {startMysql} from './mysql_fixture.js';

let mysql: Awaited<ReturnType<typeof startMysql>>;
before(async () => { mysql = await startMysql(); });
after(async () => { await mysql?.close(); });
const managementToken = 'management-secret-for-client-tests-0001';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raven-client-'));
  const config = {socketPath: mysql.socketPath, user: 'root', database: await mysql.database()};
  const serverStore = createMysqlStore(config);
  await serverStore.migrate();
  // The fixture owns all TCP connections, including fetch's replacement
  // keep-alive sockets after an aborted request. Route preClose still drains
  // its claim transactions before the server reaps those sockets.
  const app = Fastify({forceCloseConnections: true});
  const faults = {offline: false, corruptReceipt: false, corruptedReceipts: 0, lostClaim: false, lostClaims: 0,
    lostResult: false, droppedResults: 0, offlineAfterResult: false, duplicateResults: 0, claimsStarted: 0,
    pauseHeartbeat: false, pausedHeartbeats: 0, loseStopConfirmation: false, lostStopConfirmations: 0};
  const heartbeatGate = Promise.withResolvers<void>();
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.endsWith('/claim')) faults.claimsStarted++;
    if (faults.offline && request.headers.authorization !== `Bearer ${managementToken}`) {
      reply.hijack();
      reply.raw.destroy();
    }
    if (faults.pauseHeartbeat && request.url.endsWith('/heartbeat')) {
      faults.pausedHeartbeats++;
      await heartbeatGate.promise;
    }
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode !== 200) return payload;
    if (request.url.endsWith('/progress') && faults.loseStopConfirmation && typeof payload === 'string' &&
      JSON.parse(payload).progress?.status === 'stop_confirmed') {
      faults.loseStopConfirmation = false;
      faults.lostStopConfirmations++;
      faults.offline = true;
      reply.hijack();
      reply.raw.destroy();
    }
    if ((request.url.endsWith('/claim') && faults.lostClaim) || (request.url.endsWith('/results') && faults.lostResult)) {
      if (request.url.endsWith('/claim')) { faults.lostClaim = false; faults.lostClaims++; }
      else {
        faults.lostResult = false;
        faults.droppedResults++;
        if (faults.offlineAfterResult) faults.offline = true;
      }
      reply.hijack();
      reply.raw.destroy();
    }
    if (request.url.endsWith('/results') && faults.corruptReceipt && typeof payload === 'string') {
      const receipt = JSON.parse(payload);
      receipt.task.runId = randomUUID();
      faults.corruptedReceipts++;
      return JSON.stringify(receipt);
    }
    if (request.url.endsWith('/results') && typeof payload === 'string' && JSON.parse(payload).duplicate) faults.duplicateResults++;
    return payload;
  });
  await app.register(ravenRoutes, {server: new TaskServer(serverStore), managementToken, prefix: '/raven/v1'});
  const address = await app.listen({host: '127.0.0.1', port: 0});
  const baseUrl = `${address}/raven/v1`;
  async function admin(path: string, body?: unknown) {
    const response = await fetch(`${baseUrl}${path}`, {method: body === undefined ? 'GET' : 'POST',
      headers: {authorization: `Bearer ${managementToken}`, 'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const registration = clientTokenSchema.parse(await admin('/clients', {id: 'client',
    capabilities: {agents: ['simulated'], deliveryComponents: ['git-branch'], slots: 1}}));
  return {root, app, baseUrl, faults, releaseHeartbeat: () => heartbeatGate.resolve(), token: registration.token, admin, async close() {
    await app.close();
    await serverStore.close();
    await rm(root, {recursive: true, force: true});
  }};
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, '客户端必须在期限内达到指定状态');
    await setTimeout(20);
  }
}

test('一项执行的持久化失败及时拒绝 start，不被另一项人工等待遮蔽', async () => {
  const f = await fixture();
  let failures = 0;
  class FailingStore extends SqliteClientStore {
    failWrites = true;
    override saveRun(run: TaskRun): void {
      if (this.failWrites && run.task.id === 'broken' && ['completion_candidate', 'pending_verification'].includes(run.status)) {
        failures++;
        throw new Error('SQLite write failed');
      }
      super.saveRun(run);
    }
    override pendingResults(): TaskResult[] {
      if (this.failWrites && failures >= 2) throw new Error('Secondary SQLite scan failed');
      return super.pendingResults();
    }
  }
  const store = new FailingStore(join(f.root, 'client.sqlite'));
  const release = Promise.withResolvers<void>();
  const brokenStarted = Promise.withResolvers<void>();
  const releaseBroken = Promise.withResolvers<void>();
  let observedSignal: AbortSignal | undefined;
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), slots: 2, pollMs: 20,
    agent: new SimulatedAgent(async ({task, signal}) => {
      if (task.id === 'broken') {
        brokenStarted.resolve();
        await releaseBroken.promise;
        return {status: 'completion_candidate', output: '触发记录失败'};
      }
      observedSignal = signal;
      await release.promise;
      return {status: 'waiting_for_input', reason: '等待回答'};
    })});
  let outcome: Promise<unknown> | undefined;
  try {
    await f.admin('/tasks', {id: 'waiting', agent: {name: 'simulated', prompt: '等待'}, initialization: [],
      checks: {before: [], after: []}, artifacts: []});
    outcome = manager.start().then(() => 'resolved', error => error);
    await eventually(async () => observedSignal !== undefined);
    await f.admin('/tasks', {id: 'broken', agent: {name: 'simulated', prompt: '失败'}, initialization: [],
      checks: {before: [], after: []}, artifacts: []});
    await brokenStarted.promise;
    f.faults.pauseHeartbeat = true;
    await eventually(async () => f.faults.pausedHeartbeats > 0);
    releaseBroken.resolve();
    await eventually(async () => failures === 2);
    const failure = await Promise.race([outcome, setTimeout(500, 'still running')]);
    assert.ok(failure instanceof Error, String(failure));
    assert.match(failure.message, /SQLite write failed/);
    assert.equal(manager.snapshot().accepting, false);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(store.list().find(record => record.assignment.task.id === 'waiting')?.run?.status, 'pending_verification');
    store.failWrites = false;
    const restarted = manager.start();
    outcome = restarted.then(() => 'resolved', error => error);
    await eventually(async () => store.list().every(record => record.run?.status === 'pending_verification'));
    assert.equal(store.pendingResults().length, 0);
  } finally {
    store.failWrites = false;
    release.resolve(); releaseBroken.resolve(); f.releaseHeartbeat();
    await manager.stop().catch(() => {}); await outcome; store.close(); await f.close();
  }
});

test('HTTP 回执之后的 SQLite 读取失败拒绝 start，不能作为断网重试', async () => {
  const f = await fixture();
  class FailingStore extends SqliteClientStore {
    failNextRead = false;
    override get(runId: string): ReturnType<SqliteClientStore['get']> {
      if (this.failNextRead) { this.failNextRead = false; throw new Error('SQLite read failed'); }
      return super.get(runId);
    }
  }
  const store = new FailingStore(join(f.root, 'client.sqlite'));
  class ReceiptServer extends HttpTaskServer {
    override async reportResult(...args: Parameters<HttpTaskServer['reportResult']>): ReturnType<HttpTaskServer['reportResult']> {
      const receipt = await super.reportResult(...args);
      store.failNextRead = true;
      return receipt;
    }
  }
  const manager = new ClientManager({server: new ReceiptServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 20,
    agent: new SimulatedAgent(async () => ({status: 'completion_candidate', output: '报告'}))});
  let outcome: Promise<unknown> | undefined;
  try {
    await f.admin('/tasks', {id: 'read-failure', agent: {name: 'simulated', prompt: '报告'}, initialization: [],
      checks: {before: [], after: []}, artifacts: []});
    outcome = manager.start().then(() => 'resolved', error => error);
    await eventually(async () => serverTaskSchema.parse(await f.admin('/tasks/read-failure')).status === 'succeeded');
    const failure = await Promise.race([outcome, setTimeout(500, 'still running')]);
    assert.ok(failure instanceof Error, String(failure));
    assert.match(failure.message, /SQLite read failed/);
    assert.equal(manager.snapshot().connectionError, undefined);
    assert.equal(store.pendingResults().length, 1);
  } finally { await manager.stop().catch(() => {}); await outcome; store.close(); await f.close(); }
});

test('工作区准备期间立即停止也取消新执行，重新开启不启动 Agent', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const preparing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class GatedFiles extends NodeFileExecution {
    override async prepare(...args: Parameters<NodeFileExecution['prepare']>): ReturnType<NodeFileExecution['prepare']> {
      preparing.resolve();
      await release.promise;
      return super.prepare(...args);
    }
  }
  let observations = 0;
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new GatedFiles(), pollMs: 20,
    agent: new SimulatedAgent(async () => { observations++; return {status: 'waiting_for_input', reason: '等待'}; })});
  let running: Promise<void> | undefined;
  try {
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {id: 'preparing',
      agent: {name: 'simulated', prompt: '报告'}, initialization: [], checks: {before: [], after: []}, artifacts: []}));
    running = manager.start();
    await preparing.promise;
    const stopping = manager.stop();
    release.resolve();
    const records = await stopping;
    await running;
    assert.equal(records[0]?.run?.status, 'cancelled');
    assert.ok(records[0]?.run?.history.includes('stop_confirmed'));
    assert.equal(observations, 0);
    running = manager.start();
    manager.stopAccepting();
    await running;
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/preparing')).status, 'cancelled');
    assert.equal(store.get(assignment.runId)?.run?.status, 'cancelled');
    assert.equal(observations, 0);
  } finally { release.resolve(); await manager.stop(); await running; store.close(); await f.close(); }
});

test('离线完成后的取消确认停止再补报原结果，旧进度不能代替确认，确认丢失可重启恢复', async () => {
  const f = await fixture();
  const database = join(f.root, 'client.sqlite');
  let store = new SqliteClientStore(database);
  const release = Promise.withResolvers<void>();
  const http = new HttpTaskServer(f.baseUrl, f.token);
  let observations = 0;
  const agent = new SimulatedAgent(async () => {
    observations++;
    await release.promise;
    return {status: 'completion_candidate', output: '离线报告'};
  });
  let manager = new ClientManager({server: http, store, root: join(f.root, 'runs'),
    files: new NodeFileExecution(), agent, pollMs: 20});
  let running: Promise<void> | undefined;
  try {
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {id: 'late-cancel',
      agent: {name: 'simulated', prompt: '报告'}, initialization: [], checks: {before: [], after: []}, artifacts: []}));
    running = manager.start();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'working');
    f.faults.offline = true;
    release.resolve();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'succeeded');
    const original = store.pendingResults()[0];
    assert.ok(original);
    await manager.stop();
    await running;
    f.faults.offline = false;
    // Ordinary completion can have reported this phase before the cancel request.
    await http.progress(assignment.runId, {status: 'stop_confirmed'});
    const cancelled = serverTaskSchema.parse(await f.admin('/tasks/late-cancel/cancel', {}));
    assert.equal(cancelled.progress, null);
    await assert.rejects(http.reportResult(original), /Cancellation requires stop confirmation/);
    store.close();
    store = new SqliteClientStore(database);
    manager = new ClientManager({server: http, store, root: join(f.root, 'runs'), files: new NodeFileExecution(),
      agent: new SimulatedAgent(async () => { throw new Error('已完成的取消不得重跑'); }), pollMs: 20});
    f.faults.loseStopConfirmation = true;
    running = manager.start();
    await eventually(async () => f.faults.lostStopConfirmations === 1 && manager.snapshot().connectionError !== undefined);
    assert.deepEqual(store.pendingResults(), [original]);
    const repeated = serverTaskSchema.parse(await f.admin('/tasks/late-cancel/cancel', {}));
    assert.equal(repeated.status, 'assigned');
    assert.equal(repeated.progress?.status, 'stop_confirmed');
    await manager.stop();
    await running;
    store.close();
    store = new SqliteClientStore(database);
    manager = new ClientManager({server: http, store, root: join(f.root, 'runs'), files: new NodeFileExecution(),
      agent: new SimulatedAgent(async () => { throw new Error('补报不得重跑'); }), pollMs: 20});
    f.faults.offline = false;
    f.faults.lostResult = true;
    f.faults.offlineAfterResult = true;
    running = manager.start();
    await eventually(async () => f.faults.droppedResults === 1 && manager.snapshot().connectionError !== undefined);
    assert.deepEqual(store.pendingResults(), [original]);
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/late-cancel')).status, 'succeeded');
    await manager.stop();
    await running;
    store.close();
    store = new SqliteClientStore(database);
    manager = new ClientManager({server: http, store, root: join(f.root, 'runs'), files: new NodeFileExecution(),
      agent: new SimulatedAgent(async () => { throw new Error('重复确认不得重跑'); }), pollMs: 20});
    f.faults.offline = false;
    running = manager.start();
    manager.stopAccepting();
    await eventually(async () => store.pendingResults().length === 0);
    await running;
    const completed = serverTaskSchema.parse(await f.admin('/tasks/late-cancel'));
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.result, original);
    assert.deepEqual(store.get(assignment.runId)?.run?.results, [original]);
    assert.equal(store.pendingResults().length, 0);
    assert.equal(observations, 1);
    assert.ok(f.faults.duplicateResults > 0);
  } finally { release.resolve(); await manager.stop(); await running; store.close(); await f.close(); }
});

test('用户开启客户端后经 HTTP 领取报告任务，本地 SQLite 保存结果后上报', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const files = new NodeFileExecution();
  const agent = new SimulatedAgent(async ({session}) => {
    const input = await readFile(join(session.workspace, 'input.txt'), 'utf8');
    await writeFile(join(session.workspace, 'report.txt'), `报告：${input}`);
    return {status: 'completion_candidate', output: {summary: '中文报告'}};
  });
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), agent, files, pollMs: 20});
  let running: Promise<void> | undefined;
  try {
    const input = join(f.root, 'input.txt');
    await writeFile(input, '真实输入');
    const assigned = serverTaskSchema.parse(await f.admin('/tasks', {
      id: 'report', agent: {name: 'simulated', prompt: '生成报告'},
      initialization: [{kind: 'file', source: input, destination: 'input.txt'}],
      checks: {before: [{kind: 'file', path: 'report.txt'}, {kind: 'command', command: {
        executable: process.execPath,
        args: ['-e', "if(require('node:fs').readFileSync('report.txt','utf8')!=='报告：真实输入')process.exit(1)"], timeoutMs: 2000,
      }}], after: []}, artifacts: [],
    }));
    assert.equal(store.list().length, 0);
    running = manager.start();
    await eventually(async () => serverTaskSchema.parse(await f.admin('/tasks/report')).status === 'succeeded');
    manager.stopAccepting();
    await running;
    const record = store.get(assigned.runId);
    assert.ok(record?.run);
    assert.equal(record.run.id, assigned.runId);
    assert.equal(record.run.status, 'succeeded');
    assert.equal(record.assignment.status, 'succeeded');
    assert.equal(record.run.session?.workspace, record.run.workspace);
    assert.equal(await readFile(join(record.run.publications[0]?.directory ?? '', 'report.txt'), 'utf8'), '报告：真实输入');
    assert.deepEqual(serverTaskSchema.parse(await f.admin('/tasks/report')).result?.output, {summary: '中文报告'});
    assert.equal(store.pendingResults().length, 0);
  } finally {
    await manager.stop();
    await running;
    store.close();
    await f.close();
  }
});

test('领取确认丢失经心跳找回；断网继续 Git 交付，SQLite 重开后补报同一结果且不重跑 Agent', async () => {
  const f = await fixture();
  const database = join(f.root, 'client.sqlite');
  let store = new SqliteClientStore(database);
  const files = new NodeFileExecution();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let observations = 0;
  const agent = new SimulatedAgent(async ({session}) => {
    observations++;
    started.resolve();
    await release.promise;
    await writeFile(join(session.workspace, 'code.txt'), '离线代码');
    return {status: 'completion_candidate', output: {summary: '离线完成'}};
  });
  let manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files, agent, delivery: new GitBranchDelivery(files), pollMs: 20});
  let running: Promise<void> | undefined;
  try {
    const source = join(f.root, 'source');
    const remote = join(f.root, 'remote.git');
    await mkdir(source);
    gitCommand(source, ['init', '--initial-branch=main', '--template=']);
    await writeFile(join(source, 'code.txt'), '初始代码');
    gitCommand(source, ['add', 'code.txt']);
    gitCommand(source, ['commit', '-m', 'base']);
    gitCommand(f.root, ['init', '--bare', '--template=', remote]);
    gitCommand(source, ['push', remote, 'main']);
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {
      id: 'offline-code', agent: {name: 'simulated', prompt: '离线修改'}, initialization: [], artifacts: [],
      delivery: {component: 'git-branch', parameters: {remote, baseRef: 'refs/heads/main'}},
      checks: {before: [{kind: 'file', path: 'code.txt'}], after: []},
    }));
    f.faults.lostClaim = true;
    running = manager.start();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'working');
    await started.promise;
    assert.equal(f.faults.lostClaims, 1);
    // A second writer remains usable while Agent work is awaiting input.
    const otherWriter = new SqliteClientStore(database);
    try { otherWriter.saveAssignment(store.get(assignment.runId)?.assignment); } finally { otherWriter.close(); }
    f.faults.offline = true;
    release.resolve();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'succeeded');
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/offline-code')).status, 'assigned');
    const original = store.pendingResults()[0];
    assert.ok(original);
    const branch = `refs/heads/raven/${assignment.runId}`;
    const commit = gitCommand(f.root, ['--git-dir', remote, 'rev-parse', branch]);
    await manager.stop();
    await running;
    store.close();
    store = new SqliteClientStore(database);
    manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
      root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 20,
      agent: new SimulatedAgent(async () => { throw new Error('补报不得重跑 Agent'); })});
    f.faults.offline = false;
    f.faults.lostResult = true;
    f.faults.offlineAfterResult = true;
    running = manager.start();
    await eventually(async () => f.faults.droppedResults === 1 && manager.snapshot().connectionError !== undefined);
    assert.deepEqual(store.pendingResults(), [original]);
    assert.deepEqual(serverTaskSchema.parse(await f.admin('/tasks/offline-code')).result, original);
    f.faults.offline = false;
    await eventually(async () => store.pendingResults().length === 0);
    manager.stopAccepting();
    await running;
    assert.ok(f.faults.duplicateResults > 0);
    assert.equal(observations, 1);
    assert.equal(gitCommand(f.root, ['--git-dir', remote, 'rev-parse', branch]), commit);
    assert.equal(gitCommand(f.root, ['--git-dir', remote, 'rev-list', '--count', branch]), '2');
    assert.equal(gitCommand(f.root, ['--git-dir', remote, 'show', `${branch}:code.txt`]), '离线代码');
  } finally { release.resolve(); await manager.stop(); await running; store.close(); await f.close(); }
});

const git = '/Library/Developer/CommandLineTools/usr/bin/git';
function gitCommand(cwd: string, args: string[]): string {
  return execFileSync(git, ['-c', 'user.name=Raven Test', '-c', 'user.email=raven@example.test',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

test('代码任务交付真实 bare remote 后，只接受属于同一执行和结果的 HTTP 回执', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const files = new NodeFileExecution();
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files, delivery: new GitBranchDelivery(files), pollMs: 20,
    agent: new SimulatedAgent(async ({session}) => {
      await writeFile(join(session.workspace, 'code.txt'), '交付代码');
      return {status: 'completion_candidate', output: {summary: '代码已修改'}};
    })});
  let running: Promise<void> | undefined;
  try {
    const source = join(f.root, 'source');
    const remote = join(f.root, 'remote.git');
    await mkdir(source);
    gitCommand(source, ['init', '--initial-branch=main', '--template=']);
    await writeFile(join(source, 'code.txt'), '初始代码');
    gitCommand(source, ['add', 'code.txt']);
    gitCommand(source, ['commit', '-m', 'base']);
    gitCommand(f.root, ['init', '--bare', '--template=', remote]);
    gitCommand(source, ['push', remote, 'main']);
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {
      id: 'code', agent: {name: 'simulated', prompt: '修改代码'}, initialization: [], artifacts: [],
      delivery: {component: 'git-branch', parameters: {remote, baseRef: 'refs/heads/main'}},
      checks: {before: [{kind: 'file', path: 'code.txt'}], after: [{kind: 'file', path: 'code.txt'}]},
    }));
    f.faults.corruptReceipt = true;
    running = manager.start();
    await eventually(async () => f.faults.corruptedReceipts > 0);
    await manager.stop();
    await running;
    const result = store.pendingResults()[0];
    assert.ok(result, '错误归属的 HTTP 回执不能确认本地结果');
    assert.equal(result.runId, assignment.runId);
    const delivered = serverTaskSchema.parse(await f.admin('/tasks/code'));
    assert.deepEqual(delivered.result, result);
    const branch = `refs/heads/raven/${assignment.runId}`;
    assert.equal(gitCommand(f.root, ['--git-dir', remote, 'show', `${branch}:code.txt`]), '交付代码');
    assert.equal(gitCommand(f.root, ['--git-dir', remote, 'rev-list', '--count', branch]), '2');
    f.faults.corruptReceipt = false;
    running = manager.start();
    await eventually(async () => store.pendingResults().length === 0);
    manager.stopAccepting();
    await running;
  } finally { await manager.stop(); await running; store.close(); await f.close(); }
});

for (const choice of ['continue', 'retry'] as const) {
  test(`SQLite 重开不自动重跑；用户选择 ${choice} 后核对原会话和工作区再完成 HTTP 报告`, async () => {
    const f = await fixture();
    const database = join(f.root, 'client.sqlite');
    let store = new SqliteClientStore(database);
    class RecordedFiles extends NodeFileExecution {
      override async saveRun(run: TaskRun): Promise<void> { store.saveRun(run); }
      override async saveResult(_root: string, result: TaskResult): Promise<void> { store.saveResult(result); }
    }
    const files = new RecordedFiles();
    let ready = false;
    let observations = 0;
    const agent = new SimulatedAgent(async ({session}) => {
      observations++;
      if (!ready) return {status: 'waiting_for_input', reason: '等待本地回答'};
      await writeFile(join(session.workspace, 'report.txt'), '恢复报告');
      return {status: 'completion_candidate', output: '恢复完成'};
    });
    let manager: ClientManager | undefined;
    let running: Promise<void> | undefined;
    try {
      await f.admin('/tasks', {id: 'recovery-report', agent: {name: 'simulated', prompt: '报告'}, initialization: [],
        checks: {before: [{kind: 'file', path: 'report.txt'}], after: []}, artifacts: []});
      const http = new HttpTaskServer(f.baseUrl, f.token);
      const assignment = await http.claim(0);
      assert.ok(assignment);
      store.saveAssignment(assignment);
      const original = await LocalTaskRunner.create(assignment.task, {root: join(f.root, 'runs'),
        runId: assignment.runId, files, agent});
      const waiting = await original.execute();
      assert.equal(waiting.status, 'waiting_for_input');
      // Reconstruct storage and the client. Simulated dependency ownership is
      // retained; loss of that ownership is covered separately.
      store.close();
      store = new SqliteClientStore(database);
      manager = new ClientManager({server: http, store, root: join(f.root, 'runs'), files, agent, pollMs: 20});
      running = manager.start();
      await eventually(async () => serverTaskSchema.parse(await f.admin('/tasks/recovery-report')).progress?.status === 'pending_verification');
      assert.equal(observations, 1);
      assert.match(manager.snapshot().runs[0]?.run?.reason ?? '', /Explicit recovery/);
      ready = true;
      await manager.recover(assignment.runId, choice);
      await eventually(async () => serverTaskSchema.parse(await f.admin('/tasks/recovery-report')).status === 'succeeded');
      manager.stopAccepting();
      await running;
      const recovered = store.get(assignment.runId)?.run;
      assert.ok(recovered);
      assert.equal(recovered.version, choice === 'continue' ? 1 : 2);
      assert.deepEqual(recovered.session, waiting.session);
      assert.equal(recovered.workspace, waiting.workspace);
      assert.equal(observations, 2);
      assert.equal(await readFile(join(recovered.publications[0]?.directory ?? '', 'report.txt'), 'utf8'), '恢复报告');
    } finally { await manager?.stop(); await running; store.close(); await f.close(); }
  });
}

test('取消请求不等于停止确认，未确认的执行和名额保留，显式核对后才上报 cancelled', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const release = Promise.withResolvers<void>();
  const agent = new SimulatedAgent(async () => {
    await release.promise;
    return {status: 'completion_candidate', output: '停止后的晚到结果'};
  });
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), agent, pollMs: 20});
  let running: Promise<void> | undefined;
  try {
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {id: 'cancel-report',
      agent: {name: 'simulated', prompt: '长任务'}, initialization: [], checks: {before: [], after: []}, artifacts: []}));
    running = manager.start();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'working');
    await f.admin('/tasks/cancel-report/cancel', {});
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'pending_verification');
    const pending = store.get(assignment.runId)?.run;
    assert.equal(pending?.stopReason, 'cancelled');
    assert.ok(pending?.history.includes('stop_requested'));
    assert.equal(pending?.history.includes('stop_confirmed'), false);
    assert.equal(store.pendingResults().length, 0);
    const server = serverTaskSchema.parse(await f.admin('/tasks/cancel-report'));
    assert.equal(server.status, 'assigned');
    assert.equal(server.cancellationRequested, true);
    await f.admin('/tasks', {id: 'next-report', agent: {name: 'simulated', prompt: '下一个'},
      initialization: [], checks: {before: [], after: []}, artifacts: []});
    assert.equal((await new HttpTaskServer(f.baseUrl, f.token).claim(0)), null);
    release.resolve();
    await eventually(async () => pending?.session ? agent.confirmStop(pending.session) : false);
    manager.stopAccepting();
    const cancelled = await manager.cancel(assignment.runId);
    assert.equal(cancelled.status, 'cancelled', cancelled.reason);
    await running;
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/cancel-report')).status, 'cancelled');
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/next-report')).status, 'queued');
    assert.equal(cancelled.publications.length, 0);
  } finally { release.resolve(); await manager.stop(); await running; store.close(); await f.close(); }
});

test('立即停止及时中断长轮询，不等待领取期限', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 3000,
    agent: new SimulatedAgent(async () => ({status: 'working'}))});
  let running: Promise<void> | undefined;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const claims = f.faults.claimsStarted;
      running = manager.start();
      await eventually(async () => f.faults.claimsStarted > claims);
      const startedAt = Date.now();
      await manager.stop();
      await running;
      assert.ok(Date.now() - startedAt < 1000, '立即停止不能等待 3 秒领取或轮询间隔');
    }
  } finally {
    await manager.stop(); await running; store.close();
    await f.close();
  }
});

test('人工等待显示原因并占默认名额；停止接单仍等待回答，完成后退出且不领取下一任务', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  let answered = false;
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 20,
    agent: new SimulatedAgent(async ({session}) => {
      if (!answered) return {status: 'waiting_for_input', reason: '请在准确会话回答问题'};
      await writeFile(join(session.workspace, 'report.txt'), '人工回答后的报告');
      return {status: 'completion_candidate', output: '已回答'};
    })});
  let running: Promise<void> | undefined;
  try {
    await f.admin('/tasks', {id: 'waiting', agent: {name: 'simulated', prompt: '等待回答'}, initialization: [],
      checks: {before: [{kind: 'file', path: 'report.txt'}], after: []}, artifacts: []});
    running = manager.start();
    await eventually(async () => serverTaskSchema.parse(await f.admin('/tasks/waiting')).progress?.status === 'waiting_for_input');
    await f.admin('/tasks', {id: 'queued', agent: {name: 'simulated', prompt: '下一任务'}, initialization: [],
      checks: {before: [], after: []}, artifacts: []});
    assert.equal(await new HttpTaskServer(f.baseUrl, f.token).claim(0), null);
    assert.equal(manager.snapshot().runs.length, 1);
    assert.equal(manager.snapshot().runs[0]?.run?.reason, '请在准确会话回答问题');
    assert.ok(manager.snapshot().runs[0]?.run?.session?.id);
    manager.stopAccepting();
    let exited = false;
    const draining = running.then(() => { exited = true; });
    const server = serverTaskSchema.parse(await f.admin('/tasks/waiting'));
    assert.equal(server.status, 'assigned');
    assert.equal(exited, false);
    assert.equal(manager.snapshot().accepting, false);
    answered = true;
    await draining;
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/waiting')).status, 'succeeded');
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/queued')).status, 'queued');
  } finally { await manager.stop(); await running; store.close(); await f.close(); }
});

test('人工等待计入任务期限，取得停止确认后以 expired 结果结束 HTTP 任务', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store, slots: 2,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 3000,
    agent: new SimulatedAgent(async () => ({status: 'waiting_for_input', reason: '等待审批'}))});
  let running: Promise<void> | undefined;
  try {
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {id: 'expiry',
      agent: {name: 'simulated', prompt: '超期任务'}, timeoutMs: 1500, initialization: [],
      checks: {before: [], after: []}, artifacts: []}));
    running = manager.start();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'waiting_for_input');
    manager.stopAccepting();
    await running;
    const run = store.get(assignment.runId)?.run;
    assert.equal(run?.status, 'expired');
    assert.ok(Date.now() - (run?.deadlineAt ?? 0) < 1000, '人工等待期限不能被 3 秒轮询间隔拖延');
    assert.ok(run?.history.includes('stop_requested'));
    assert.ok(run?.history.includes('stop_confirmed'));
    assert.equal(run?.publications.length, 0);
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/expiry')).result?.status, 'expired');
  } finally { await manager.stop(); await running; store.close(); await f.close(); }
});

test('HTTP 心跳挂起时本地人工等待仍按期限停止，SQLite 可写并保存超期结果，恢复网络后补报', async () => {
  const f = await fixture();
  const database = join(f.root, 'client.sqlite');
  const store = new SqliteClientStore(database);
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 20,
    agent: new SimulatedAgent(async () => ({status: 'waiting_for_input', reason: '离线等待回答'}))});
  let running: Promise<void> | undefined;
  try {
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {id: 'offline-expiry',
      agent: {name: 'simulated', prompt: '等待回答'}, timeoutMs: 1500, initialization: [],
      checks: {before: [], after: []}, artifacts: []}));
    running = manager.start();
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'waiting_for_input');
    f.faults.pauseHeartbeat = true;
    await eventually(async () => f.faults.pausedHeartbeats > 0);
    const otherWriter = new SqliteClientStore(database);
    try { otherWriter.saveAssignment(store.get(assignment.runId)?.assignment); } finally { otherWriter.close(); }
    await eventually(async () => store.get(assignment.runId)?.run?.status === 'expired');
    assert.equal(store.pendingResults()[0]?.status, 'expired');
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/offline-expiry')).status, 'assigned');
    manager.stopAccepting();
    f.releaseHeartbeat();
    await running;
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/offline-expiry')).status, 'expired');
    assert.equal(store.pendingResults().length, 0);
  } finally { f.releaseHeartbeat(); await manager.stop(); await running; store.close(); await f.close(); }
});

test('配置两个名额时保留独立工作区和会话；两个人工等待不释放名额给第三任务', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store, slots: 2,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 20,
    agent: new SimulatedAgent(async () => ({status: 'waiting_for_input', reason: '等待各自回答'}))});
  let running: Promise<void> | undefined;
  try {
    for (const id of ['one', 'two', 'three']) await f.admin('/tasks', {id,
      agent: {name: 'simulated', prompt: id}, initialization: [], checks: {before: [], after: []}, artifacts: []});
    running = manager.start();
    await eventually(async () => store.list().filter(record => record.run?.status === 'waiting_for_input').length === 2);
    const runs = store.list().map(record => record.run);
    assert.notEqual(runs[0]?.workspace, runs[1]?.workspace);
    assert.notEqual(runs[0]?.session?.id, runs[1]?.session?.id);
    assert.equal(await new HttpTaskServer(f.baseUrl, f.token).claim(0), null);
    const stopped = await manager.stop();
    await running;
    assert.equal(stopped.length, 2);
    assert.ok(stopped.every(record => record.run?.status === 'cancelled'));
    const tasks = await Promise.all(['one', 'two', 'three'].map(async id => serverTaskSchema.parse(await f.admin(`/tasks/${id}`))));
    assert.equal(tasks.filter(task => task.status === 'queued').length, 1);
  } finally { await manager.stop(); await running; store.close(); await f.close(); }
});

test('文件传输尚未建立时保存报告产物与结果，保留 HTTP 补报和可观察原因，不提前完成服务端任务', async () => {
  const f = await fixture();
  const store = new SqliteClientStore(join(f.root, 'client.sqlite'));
  const manager = new ClientManager({server: new HttpTaskServer(f.baseUrl, f.token), store,
    root: join(f.root, 'runs'), files: new NodeFileExecution(), pollMs: 20,
    agent: new SimulatedAgent(async ({session}) => {
      await writeFile(join(session.workspace, 'report.txt'), '待传输报告');
      return {status: 'completion_candidate', output: '报告已保存'};
    })});
  let running: Promise<void> | undefined;
  try {
    const assignment = serverTaskSchema.parse(await f.admin('/tasks', {id: 'artifact-report',
      agent: {name: 'simulated', prompt: '报告'}, initialization: [],
      checks: {before: [{kind: 'file', path: 'report.txt'}], after: []}, artifacts: ['report.txt']}));
    running = manager.start();
    await eventually(async () => manager.snapshot().connectionError?.includes('artifact transport') ?? false);
    manager.stopAccepting();
    const receiptState = manager.snapshot();
    assert.match(receiptState.connectionError ?? '', /artifact transport/);
    await manager.stop();
    await running;
    assert.match(manager.snapshot().connectionError ?? '', /artifact transport/);
    assert.equal(serverTaskSchema.parse(await f.admin('/tasks/artifact-report')).status, 'assigned');
    const pending = store.pendingResults()[0];
    assert.equal(pending?.runId, assignment.runId);
    assert.equal(await readFile(pending?.artifacts[0]?.file ?? '', 'utf8'), '待传输报告');
    assert.equal(pending?.artifacts[0]?.version, 1);
  } finally { await manager.stop(); await running; store.close(); await f.close(); }
});

for (const effect of ['commit', 'checkpoint', 'push', 'transition'] as const) {
  for (const timing of ['before', 'after'] as const) {
    test(`SQLite 恢复故障矩阵：${effect} ${timing} 中断后显式完成同版 HTTP 交付`, async () => {
      const f = await fixture();
      const database = join(f.root, 'client.sqlite');
      const interruption = {armed: true, stopped: false};
      function interrupt(): never { interruption.stopped = true; throw new Error('模拟客户端中断'); }
      class InterruptedStore extends SqliteClientStore {
        override saveRun(run: TaskRun): void {
          if (interruption.stopped) throw new Error('模拟 SQLite 写入中断');
          const target = effect === 'transition' ? run.status === 'checking_after' :
            effect === 'checkpoint' && run.status === 'delivering' && run.delivery !== undefined;
          if (interruption.armed && target && timing === 'before') interrupt();
          super.saveRun(run);
          if (interruption.armed && target && timing === 'after') interrupt();
        }
      }
      let store: SqliteClientStore = new InterruptedStore(database);
      class InterruptedFiles extends NodeFileExecution {
        commits = 0;
        pushes = 0;
        override async command(input: Command, workspace: string, signal: AbortSignal,
          environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
          const target = (effect === 'commit' || effect === 'push') && input.args.includes(effect);
          if (interruption.armed && target && timing === 'before') interrupt();
          const result = await super.command(input, workspace, signal, environment);
          if (result.status === 'exited' && result.exitCode === 0) {
            if (input.args.includes('commit')) this.commits++;
            if (input.args.includes('push')) this.pushes++;
          }
          if (interruption.armed && target && timing === 'after') interrupt();
          return result;
        }
        override async saveRun(run: TaskRun): Promise<void> { store.saveRun(run); }
        override async saveResult(_root: string, result: TaskResult): Promise<void> { store.saveResult(result); }
      }
      const files = new InterruptedFiles();
      let observations = 0;
      const agent = new SimulatedAgent(async ({session, version}) => {
        observations++;
        await writeFile(join(session.workspace, 'code.txt'), `第${version}版`);
        return {status: 'completion_candidate', output: {version}};
      });
      let manager: ClientManager | undefined;
      let running: Promise<void> | undefined;
      try {
        const source = join(f.root, 'source');
        const remote = join(f.root, 'remote.git');
        await mkdir(source);
        gitCommand(source, ['init', '--initial-branch=main', '--template=']);
        await writeFile(join(source, 'code.txt'), '初始代码');
        gitCommand(source, ['add', 'code.txt']);
        gitCommand(source, ['commit', '-m', 'base']);
        gitCommand(f.root, ['init', '--bare', '--template=', remote]);
        gitCommand(source, ['push', remote, 'main']);
        await f.admin('/tasks', {id: 'matrix-code', agent: {name: 'simulated', prompt: '修改代码'}, initialization: [], artifacts: [],
          delivery: {component: 'git-branch', parameters: {remote, baseRef: 'refs/heads/main'}},
          checks: {before: [{kind: 'file', path: 'code.txt'}], after: [{kind: 'file', path: 'code.txt'}]}});
        const http = new HttpTaskServer(f.baseUrl, f.token);
        const assignment = await http.claim(0);
        assert.ok(assignment);
        store.saveAssignment(assignment);
        const root = join(f.root, 'runs');
        const runner = await LocalTaskRunner.create(assignment.task, {root, runId: assignment.runId,
          agent, files, delivery: new GitBranchDelivery(files)});
        await assert.rejects(runner.execute(), /SQLite 写入中断/);
        assert.equal(interruption.stopped, true);
        const retained = store.get(assignment.runId)?.run;
        assert.ok(retained);
        assert.equal(retained.status, effect === 'transition' && timing === 'after' ? 'checking_after' : 'delivering');
        const branch = `refs/heads/raven/${assignment.runId}`;
        const originalCommit = gitCommand(f.root, ['--git-dir', join(retained.root, 'git'), 'rev-parse', 'refs/raven/versions/1']);
        const originalRemote = gitCommand(f.root, ['--git-dir', remote, 'for-each-ref', '--format=%(objectname)', branch]);
        const committed = files.commits === 1;
        const pushed = files.pushes === 1;
        assert.equal(originalRemote !== '', pushed);
        interruption.armed = false;
        interruption.stopped = false;
        store.close();
        store = new SqliteClientStore(database);
        manager = new ClientManager({server: http, store, root, files, agent, delivery: new GitBranchDelivery(files), pollMs: 20});
        running = manager.start();
        await eventually(async () => store.get(assignment.runId)?.run?.status === 'pending_verification');
        await manager.recover(assignment.runId, 'continue');
        await eventually(async () => serverTaskSchema.parse(await f.admin('/tasks/matrix-code')).status === 'succeeded');
        manager.stopAccepting();
        await running;
        const recovered = store.get(assignment.runId)?.run;
        assert.ok(recovered);
        assert.equal(recovered.version, 1);
        assert.equal(observations, 1);
        assert.deepEqual(recovered.session, retained.session);
        assert.deepEqual(recovered.publications, retained.publications);
        assert.equal(recovered.checks.filter(check => check.stage === 'after').length, 1);
        assert.equal(files.commits, 1);
        assert.equal(files.pushes, 1);
        const commit = gitCommand(f.root, ['--git-dir', remote, 'rev-parse', branch]);
        if (committed) assert.equal(commit, originalCommit);
        if (pushed) assert.equal(commit, originalRemote);
        assert.equal(gitCommand(f.root, ['--git-dir', remote, 'show', `${branch}:code.txt`]), '第1版');
        assert.equal(gitCommand(f.root, ['--git-dir', remote, 'rev-list', '--count', branch]), '2');
        // The single-task server has no completed-run retry protocol. Verify
        // the next local version separately without submitting it as a new run.
        const next = await LocalTaskRunner.restore(recovered, {root, files, agent, delivery: new GitBranchDelivery(files)});
        await next.resume();
        const second = await next.execute();
        assert.equal(second.status, 'succeeded', second.reason);
        assert.equal(second.version, 2);
        assert.equal(gitCommand(f.root, ['--git-dir', remote, 'rev-parse', `${branch}^`]), commit);
        assert.equal(gitCommand(f.root, ['--git-dir', remote, 'show', `${commit}:code.txt`]), '第1版');
        assert.deepEqual(second.results[0], recovered.results[0]);
        assert.deepEqual(serverTaskSchema.parse(await f.admin('/tasks/matrix-code')).result, recovered.results[0]);
      } finally { await manager?.stop(); await running; store.close(); await f.close(); }
    });
  }
}
