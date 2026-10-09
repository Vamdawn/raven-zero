import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import Fastify from 'fastify';
import {createMysqlStore, createServerApp, migrateMysql, ravenRoutes, TaskServer} from '@raven-zero/server';
import {serverTaskSchema} from '@raven-zero/contracts';
import {startMysql} from './mysql_fixture.js';
import {setTimeout} from 'node:timers/promises';

let mysql: Awaited<ReturnType<typeof startMysql>>;
before(async () => { mysql = await startMysql(); });
after(async () => { await mysql?.close(); });
const managementToken = 'management-secret-for-http-tests-0001';
const admin = {authorization: `Bearer ${managementToken}`};
const task = {id: 'http-report', agent: {name: 'simulated', prompt: '报告'}, initialization: [],
  checks: {before: [], after: []}, artifacts: []};

test('可嵌入 HTTP 入口区分管理和客户端身份，严格校验协议并导出 OpenAPI 3.1', async () => {
  const store = createMysqlStore({socketPath: mysql.socketPath, user: 'root', database: await mysql.database()});
  const app = Fastify();
  try {
    await store.migrate();
    app.get('/host', async () => ({host: true}));
    await app.register(ravenRoutes, {server: new TaskServer(store), managementToken, prefix: '/raven'});
    const request = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = admin) =>
      app.inject({method, url: `/raven${url}`, headers, ...(payload === undefined ? {} : {payload: JSON.stringify(payload),
        headers: {...headers, 'content-type': 'application/json'}})});
    assert.equal((await app.inject({url: '/host'})).statusCode, 200);
    assert.equal((await request('POST', '/tasks', task, {})).statusCode, 401);
    assert.equal((await request('POST', '/claim', {waitMs: 0})).statusCode, 401);
    const registration = await request('POST', '/clients', {id: 'http-client',
      capabilities: {agents: ['simulated'], deliveryComponents: [], slots: 1}});
    assert.equal(registration.statusCode, 200);
    const token = registration.json().token;
    const client = {authorization: `Bearer ${token}`};
    assert.equal((await request('POST', '/tasks', task, client)).statusCode, 401);
    assert.equal((await request('POST', '/tasks', {...task, extra: true})).statusCode, 400);
    assert.equal((await request('POST', '/tasks', {...task, agent: {...task.agent, extra: true}})).statusCode, 400);
    assert.equal((await request('POST', '/tasks', {...task, id: 'bad/id'})).statusCode, 400);
    assert.equal((await request('POST', '/claim', {waitMs: 30_001}, client)).statusCode, 400);
    assert.equal((await request('POST', '/claim', {waitMs: 0, extra: true}, client)).statusCode, 400);
    assert.equal((await request('POST', '/tasks', task)).statusCode, 200);
    assert.equal((await request('GET', '/tasks/http-report?unknown=yes')).statusCode, 400);
    const claim = await request('POST', '/claim', {waitMs: 0}, client);
    assert.equal(claim.statusCode, 200);
    const assigned = serverTaskSchema.parse(claim.json().assignment);
    assert.equal(assigned.clientId, 'http-client');
    assert.equal((await request('POST', `/runs/${assigned.runId}/progress`, {status: 'working', extra: true}, client)).statusCode, 400);
    const progress = await request('POST', `/runs/${assigned.runId}/progress`, {status: 'working'}, client);
    assert.equal(progress.statusCode, 200);
    const result = {runId: assigned.runId, taskId: task.id, version: 1, status: 'succeeded',
      output: '中文', checks: [], artifacts: []};
    assert.equal((await request('POST', '/results', result, client)).json().duplicate, false);
    assert.equal((await request('POST', '/results', result, client)).json().duplicate, true);
    assert.equal((await request('GET', '/tasks/http-report')).json().status, 'succeeded');
    const openapi = await request('GET', '/openapi.json');
    assert.equal(openapi.statusCode, 200);
    const spec = openapi.json();
    assert.equal(spec.openapi, '3.1.0');
    assert.equal(spec.paths['/raven/tasks'].post.requestBody.content['application/json'].schema.additionalProperties, false);
    assert.equal(spec.paths['/raven/tasks'].post.security[0].managementToken.length, 0);
    const waiting = request('POST', '/claim', {waitMs: 1000}, client).then(response => response);
    await setTimeout(150);
    assert.equal((await request('POST', '/tasks', {...task, id: 'long-poll'})).statusCode, 200);
    const next = serverTaskSchema.parse((await waiting).json().assignment);
    assert.equal(next.task.id, 'long-poll');
    assert.equal((await request('POST', '/tasks/long-poll/cancel', {})).json().cancellationRequested, true);
    const heartbeat = await request('POST', '/heartbeat', {agents: ['simulated'], deliveryComponents: [], slots: 0}, client);
    assert.equal(heartbeat.json().runs[0].runId, next.runId);
    assert.equal(heartbeat.json().runs[0].cancellationRequested, true);
    assert.equal((await request('POST', '/clients/http-client/revoke', {})).statusCode, 200);
    assert.equal((await request('POST', '/claim', {waitMs: 0}, client)).statusCode, 401);
    await app.close();
    // Embedded HTTP owns no storage; host can continue using its store after closing Fastify.
    assert.equal((await new TaskServer(store).get(task.id)).status, 'succeeded');
  } finally { await app.close(); await store.close(); }
});

test('独立组装拒绝未迁移数据库；HTTP 关闭及时中止长轮询并释放自有存储', async () => {
  const config = {socketPath: mysql.socketPath, user: 'root', database: await mysql.database()};
  await assert.rejects(createServerApp(config, managementToken), /migration/i);
  await migrateMysql(config);
  const app = await createServerApp(config, managementToken);
  try {
    const registration = await app.inject({method: 'POST', url: '/raven/v1/clients', headers: admin,
      payload: {id: 'shutdown-client', capabilities: {agents: ['simulated'], deliveryComponents: [], slots: 1}}});
    const waiting = app.inject({method: 'POST', url: '/raven/v1/claim',
      headers: {authorization: `Bearer ${registration.json().token}`}, payload: {waitMs: 30_000}}).then(response => response);
    await setTimeout(150);
    const startedAt = Date.now();
    await app.close();
    assert.equal((await waiting).statusCode, 200);
    assert.ok(Date.now() - startedAt < 2000, 'close must abort the 30s poll');
  } finally { await app.close(); }
});
