import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm, symlink, rename, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LocalTaskRunner, NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';
import type {AgentAdapter} from '@raven-zero/local-runner';
import type {AgentSession, Publication, TaskResult} from '@raven-zero/contracts';

const task = {id: 'report', agent: {name: 'simulated', prompt: '生成报告'}, initialization: [],
  checks: {before: [{kind: 'file', path: 'report.txt'}], after: []}, artifacts: ['report.txt']};

function reportAgent(): SimulatedAgent {
  return new SimulatedAgent(async ({session}) => {
    await writeFile(join(session.workspace, 'report.txt'), '报告');
    return {status: 'completion_candidate', output: {summary: '报告'}};
  });
}

test('检查失败保存命令证据且不自动修复，交付前失败阻止所选交付组件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-check-failure-'));
  try {
    let delivered = false;
    const runner = await LocalTaskRunner.create({...task,
      delivery: {component: 'fixture', parameters: {}},
      checks: {before: [{kind: 'command', command: {executable: process.execPath,
        args: ['-e', "console.error('格式不符'); process.exit(7)"], timeoutMs: 2_000}}], after: []},
    }, {root, files: new NodeFileExecution(), agent: reportAgent(),
      delivery: {name: 'fixture', async deliver() { delivered = true; return {receipt: 'delivered'}; }}});
    const failed = await runner.execute();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.results[0]?.checks[0]?.command?.exitCode, 7);
    assert.equal(failed.results[0]?.checks[0]?.command?.stderr, '格式不符\n');
    assert.equal(delivered, false);
    assert.deepEqual(await runner.execute(), failed);
    assert.equal(failed.version, 1);
    assert.equal(failed.results.length, 1);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('停止未知、边界未知和发布不完整时不检查、不交付', async () => {
  class UnconfirmedAgent extends SimulatedAgent {
    override async confirmStop(_session: AgentSession): Promise<boolean> { return false; }
  }
  class IncompleteFiles extends NodeFileExecution {
    override async verify(_publication: Publication): Promise<boolean> { return false; }
  }
  const root = await mkdtemp(join(tmpdir(), 'raven-pending-'));
  try {
    const agents: AgentAdapter[] = [new UnconfirmedAgent(async () => ({status: 'completion_candidate', output: null})), reportAgent(),
      {name: 'simulated', isolation: 'pending_verification',
        start: async () => { throw new Error('Unverified boundary must not start Agent'); },
        observe: async () => { throw new Error('Must not observe'); },
        requestStop: async () => {}, confirmStop: async () => false, verify: async () => false, resume: async () => {}}];
    for (const [index, agent] of agents.entries()) {
      const runner = await LocalTaskRunner.create({...task, delivery: {component: 'fixture', parameters: {}}}, {
        root, agent, files: index === 1 ? new IncompleteFiles() : new NodeFileExecution(),
        delivery: {name: 'fixture', async deliver() { throw new Error('Must not deliver'); }},
      });
      const result = await runner.execute();
      assert.equal(result.status, 'pending_verification');
      assert.equal(result.checks.length, 0);
      assert.equal(result.results.length, 0);
      assert.equal(result.publications.length, 0);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('已发布内容被篡改后禁止交付和恢复，不覆盖旧结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-tamper-'));
  try {
    const runner = await LocalTaskRunner.create(task, {root, files: new NodeFileExecution(), agent: reportAgent()});
    const completed = await runner.execute();
    const artifact = completed.results[0]?.artifacts[0];
    assert.ok(artifact);
    const saved = await readFile(join(completed.root, 'results', 'v1.json'), 'utf8');
    await writeFile(artifact.file, '篡改');
    const pending = await runner.resume();
    assert.equal(pending.status, 'pending_verification');
    assert.equal(pending.version, 1);
    assert.deepEqual(pending.results, completed.results);
    assert.equal(await readFile(join(completed.root, 'results', 'v1.json'), 'utf8'), saved);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('模拟发布拒绝把链接导回任务工作区或外部文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-links-'));
  try {
    const runner = await LocalTaskRunner.create(task, {root, files: new NodeFileExecution(),
      agent: new SimulatedAgent(async ({session}) => {
        await symlink(join(root, 'outside.txt'), join(session.workspace, 'report.txt'));
        return {status: 'completion_candidate', output: null};
      })});
    await writeFile(join(root, 'outside.txt'), '外部文件');
    const result = await runner.execute();
    assert.equal(result.status, 'pending_verification');
    assert.equal(result.publications.length, 0);
    assert.equal(result.checks.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('初始化命令失败保存失败结果，未启动 Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-init-failure-'));
  try {
    const runner = await LocalTaskRunner.create({...task, initialization: [{kind: 'command', command: {
      executable: process.execPath, args: ['-e', "console.error('输入准备失败'); process.exit(2)"], timeoutMs: 2_000,
    }}]}, {root, files: new NodeFileExecution(), agent: reportAgent()});
    const failed = await runner.execute();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.session, undefined);
    assert.match(failed.results[0]?.reason ?? '', /输入准备失败/);
    assert.equal(failed.publications.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('任务声明的文件产物缺失时保存失败结果', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-missing-artifact-'));
  try {
    const runner = await LocalTaskRunner.create({...task, artifacts: ['missing.txt']}, {
      root, files: new NodeFileExecution(), agent: reportAgent()});
    const failed = await runner.execute();
    assert.equal(failed.status, 'failed');
    assert.match(failed.results[0]?.reason ?? '', /Missing file artifact: missing.txt/);
    assert.equal(failed.results[0]?.artifacts.length, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('原工作区被替换时不恢复到相同路径的新目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-workspace-identity-'));
  try {
    const runner = await LocalTaskRunner.create(task, {root, files: new NodeFileExecution(), agent: reportAgent()});
    const completed = await runner.execute();
    await rename(completed.workspace, `${completed.workspace}.retained`);
    await mkdir(completed.workspace);
    const pending = await runner.resume();
    assert.equal(pending.status, 'pending_verification');
    assert.equal(pending.version, 1);
    assert.deepEqual(pending.session, completed.session);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('检查命令退出但后台进程组仍在运行时保留证据且禁止恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-command-scope-'));
  const pidFile = join(root, 'child-pid');
  try {
    const code = `const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      console.log(child.pid); child.unref();`;
    const runner = await LocalTaskRunner.create({...task, checks: {before: [{kind: 'command', command: {
      executable: process.execPath, args: ['-e', code], timeoutMs: 5_000,
    }}], after: []}}, {root, files: new NodeFileExecution(), agent: reportAgent()});
    const pending = await runner.execute();
    assert.equal(pending.status, 'pending_verification');
    assert.equal(pending.checks[0]?.command?.status, 'pending_verification');
    assert.match(pending.checks[0]?.command?.stderr ?? '', /remains active/);
    assert.equal(pending.results.length, 0);
    assert.equal((await runner.resume()).version, 1);
    assert.equal(runner.snapshot().status, 'pending_verification');
  } finally {
    // The fixture owns this exact PID; stop and confirm it before removing files.
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    process.kill(pid, 'SIGKILL');
    let stopped = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
        stopped = true; break;
      }
      await delay(10);
    }
    assert.equal(stopped, true, 'Fixture child did not stop');
    await rm(root, {recursive: true, force: true});
  }
});

test('取消结果保存失败时保留待核对，不反复请求停止与保存', async () => {
  class ResultWriteFailure extends NodeFileExecution {
    override async saveResult(_root: string, _result: TaskResult): Promise<void> { throw new Error('结果存储不可用'); }
  }
  const root = await mkdtemp(join(tmpdir(), 'raven-save-failure-'));
  try {
    const runner = await LocalTaskRunner.create(task, {root, files: new ResultWriteFailure(),
      agent: new SimulatedAgent(async () => ({status: 'waiting_for_input', reason: '等待回答'}))});
    await runner.execute(); await runner.cancel();
    await runner.advance(); await runner.advance();
    assert.equal(runner.snapshot().status, 'saving_result');
    const pending = await runner.advance();
    assert.equal(pending.status, 'pending_verification');
    assert.match(pending.reason ?? '', /结果存储不可用/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('交付组件返回非法 JSON 时仍可读取并保存待核对状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raven-delivery-json-'));
  try {
    const runner = await LocalTaskRunner.create({...task, delivery: {component: 'fixture', parameters: {}}}, {
      root, files: new NodeFileExecution(), agent: reportAgent(),
      delivery: {name: 'fixture', async deliver() { return 1n; }},
    });
    const pending = await runner.execute();
    assert.equal(pending.status, 'pending_verification');
    assert.equal(pending.delivery, undefined);
    assert.deepEqual(runner.snapshot(), pending);
    assert.deepEqual(JSON.parse(await readFile(join(pending.root, 'run.json'), 'utf8')), pending);
  } finally { await rm(root, {recursive: true, force: true}); }
});
