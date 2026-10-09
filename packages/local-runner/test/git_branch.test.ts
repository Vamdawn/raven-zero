import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, lstat, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitBranchDelivery, LocalTaskRunner, NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';
import {taskRunSchema} from '@raven-zero/contracts';
import type {Command, CommandResult, TaskRun} from '@raven-zero/contracts';

const git = '/Library/Developer/CommandLineTools/usr/bin/git';
function command(cwd: string, args: string[]): string {
  return execFileSync(git, ['-c', 'user.name=Raven Test', '-c', 'user.email=raven@example.test',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'raven-git-'));
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  await mkdir(source);
  command(source, ['init', '--initial-branch=main', '--template=']);
  await writeFile(join(source, 'code.txt'), '初始代码');
  command(source, ['add', 'code.txt']);
  command(source, ['commit', '-m', 'base']);
  command(root, ['init', '--bare', '--template=', remote]);
  command(source, ['push', remote, 'main']);
  const base = command(source, ['rev-parse', 'HEAD']);
  const files = new NodeFileExecution();
  const parameters = {remote, baseRef: 'refs/heads/main'};
  const task = {id: 'code', agent: {name: 'simulated', prompt: '修改代码'}, initialization: [],
    delivery: {component: 'git-branch', parameters},
    checks: {before: [{kind: 'file', path: 'code.txt'}], after: []}, artifacts: ['code.txt']};
  return {root, source, remote, base, files, task};
}

test('公开本地入口从远端初始化代码任务，交付本版内容与稳定分支提交证据', async () => {
  const f = await fixture();
  try {
    const delivery = new GitBranchDelivery(f.files);
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files: f.files,
      delivery, agent: new SimulatedAgent(async ({session}) => {
        assert.equal(await readFile(join(session.workspace, 'code.txt'), 'utf8'), '初始代码');
        await writeFile(join(session.workspace, 'code.txt'), '交付代码');
        return {status: 'completion_candidate', output: null};
      })});
    while (runner.snapshot().status !== 'published') await runner.advance();
    await writeFile(join(runner.snapshot().workspace, 'code.txt'), '源工作区晚到写入');
    const run = await runner.execute();
    assert.equal(run.status, 'succeeded', run.reason);
    const evidence = run.results[0]?.delivery;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
    assert.equal(evidence.remote, f.remote);
    assert.equal(evidence.branch, `raven/${run.id}`);
    assert.equal(evidence.status, 'pushed');
    assert.equal(typeof evidence.commit, 'string');
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/${evidence.branch}`]), evidence.commit);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `${evidence.commit}:code.txt`]), '交付代码');
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-list', '--count', String(evidence.commit)]), '2');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('旧版提交后推送失败，新版可正常快进，不误报自己的远端祖先为冲突', async () => {
  const f = await fixture();
  class FailedSecondPushFiles extends NodeFileExecution {
    pushes = 0;
    override async command(input: Command, workspace: string, signal: AbortSignal,
      environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
      if (input.args.includes('push') && ++this.pushes === 2) {
        return {status: 'exited', exitCode: 1, stdout: '', stderr: '模拟本版推送失败'};
      }
      return super.command(input, workspace, signal, environment);
    }
  }
  try {
    const files = new FailedSecondPushFiles();
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files,
      delivery: new GitBranchDelivery(files), agent: new SimulatedAgent(async ({session, version}) => {
        await writeFile(join(session.workspace, 'code.txt'), `第${version}版`);
        return {status: 'completion_candidate', output: null};
      })});
    assert.equal((await runner.execute()).status, 'succeeded');
    await runner.resume();
    assert.equal((await runner.execute()).status, 'failed');
    await runner.resume();
    const third = await runner.execute();
    assert.equal(third.status, 'succeeded', third.reason);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `refs/heads/raven/${third.id}:code.txt`]), '第3版');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('推送成功后的阶段记录保存失败仍可恢复同版，不重跑 Agent 或生成提交', async () => {
  const f = await fixture();
  class FailedTransitionFiles extends NodeFileExecution {
    lost = false;
    override async saveRun(run: TaskRun): Promise<void> {
      if (run.status === 'checking_after' && !this.lost) {
        this.lost = true;
        throw new Error('模拟推送后阶段记录保存失败');
      }
      await super.saveRun(run);
    }
  }
  try {
    const files = new FailedTransitionFiles();
    let observations = 0;
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files,
      delivery: new GitBranchDelivery(files), agent: new SimulatedAgent(async ({session}) => {
        observations++;
        await writeFile(join(session.workspace, 'code.txt'), '阶段恢复');
        return {status: 'completion_candidate', output: null};
      })});
    const pending = await runner.execute();
    assert.equal(pending.status, 'pending_verification');
    const commit = command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${pending.id}`]);
    await runner.recoverDelivery();
    const recovered = await runner.execute();
    assert.equal(recovered.status, 'succeeded', recovered.reason);
    assert.equal(recovered.version, 1);
    assert.equal(observations, 1);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${pending.id}`]), commit);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

// Interrupt the storage/command boundary without allowing the catch path to
// replace the last durable record. Restoration must use those retained bytes.
for (const effect of ['commit', 'checkpoint', 'push', 'transition'] as const) {
  for (const timing of ['before', 'after'] as const) {
    test(`恢复故障矩阵：${effect} ${timing} 中断后从磁盘恢复同版，再继续下一版`, async () => {
      const f = await fixture();
      class InterruptedFiles extends NodeFileExecution {
        stopped = false;
        armed = true;
        commits = 0;
        pushes = 0;
        interrupt(): never {
          this.stopped = true;
          throw new Error('模拟执行器中断');
        }
        override async command(input: Command, workspace: string, signal: AbortSignal,
          environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
          const target = input.args.includes(effect) && (effect === 'commit' || effect === 'push');
          if (this.armed && target && timing === 'before') this.interrupt();
          const result = await super.command(input, workspace, signal, environment);
          if (result.status === 'exited' && result.exitCode === 0) {
            if (input.args.includes('commit')) this.commits++;
            if (input.args.includes('push')) this.pushes++;
          }
          if (this.armed && target && timing === 'after') this.interrupt();
          return result;
        }
        override async saveRun(run: TaskRun): Promise<void> {
          if (this.stopped) throw new Error('模拟记录存储不可用');
          const target = effect === 'transition' ? run.status === 'checking_after' :
            effect === 'checkpoint' && run.status === 'delivering' && run.delivery !== undefined;
          if (this.armed && target && timing === 'before') this.interrupt();
          await super.saveRun(run);
          if (this.armed && target && timing === 'after') this.interrupt();
        }
      }
      try {
        const files = new InterruptedFiles();
        let observations = 0;
        const agent = new SimulatedAgent(async ({session, version}) => {
          observations++;
          await writeFile(join(session.workspace, 'code.txt'), `第${version}版`);
          return {status: 'completion_candidate', output: null};
        });
        const root = join(f.root, 'runs');
        const runner = await LocalTaskRunner.create({...f.task,
          checks: {...f.task.checks, after: [{kind: 'file', path: 'code.txt'}]}},
        {root, files, delivery: new GitBranchDelivery(files), agent});
        await assert.rejects(runner.execute(), /记录存储不可用/);
        assert.equal(files.stopped, true);
        const interrupted = runner.snapshot();
        const metadata = join(interrupted.root, 'git');
        const branch = `refs/heads/raven/${interrupted.id}`;
        const retained = taskRunSchema.parse(JSON.parse(await readFile(join(interrupted.root, 'run.json'), 'utf8')));
        assert.equal(retained.status, effect === 'transition' && timing === 'after' ? 'checking_after' : 'delivering');
        assert.equal(retained.version, 1);
        const originalCommit = command(f.root, ['--git-dir', metadata, 'rev-parse', 'refs/raven/versions/1']);
        const originalRemote = command(f.root, ['--git-dir', f.remote, 'for-each-ref', '--format=%(objectname)', branch]);
        assert.equal(originalRemote !== '', files.pushes === 1);
        const committed = files.commits === 1;
        const pushed = files.pushes === 1;
        // Ownership is still held by the simulated adapters. Only the Runner
        // and delivery component are recreated from the last durable record.
        files.armed = false;
        files.stopped = false;
        const restored = await LocalTaskRunner.restoreDelivery(retained,
          {root, files, delivery: new GitBranchDelivery(files), agent});
        const recovered = await restored.execute();
        assert.equal(recovered.status, 'succeeded', recovered.reason);
        assert.equal(recovered.version, 1);
        assert.equal(observations, 1);
        assert.deepEqual(recovered.session, interrupted.session);
        assert.deepEqual(recovered.publications, interrupted.publications);
        assert.equal(recovered.checks.filter(check => check.stage === 'after').length, 1);
        assert.equal(files.commits, 1);
        assert.equal(files.pushes, 1);
        const commit = command(f.root, ['--git-dir', f.remote, 'rev-parse', branch]);
        if (committed) assert.equal(commit, originalCommit);
        if (pushed) assert.equal(commit, originalRemote);
        assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-list', '--count', commit]), '2');
        assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `${commit}:code.txt`]), '第1版');
        const savedResult = await readFile(join(recovered.root, 'results', 'v1.json'), 'utf8');
        await restored.resume();
        const second = await restored.execute();
        assert.equal(second.status, 'succeeded', second.reason);
        assert.equal(second.version, 2);
        assert.equal(observations, 2);
        assert.equal(files.commits, 2);
        assert.equal(files.pushes, 2);
        assert.deepEqual(second.session, interrupted.session);
        assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `${branch}^`]), commit);
        assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `${commit}:code.txt`]), '第1版');
        assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `${branch}:code.txt`]), '第2版');
        assert.equal(await readFile(join(second.root, 'results', 'v1.json'), 'utf8'), savedResult);
      } finally { await rm(f.root, {recursive: true, force: true}); }
    });
  }
}

test('已记录提交身份丢失时保留待核对，不重新生成提交或推送', async () => {
  const f = await fixture();
  class InterruptedPushFiles extends NodeFileExecution {
    blocked = false;
    override async command(input: Command, workspace: string, signal: AbortSignal,
      environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
      if (input.args.includes('push') && !this.blocked) {
        this.blocked = true;
        return {status: 'pending_verification', exitCode: null, stdout: '', stderr: '模拟推送中断'};
      }
      return super.command(input, workspace, signal, environment);
    }
  }
  try {
    const files = new InterruptedPushFiles();
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files,
      delivery: new GitBranchDelivery(files), agent: new SimulatedAgent(async ({session}) => {
        await writeFile(join(session.workspace, 'code.txt'), '提交身份待核对');
        return {status: 'completion_candidate', output: null};
      })});
    const pending = await runner.execute();
    assert.equal(pending.status, 'pending_verification');
    assert.ok(pending.delivery);
    command(f.root, ['--git-dir', join(pending.root, 'git'), 'update-ref', 'refs/raven/versions/1', f.base]);
    await runner.recoverDelivery();
    const recovered = await runner.execute();
    assert.equal(recovered.status, 'pending_verification');
    assert.match(recovered.reason ?? '', /Recorded commit/);
    assert.equal(command(f.root, ['--git-dir', join(pending.root, 'git'), 'rev-parse', 'refs/raven/versions/1']), f.base);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/raven/${pending.id}`]), '');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('交付前检查失败不推送，交付后检查失败仍保存已推送证据', async () => {
  const f = await fixture();
  try {
    for (const stage of ['before', 'after'] as const) {
      const runner = await LocalTaskRunner.create({...f.task,
        checks: {before: [], after: [], [stage]: [{kind: 'file', path: 'missing.txt'}]}}, {
        root: join(f.root, 'runs'), files: f.files, delivery: new GitBranchDelivery(f.files),
        agent: new SimulatedAgent(async ({session}) => {
          await writeFile(join(session.workspace, 'code.txt'), '检查失败成果');
          return {status: 'completion_candidate', output: null};
        })});
      const run = await runner.execute();
      assert.equal(run.status, 'failed', run.reason);
      assert.equal(run.results[0]?.checks[0]?.stage, stage);
      const remoteRef = command(f.root, ['--git-dir', f.remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/raven/${run.id}`]);
      if (stage === 'before') {
        assert.equal(remoteRef, '');
        assert.equal(run.delivery, undefined);
      } else {
        const evidence = run.results[0]?.delivery;
        assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
        assert.equal(evidence.commit, remoteRef);
        assert.equal(evidence.status, 'pushed');
      }
    }
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('无改动报告 noChanges，使用基准提交且不制造空提交', async () => {
  const f = await fixture();
  try {
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files: f.files,
      delivery: new GitBranchDelivery(f.files), agent: new SimulatedAgent(async () => ({status: 'completion_candidate', output: null}))});
    const run = await runner.execute();
    assert.equal(run.status, 'succeeded', run.reason);
    const evidence = run.results[0]?.delivery;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
    assert.equal(evidence.noChanges, true);
    assert.equal(evidence.commit, f.base);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-list', '--count', `refs/heads/raven/${run.id}`]), '1');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('远端分支冲突保存失败证据，不强推覆盖远端', async () => {
  const f = await fixture();
  try {
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files: f.files,
      delivery: new GitBranchDelivery(f.files), agent: new SimulatedAgent(async ({session}) => {
        await writeFile(join(session.workspace, 'code.txt'), '任务成果');
        return {status: 'completion_candidate', output: null};
      })});
    while (runner.snapshot().status !== 'delivering') await runner.advance();
    await writeFile(join(f.source, 'code.txt'), '外部成果');
    command(f.source, ['commit', '-am', 'external']);
    const external = command(f.source, ['rev-parse', 'HEAD']);
    command(f.source, ['push', f.remote, `HEAD:refs/heads/raven/${runner.snapshot().id}`]);
    const run = await runner.execute();
    assert.equal(run.status, 'failed', run.reason);
    const evidence = run.results[0]?.delivery;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
    assert.equal(evidence.status, 'conflict');
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${run.id}`]), external);
    assert.notEqual(evidence.commit, external);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('显式继续发布新版本必须重新检查，旧版本提交和成果保持不变', async () => {
  const f = await fixture();
  try {
    const runner = await LocalTaskRunner.create({...f.task,
      checks: {before: [{kind: 'file', path: 'approval.txt'}], after: []}}, {
      root: join(f.root, 'runs'), files: f.files, delivery: new GitBranchDelivery(f.files),
      agent: new SimulatedAgent(async ({session, version}) => {
        await writeFile(join(session.workspace, 'code.txt'), `第${version}版`);
        if (version === 2) await rm(join(session.workspace, 'approval.txt'));
        else await writeFile(join(session.workspace, 'approval.txt'), '通过');
        return {status: 'completion_candidate', output: {version}};
      })});
    const first = await runner.execute();
    assert.equal(first.status, 'succeeded', first.reason);
    const firstCommit = command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${first.id}`]);
    const saved = await readFile(join(first.root, 'results', 'v1.json'), 'utf8');
    await runner.resume();
    const second = await runner.execute();
    assert.equal(second.status, 'failed', second.reason);
    assert.equal(second.results[1]?.checks[0]?.passed, false);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${first.id}`]), firstCommit);
    assert.equal(await readFile(join(first.root, 'results', 'v1.json'), 'utf8'), saved);
    await runner.resume();
    const third = await runner.execute();
    assert.equal(third.status, 'succeeded', third.reason);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `${firstCommit}:code.txt`]), '第1版');
    assert.equal(command(f.root, ['--git-dir', f.remote, 'show', `refs/heads/raven/${first.id}:code.txt`]), '第3版');
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-list', '--count', `refs/heads/raven/${first.id}`]), '3');
    assert.deepEqual(third.session, first.session);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('源 hooks 和 Agent 的 .git 指针不进入客户端私有元数据，保留二进制和执行位', async () => {
  const f = await fixture();
  try {
    const marker = join(f.root, 'hook-ran');
    const hooks = join(f.root, 'hooks');
    await mkdir(hooks);
    await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(join(hooks, 'pre-commit'), 0o700);
    command(f.source, ['config', 'core.hooksPath', hooks]);
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files: f.files,
      delivery: new GitBranchDelivery(f.files), agent: new SimulatedAgent(async ({session}) => {
        await writeFile(join(session.workspace, '.git'), `gitdir: ${join(f.source, '.git')}\n`);
        await writeFile(join(session.workspace, 'code.txt'), '安全成果');
        await writeFile(join(session.workspace, 'binary'), Buffer.from([0, 255, 128]));
        await writeFile(join(session.workspace, 'script.sh'), '#!/bin/sh\nexit 0\n');
        await chmod(join(session.workspace, 'script.sh'), 0o700);
        return {status: 'completion_candidate', output: null};
      })});
    const run = await runner.execute();
    assert.equal(run.status, 'succeeded', run.reason);
    assert.equal(command(f.source, ['rev-parse', 'HEAD']), f.base);
    await assert.rejects(lstat(marker), {code: 'ENOENT'});
    const ref = `refs/heads/raven/${run.id}`;
    assert.match(command(f.root, ['--git-dir', f.remote, 'ls-tree', ref, 'script.sh']), /^100755 /);
    assert.deepEqual(execFileSync(git, ['--git-dir', f.remote, 'show', `${ref}:binary`]), Buffer.from([0, 255, 128]));
    assert.equal((await lstat(join(run.root, 'git'))).isDirectory(), true);
    assert.equal(run.publications[0]?.entries.some(entry => entry.path === '.git'), false);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('推送后确认丢失，恢复核对远端并复用原提交，不重复推送', async () => {
  const f = await fixture();
  class LostConfirmationFiles extends NodeFileExecution {
    pushes = 0;
    lost = false;
    override async command(input: Command, workspace: string, signal: AbortSignal,
      environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
      if (this.pushes > 0 && input.args.includes('ls-remote') && !this.lost) {
        this.lost = true;
        return {status: 'exited', exitCode: 1, stdout: '', stderr: '模拟确认丢失'};
      }
      const result = await super.command(input, workspace, signal, environment);
      if (input.args.includes('push')) this.pushes++;
      return result;
    }
  }
  try {
    const files = new LostConfirmationFiles();
    let observations = 0;
    const agent = new SimulatedAgent(async ({session}) => {
        observations++;
        await writeFile(join(session.workspace, 'code.txt'), '已推送代码');
        return {status: 'completion_candidate', output: null};
      });
    const options = {root: join(f.root, 'runs'), files, delivery: new GitBranchDelivery(files), agent};
    const runner = await LocalTaskRunner.create(f.task, options);
    const pending = await runner.execute();
    assert.equal(pending.status, 'pending_verification');
    const commit = command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${pending.id}`]);
    const restored = await LocalTaskRunner.restoreDelivery(
      JSON.parse(await readFile(join(pending.root, 'run.json'), 'utf8')), {...options, delivery: new GitBranchDelivery(files)});
    const recovered = await restored.execute();
    assert.equal(recovered.status, 'succeeded', recovered.reason);
    assert.equal(observations, 1);
    assert.equal(files.pushes, 1);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${pending.id}`]), commit);
    const evidence = recovered.results[0]?.delivery;
    assert.ok(evidence && typeof evidence === 'object' && !Array.isArray(evidence));
    assert.equal(evidence.commit, commit);
    assert.equal(evidence.status, 'pushed');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('提交写入后中断，恢复找回同一提交和分支，不重跑 Agent', async () => {
  const f = await fixture();
  class InterruptedFiles extends NodeFileExecution {
    interrupted = false;
    override async command(input: Command, workspace: string, signal: AbortSignal,
      environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
      const result = await super.command(input, workspace, signal, environment);
      if (input.args.includes('commit') && !this.interrupted) {
        this.interrupted = true;
        throw new Error('模拟提交后中断');
      }
      return result;
    }
  }
  try {
    const files = new InterruptedFiles();
    let observations = 0;
    const runner = await LocalTaskRunner.create(f.task, {root: join(f.root, 'runs'), files,
      delivery: new GitBranchDelivery(files), agent: new SimulatedAgent(async ({session}) => {
        observations++;
        await writeFile(join(session.workspace, 'code.txt'), '恢复代码');
        return {status: 'completion_candidate', output: null};
      })});
    const pending = await runner.execute();
    assert.equal(pending.status, 'pending_verification');
    const commit = command(f.root, ['--git-dir', join(pending.root, 'git'), 'rev-parse', 'refs/raven/versions/1']);
    await runner.recoverDelivery();
    const restored = await runner.execute();
    assert.equal(restored.status, 'succeeded', restored.reason);
    assert.equal(observations, 1);
    assert.equal(restored.version, 1);
    assert.deepEqual(restored.session, pending.session);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-parse', `refs/heads/raven/${pending.id}`]), commit);
    assert.equal(command(f.root, ['--git-dir', f.remote, 'rev-list', '--count', commit]), '2');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});
