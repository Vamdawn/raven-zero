import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalTaskRunner, NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';
import type {PublicationRequest} from '@raven-zero/local-runner';
import type {Publication, TaskRun} from '@raven-zero/contracts';
import {taskRunSchema} from '@raven-zero/contracts';

const task = {id: 'report', agent: {name: 'simulated', prompt: '报告'}, initialization: [],
  checks: {before: [{kind: 'file', path: 'report.txt'}], after: []}, artifacts: ['report.txt']};

test('外部执行身份必须是 UUID，在准备目录之前拒绝路径注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-invalid-run-id-'));
  try {
    await assert.rejects(LocalTaskRunner.create(task, {root, runId: '../other', files: new NodeFileExecution(),
      agent: new SimulatedAgent(async () => ({status: 'working'}))}));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, {recursive: true, force: true}); }
});

for (const stage of ['partial', 'published'] as const) {
  test(`显式恢复发布 ${stage} 中断：核对真实文件，同版成果不重跑 Agent`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'raven-publication-recovery-'));
    class InterruptedFiles extends NodeFileExecution {
      interrupted = false;
      override async publish(request: PublicationRequest): Promise<Publication> {
        if (stage === 'partial') {
          await mkdir(join(request.root, 'delivery', `v${request.version}.fixture.partial`));
          await writeFile(join(request.root, 'delivery', `v${request.version}.fixture.partial`, 'report.txt'), '未完成副本');
        } else await super.publish(request);
        this.interrupted = true;
        throw new Error('模拟发布进程中断');
      }
      override async saveRun(run: TaskRun): Promise<void> {
        if (this.interrupted) throw new Error('模拟记录写入中断');
        await super.saveRun(run);
      }
    }
    try {
      let observations = 0;
      const files = new InterruptedFiles();
      const agent = new SimulatedAgent(async ({session}) => {
        observations++;
        await writeFile(join(session.workspace, 'report.txt'), '发布报告');
        return {status: 'completion_candidate', output: {summary: '原版报告'}};
      });
      const runner = await LocalTaskRunner.create(task, {root, files, agent});
      await assert.rejects(runner.execute(), /记录写入中断/);
      const retained = taskRunSchema.parse(JSON.parse(await readFile(join(runner.snapshot().root, 'run.json'), 'utf8')));
      assert.equal(retained.status, 'publishing');
      assert.equal(files.interrupted, true);
      files.interrupted = false;
      const recovered = await LocalTaskRunner.restore(retained, {root, files, agent});
      await recovered.recover();
      const run = await recovered.execute();
      assert.equal(run.status, stage === 'published' ? 'succeeded' : 'pending_verification', run.reason);
      assert.equal(observations, 1);
      assert.equal(run.version, 1);
      assert.deepEqual(run.session, retained.session);
      if (stage === 'published') {
        assert.equal(await readFile(run.results[0]?.artifacts[0]?.file ?? '', 'utf8'), '发布报告');
      } else {
        assert.equal(run.checks.length, 0);
        assert.equal(run.results.length, 0);
      }
    } finally { await rm(root, {recursive: true, force: true}); }
  });
}

test('原会话归属丢失或发布版本被篡改时，显式恢复保存待核对且不进入检查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-unknown-recovery-'));
  try {
    const files = new NodeFileExecution();
    const agent = new SimulatedAgent(async ({session}) => {
      await writeFile(join(session.workspace, 'report.txt'), '原版');
      return {status: 'completion_candidate', output: '原输出'};
    });
    const runner = await LocalTaskRunner.create(task, {root, files, agent});
    while (runner.snapshot().status !== 'published') await runner.advance();
    const retained = runner.snapshot();
    const foreign = await LocalTaskRunner.restore(retained, {root, files,
      agent: new SimulatedAgent(async () => { throw new Error('不能替换原会话'); })});
    const unknown = await foreign.recover();
    assert.equal(unknown.status, 'pending_verification');
    assert.deepEqual(unknown.session, retained.session);
    assert.equal(unknown.checks.length, 0);
    await writeFile(join(retained.publications[0]?.directory ?? '', 'report.txt'), '篡改');
    const changed = await LocalTaskRunner.restore(retained, {root, files, agent});
    const pending = await changed.recover();
    assert.equal(pending.status, 'pending_verification');
    assert.equal(pending.version, 1);
    assert.equal(pending.results.length, 0);
    assert.equal(pending.checks.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});
