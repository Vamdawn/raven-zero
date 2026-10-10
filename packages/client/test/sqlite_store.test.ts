import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {SqliteClientStore} from '@raven-zero/client';
import type {ServerTask, TaskRun, TaskResult} from '@raven-zero/contracts';

test('SQLite 启动迁移、短事务保存结果和终态，关闭重开后保持同一不可变补报', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-sqlite-'));
  const path = join(root, 'client.sqlite');
  let store = new SqliteClientStore(path);
  try {
    const runId = randomUUID();
    const assignment: ServerTask = {task: {id: 'report', agent: {name: 'simulated', prompt: "中文 ' ?; DROP TABLE raven_result;"},
      initialization: [], checks: {before: [], after: []}, artifacts: []}, runId, status: 'assigned',
      clientId: 'client', cancellationRequested: false, progress: null, result: null,
      createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z'};
    const run: TaskRun = {id: runId, task: assignment.task, root: join(root, runId), workspace: join(root, runId, 'work'),
      isolation: 'simulated', version: 1, status: 'saving_result', history: ['saving_result'], startedAt: 1,
      output: {text: '结果'}, publications: [], checks: [], results: []};
    const result: TaskResult = {runId, taskId: 'report', version: 1, status: 'failed',
      output: {text: '结果'}, checks: [], artifacts: [], reason: "保留 ' 单引号"};
    store.saveAssignment(assignment);
    store.saveRun(run);
    store.saveResult(result);
    // Crash before the runner's final phase acknowledgment: the durable result
    // must already prevent re-execution or a second result of this version.
    store.close();
    store = new SqliteClientStore(path);
    assert.equal(store.get(runId)?.run?.status, 'failed');
    assert.deepEqual(store.get(runId)?.run?.results, [result]);
    assert.deepEqual(store.pendingResults(), [result]);
    const fromOtherProcess = execFileSync(process.execPath, ['--input-type=module', '-e',
      "import {SqliteClientStore} from '@raven-zero/client'; const store = new SqliteClientStore(process.argv[1]); console.log(JSON.stringify(store.pendingResults())); store.close();", path],
    {cwd: new URL('../../', import.meta.url), encoding: 'utf8'});
    assert.deepEqual(JSON.parse(fromOtherProcess), [result]);
    store.saveResult(result);
    assert.throws(() => store.saveResult({...result, output: '不同结果'}), /immutable/);
    const retained = store.get(runId)?.run;
    assert.ok(retained);
    assert.throws(() => store.saveRun({...retained, results: [{...result, output: '篡改旧版'}]}), /immutable/);
    store.acknowledge(result);
    store.close();
    store = new SqliteClientStore(path);
    assert.deepEqual(store.pendingResults(), []);
    assert.equal(store.list()[0]?.assignment.task.agent.prompt, assignment.task.agent.prompt);
    assert.throws(() => store.saveRun({...run, task: {...run.task, id: 'other'}}), /mismatch/);
  } finally { store.close(); await rm(root, {recursive: true, force: true}); }
});

test('启动拒绝缺号或超出兼容范围的编号迁移，不覆盖已有版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-future-sqlite-'));
  try {
    for (const versions of [[2], [1, 2]]) {
      const path = join(root, `migration-${versions.length}.sqlite`);
      const database = new DatabaseSync(path);
      try {
        database.exec('CREATE TABLE raven_migration(version INTEGER PRIMARY KEY) STRICT');
        for (const version of versions) database.prepare('INSERT INTO raven_migration(version) VALUES (?)').run(version);
      } finally { database.close(); }
      assert.throws(() => new SqliteClientStore(path), /Incompatible client migration/);
      assert.throws(() => new SqliteClientStore(path), /Incompatible client migration/);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
