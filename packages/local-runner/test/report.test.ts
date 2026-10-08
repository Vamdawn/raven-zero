import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalTaskRunner, NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';
import type {Command, CommandResult} from '@raven-zero/contracts';

const reportTask = {
  id: 'report', agent: {name: 'simulated', prompt: '根据 input.txt 生成报告'},
  initialization: [],
  checks: {
    before: [{kind: 'file', path: 'report.txt'}, {kind: 'command', command: {
      executable: process.execPath, args: ['-e', "if (require('node:fs').readFileSync('report.txt', 'utf8') !== '报告：输入') process.exit(1)"], timeoutMs: 2_000,
    }}], after: [],
  }, artifacts: ['report.txt'],
};

test('通过 ESM 公开入口初始化报告任务、检查并保存结构化结果和本版文件产物', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-report-'));
  try {
    const input = join(root, 'input.txt');
    await writeFile(input, '输入');
    const agent = new SimulatedAgent(async ({session}) => {
      const text = await readFile(join(session.workspace, 'input.txt'), 'utf8');
      await writeFile(join(session.workspace, 'report.txt'), `报告：${text}`);
      return {status: 'completion_candidate', output: {summary: '已生成报告'}};
    });
    const runner = await LocalTaskRunner.create({...reportTask,
      initialization: [{kind: 'file', source: input, destination: 'input.txt'}]}, {
      root: join(root, 'runs'), files: new NodeFileExecution(), agent,
      delivery: {name: 'git-branch', async deliver() { throw new Error('未选择 Git，禁止调用'); }},
    });
    const run = await runner.execute();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.isolation, 'simulated');
    assert.notEqual(run.workspace, root);
    const result = run.results[0];
    assert.ok(result);
    assert.deepEqual(result.output, {summary: '已生成报告'});
    const artifact = result.artifacts[0];
    assert.ok(artifact);
    assert.equal(await readFile(artifact.file, 'utf8'), '报告：输入');
    assert.equal(artifact.version, 1);
    assert.deepEqual(JSON.parse(await readFile(join(run.root, 'results', 'v1.json'), 'utf8')), result);
    assert.deepEqual(JSON.parse(await readFile(join(run.root, 'run.json'), 'utf8')), run);
    assert.deepEqual(run.history, ['created', 'initializing', 'working', 'completion_candidate',
      'stop_requested', 'stop_confirmed', 'publishing', 'published', 'checking_before',
      'delivering', 'checking_after', 'saving_result', 'succeeded']);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('初始化与交付后命令在各自工作区执行，交付证据保存在本版结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-command-'));
  try {
    const runner = await LocalTaskRunner.create({...reportTask,
      initialization: [{kind: 'command', command: {executable: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('input.txt', '命令输入')"], timeoutMs: 2_000}}],
      delivery: {component: 'fixture', parameters: {destination: '报告库'}},
      checks: {before: [{kind: 'file', path: 'report.txt'}], after: [{kind: 'command', command: {
        executable: process.execPath, args: ['-e', "if (require('node:fs').readFileSync('report.txt', 'utf8') !== '命令输入') process.exit(3)"], timeoutMs: 2_000,
      }}]},
    }, {root, files: new NodeFileExecution(), agent: new SimulatedAgent(async ({session}) => {
      await writeFile(join(session.workspace, 'report.txt'), await readFile(join(session.workspace, 'input.txt')));
      return {status: 'completion_candidate', output: {summary: '命令输入'}};
    }), delivery: {name: 'fixture', async deliver(publication, parameters) {
      assert.equal(await readFile(join(publication.directory, 'report.txt'), 'utf8'), '命令输入');
      assert.equal(parameters.destination, '报告库');
      return {destination: '报告库', receipt: '模拟交付'};
    }}});
    const result = await runner.execute();
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.results[0]?.delivery, {destination: '报告库', receipt: '模拟交付'});
    assert.deepEqual(result.results[0]?.checks.map(check => [check.stage, check.passed]), [['before', true], ['after', true]]);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('检查期间执行期限到达会停止活动命令，并以超期结果结束', async context => {
  context.mock.timers.enable({apis: ['Date', 'setTimeout'], now: 1_000_000});
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  class NotifyingFiles extends NodeFileExecution {
    override async command(command: Command, workspace: string, signal: AbortSignal): Promise<CommandResult> {
      const executing = super.command(command, workspace, signal);
      notifyStarted?.();
      return executing;
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'raven-check-expire-'));
  try {
    const runner = await LocalTaskRunner.create({...reportTask, timeoutMs: 250,
      checks: {before: [{kind: 'command', command: {executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 20_000}}], after: []}}, {
      root, files: new NotifyingFiles(), agent: new SimulatedAgent(async ({session}) => {
        await writeFile(join(session.workspace, 'report.txt'), '报告：输入');
        return {status: 'completion_candidate', output: null};
      }),
    });
    while (runner.snapshot().status !== 'checking_before') await runner.advance();
    const checking = runner.advance();
    await started;
    context.mock.timers.tick(250);
    await checking;
    const result = await runner.execute();
    assert.equal(result.status, 'expired');
    assert.equal(result.results[0]?.checks[0]?.command?.status, 'cancelled');
    assert.equal(result.results[0]?.artifacts.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('取消请求与停止确认分别保存，取消不发布成果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-cancel-'));
  try {
    const runner = await LocalTaskRunner.create(reportTask, {root, files: new NodeFileExecution(),
      agent: new SimulatedAgent(async () => ({status: 'waiting_for_input', reason: '等待回答'}))});
    await runner.execute();
    assert.equal((await runner.cancel()).status, 'stop_requested');
    assert.equal((await runner.advance()).status, 'stop_confirmed');
    const result = await runner.execute();
    assert.equal(result.status, 'cancelled');
    assert.equal(result.publications.length, 0);
    assert.equal(result.results[0]?.status, 'cancelled');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('问答等待计入期限，超期后先确认停止再保存结果', async context => {
  context.mock.timers.enable({apis: ['Date'], now: 1_000_000});
  const root = await mkdtemp(join(tmpdir(), 'raven-expire-'));
  try {
    const runner = await LocalTaskRunner.create({...reportTask, timeoutMs: 200}, {root,
      files: new NodeFileExecution(), agent: new SimulatedAgent(async () => ({status: 'waiting_for_input', reason: '等待回答'}))});
    const waiting = await runner.execute();
    assert.equal(waiting.status, 'waiting_for_input');
    assert.ok(waiting.deadlineAt);
    context.mock.timers.setTime(waiting.deadlineAt + 1);
    assert.equal((await runner.advance()).status, 'stop_requested');
    const result = await runner.execute();
    assert.equal(result.status, 'expired');
    assert.equal(result.publications.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('问答等待不发布成果，显式回答后原会话继续；源工作区晚到变化不影响本版成果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-wait-'));
  try {
    let answered = false;
    const runner = await LocalTaskRunner.create(reportTask, {root, files: new NodeFileExecution(),
      agent: new SimulatedAgent(async ({session}) => {
        if (!answered) return {status: 'waiting_for_input', reason: '需要确认报告内容'};
        await writeFile(join(session.workspace, 'report.txt'), '报告：输入');
        return {status: 'completion_candidate', output: {summary: '用户已确认'}};
      }),
    });
    const waiting = await runner.execute();
    assert.equal(waiting.status, 'waiting_for_input');
    assert.equal(waiting.publications.length, 0);
    const session = waiting.session;
    answered = true;
    while (runner.snapshot().status !== 'published') await runner.advance();
    const published = runner.snapshot();
    await writeFile(join(published.workspace, 'report.txt'), '晚到变化');
    // Mutating returned records must not change the execution state.
    published.status = 'succeeded'; published.publications.length = 0;
    const result = await runner.execute();
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.session, session);
    const artifact = result.results[0]?.artifacts[0];
    assert.ok(artifact);
    assert.equal(await readFile(artifact.file, 'utf8'), '报告：输入');
    await assert.rejects(runner.advance(), /Cannot advance succeeded/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('显式恢复核对原身份与成果后发布下一版，旧版结果和文件保持不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-resume-'));
  try {
    const runner = await LocalTaskRunner.create({...reportTask,
      checks: {before: [{kind: 'file', path: 'report.txt'}], after: []}}, {
      root, files: new NodeFileExecution(), agent: new SimulatedAgent(async ({session, version}) => {
        await writeFile(join(session.workspace, 'report.txt'), `报告第${version}版`);
        return {status: 'completion_candidate', output: {version}};
      }),
    });
    await assert.rejects(runner.resume(), /Cannot resume created/);
    const first = await runner.execute();
    const firstResult = first.results[0];
    assert.ok(firstResult);
    const saved = await readFile(join(first.root, 'results', 'v1.json'), 'utf8');
    await runner.resume();
    const second = await runner.execute();
    assert.equal(second.status, 'succeeded');
    assert.equal(second.version, 2);
    assert.deepEqual(second.session, first.session);
    assert.equal(second.workspace, first.workspace);
    assert.deepEqual(second.results[0], firstResult);
    assert.equal(await readFile(join(first.root, 'results', 'v1.json'), 'utf8'), saved);
    const oldArtifact = firstResult.artifacts[0];
    const newArtifact = second.results[1]?.artifacts[0];
    assert.ok(oldArtifact); assert.ok(newArtifact);
    assert.equal(await readFile(oldArtifact.file, 'utf8'), '报告第1版');
    assert.equal(await readFile(newArtifact.file, 'utf8'), '报告第2版');
    assert.equal(second.results[1]?.checks.length, 1);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('取消正在执行的模拟 Agent 后，尚在运行的工作保持待核对', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-active-'));
  let release: (() => void) | undefined;
  const finished = new Promise<void>(resolve => { release = resolve; });
  try {
    const runner = await LocalTaskRunner.create(reportTask, {root, files: new NodeFileExecution(),
      agent: new SimulatedAgent(async () => {
        await finished;
        return {status: 'completion_candidate', output: null};
      })});
    await runner.advance(); await runner.advance();
    const observing = runner.advance();
    const cancelling = runner.cancel();
    // Cancellation must return without pretending the uncooperative fixture stopped.
    const requested = await cancelling;
    await observing;
    assert.equal(requested.status, 'stop_requested');
    const unconfirmed = await runner.advance();
    assert.equal(unconfirmed.status, 'pending_verification');
    assert.equal(unconfirmed.publications.length, 0);
  } finally {
    release?.(); await finished;
    await rm(root, {recursive: true, force: true});
  }
});

test('自动执行期间取消会中断工作并完成停止核对，不与阶段推进竞争', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-execute-cancel-'));
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  try {
    const runner = await LocalTaskRunner.create(reportTask, {root, files: new NodeFileExecution(),
      agent: new SimulatedAgent(async ({signal}) => {
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), {once: true});
          notifyStarted?.();
        });
        return {status: 'completion_candidate', output: null};
      })});
    const execution = runner.execute();
    await started;
    const [executed, cancelled] = await Promise.all([execution, runner.cancel()]);
    assert.equal(executed.status, 'cancelled');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.publications.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});
