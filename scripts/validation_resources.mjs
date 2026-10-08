import {readFileSync, writeFileSync, realpathSync, readdirSync} from 'node:fs';
import {join, relative, isAbsolute, dirname, basename, resolve, sep} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {recoverScope} from '../packages/codex-adapter/dist/src/index.js';

function contains(parent, child) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function canonical(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Recorded cwd must be absolute');
  // A new rollout may refer to an already removed temporary cwd.
  try { return realpathSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(canonical(dirname(path)), basename(path));
  }
}

function config(value) {
  const keys = ['home', 'work', 'root', 'database', 'thread'];
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Resource config must contain exactly five fields');
  for (const key of keys) assert.equal(typeof value[key], 'string');
  assert.match(value.thread, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  const result = {...value};
  for (const key of ['home', 'work', 'root', 'database']) {
    assert.ok(isAbsolute(value[key]), `${key} must be absolute`);
    result[key] = realpathSync(value[key]);
  }
  assert.ok(!contains(result.work, result.home) && !contains(result.home, result.work), 'Home/work overlap');
  assert.ok(!contains(result.work, result.root) && !contains(result.home, result.root) &&
    !contains(result.root, result.home), 'Protected root overlap');
  return result;
}

function snapshot(input) {
  let bytes;
  try { bytes = readFileSync(join(input.home, 'config.toml')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const database = new DatabaseSync(input.database, {readOnly: true});
  let threads;
  try { threads = database.prepare('SELECT id, cwd, archived FROM threads').all(); }
  finally { database.close(); }
  const owned = threads.find(row => row.id === input.thread);
  assert.ok(owned && canonical(owned.cwd) === input.work, 'Owned thread/cwd does not match');
  const listing = execFileSync('/Library/Developer/CommandLineTools/usr/bin/git',
    ['worktree', 'list', '--porcelain'], {encoding: 'utf8'});
  return {configHash: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    worktrees: listing.split('\n').filter(line => line.startsWith('worktree ')).sort(), threads, owned};
}

async function check(baseline) {
  const input = config(baseline.input);
  assert.deepEqual(input, baseline.input, 'Recorded paths changed');
  const current = snapshot(input);
  assert.equal(current.configHash, baseline.configHash, 'Personal config changed; preserve current bytes');
  assert.deepEqual(current.worktrees, baseline.worktrees, 'Git worktree inventory changed');
  assert.equal(current.owned.archived, 1, 'Exact test identity is not archived');
  const prior = new Set(baseline.threadIds);
  for (const row of current.threads) {
    if (!prior.has(row.id)) {
      const cwd = canonical(row.cwd);
      assert.ok(!contains(input.work, cwd) && !contains(input.root, cwd), `New test identity: ${row.id}`);
    }
  }
  let scopes = 0;
  const executions = readdirSync(input.root, {withFileTypes: true}).filter(entry => /^execution-[1-9][0-9]*$/.test(entry.name));
  assert.ok(executions.length > 0, 'No execution records; validation is incomplete');
  for (const entry of executions) {
    assert.ok(entry.isDirectory(), 'Execution directory must not be a symlink');
    for (const name of ['scope', 'model']) {
      const directory = join(input.root, entry.name, name);
      const admitted = await recoverScope(directory);
      assert.equal(admitted.directory, directory, 'Scope path changed');
      const stopped = JSON.parse(readFileSync(join(directory, 'stopped.json'), 'utf8'));
      assert.deepEqual(stopped, admitted, 'Stopped proof does not match durable admission');
      const job = spawnSync('/bin/launchctl', ['print', admitted.target], {encoding: 'utf8'});
      if (job.error) throw job.error;
      assert.equal(job.status, 113, 'Job present or launchctl could not confirm absence');
      scopes++;
    }
  }
  return {status: 'confirmed', thread: input.thread, executions: executions.length, scopes};
}

try {
  const [action, source, destination, ...extra] = process.argv.slice(2);
  if (extra.length || !source || (action === 'begin' ? !destination : action !== 'check' || destination)) {
    throw new Error('Usage: validation:begin config.json baseline.json | validation:check baseline.json');
  }
  if (action === 'begin') {
    const input = config(JSON.parse(readFileSync(source, 'utf8')));
    const output = join(realpathSync(dirname(resolve(destination))), basename(destination));
    assert.equal(dirname(output), input.root, 'Baseline must be saved directly under the protected execution root');
    const state = snapshot(input);
    writeFileSync(output, JSON.stringify({input, configHash: state.configHash,
      worktrees: state.worktrees, threadIds: state.threads.map(row => row.id)}, null, 2), {flag: 'wx', mode: 0o600});
    console.log(JSON.stringify({status: 'recorded', baseline: output, thread: input.thread}));
  } else {
    console.log(JSON.stringify(await check(JSON.parse(readFileSync(source, 'utf8')))));
  }
} catch (error) {
  console.error(JSON.stringify({status: 'pending_verification', reason: error.message}));
  process.exitCode = 1;
}
