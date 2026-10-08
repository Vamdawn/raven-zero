import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, realpathSync, existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const git = '/Library/Developer/CommandLineTools/usr/bin/git';
const environment = {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'};
// Git exports repository-local variables while running the parent hook.
for (const key of Object.keys(environment)) if (key.startsWith('GIT_')) delete environment[key];

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/rv guardrails-'));
  execFileSync(git, ['init', '--quiet', root], {env: environment});
  execFileSync(git, ['config', 'user.name', 'Guardrail test'], {cwd: root, env: environment});
  execFileSync(git, ['config', 'user.email', 'guardrail@example.invalid'], {cwd: root, env: environment});
  return root;
}

function run(root, script, args = [], env = environment) {
  return spawnSync(process.execPath, [join(repository, 'scripts', script), ...args],
    {cwd: root, env, encoding: 'utf8'});
}

test('hook installation preserves the previous hook, is repeatable, and failed checks block commits', () => {
  const root = fixture();
  try {
    cpSync(join(repository, '.githooks'), join(root, '.githooks'), {recursive: true});
    mkdirSync(join(root, 'scripts'));
    cpSync(join(repository, 'scripts/check.mjs'), join(root, 'scripts/check.mjs'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, '.gitignore'), 'bin/\nrecord\n');
    const original = '#!/bin/sh\nprintf "previous\\n" >> record\n';
    const hook = join(root, '.git/hooks/pre-commit');
    writeFileSync(hook, original, {mode: 0o755});
    writeFileSync(join(root, 'bin/pnpm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> record\nexit "${CHECK_EXIT:-0}"\n', {mode: 0o755});
    const env = {...environment, PATH: `${join(root, 'bin')}:${environment.PATH}`};
    assert.equal(run(root, 'install_hooks.mjs').status, 0);
    const installed = readFileSync(hook, 'utf8');
    assert.equal(run(root, 'install_hooks.mjs').status, 0);
    assert.equal(readFileSync(hook, 'utf8'), installed);
    assert.equal(readFileSync(`${hook}.raven-previous`, 'utf8'), original);
    execFileSync(git, ['add', '.'], {cwd: root, env});
    const commit = spawnSync(git, ['commit', '--quiet', '-m', 'checks pass'], {cwd: root, env, encoding: 'utf8'});
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(readFileSync(join(root, 'record'), 'utf8'), 'previous\ntest\ntest:tools\n');
    const head = execFileSync(git, ['rev-parse', 'HEAD'], {cwd: root, env, encoding: 'utf8'});
    writeFileSync(join(root, 'change'), 'next');
    execFileSync(git, ['add', '.'], {cwd: root, env});
    writeFileSync(join(root, 'record'), '');
    const failed = spawnSync(git, ['commit', '--quiet', '-m', 'checks fail'],
      {cwd: root, env: {...env, CHECK_EXIT: '23'}, encoding: 'utf8'});
    assert.notEqual(failed.status, 0);
    assert.equal(execFileSync(git, ['rev-parse', 'HEAD'], {cwd: root, env, encoding: 'utf8'}), head);
    assert.equal(readFileSync(join(root, 'record'), 'utf8'), 'previous\ntest\n');
    writeFileSync(join(root, 'change'), 'not staged');
    writeFileSync(join(root, 'record'), '');
    assert.notEqual(run(root, 'check.mjs', ['--staged'], env).status, 0);
    assert.equal(readFileSync(join(root, 'record'), 'utf8'), '');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a previous formatter runs before validation and index mutation during tests prevents commit', () => {
  const root = fixture();
  try {
    cpSync(join(repository, '.githooks'), join(root, '.githooks'), {recursive: true});
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'));
    cpSync(join(repository, 'scripts/check.mjs'), join(root, 'scripts/check.mjs'));
    writeFileSync(join(root, '.gitignore'), 'bin/\n');
    writeFileSync(join(root, 'change'), 'unformatted');
    writeFileSync(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf formatted > change\ngit add change\n', {mode: 0o755});
    writeFileSync(join(root, 'bin/pnpm'), `#!/bin/sh
set -eu
[ "$(cat change)" = formatted ]
`, {mode: 0o755});
    const env = {...environment, PATH: `${join(root, 'bin')}:${environment.PATH}`};
    assert.equal(run(root, 'install_hooks.mjs').status, 0);
    execFileSync(git, ['add', '.'], {cwd: root, env});
    const commit = spawnSync(git, ['commit', '--quiet', '-m', 'formatter before checks'], {cwd: root, env, encoding: 'utf8'});
    assert.equal(commit.status, 0, commit.stderr);
    assert.equal(execFileSync(git, ['show', 'HEAD:change'], {cwd: root, env, encoding: 'utf8'}), 'formatted');
    const head = execFileSync(git, ['rev-parse', 'HEAD'], {cwd: root, env, encoding: 'utf8'});
    // Both test commands succeed, but they mutate the index while running.
    writeFileSync(join(root, 'bin/pnpm'), `#!/bin/sh
if [ "$1" = test ]; then printf untested > change; git add change; fi
exit 0
`);
    const failed = spawnSync(git, ['commit', '--quiet', '--allow-empty', '-m', 'index changed'], {cwd: root, env, encoding: 'utf8'});
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Staged contents changed during validation/);
    assert.equal(execFileSync(git, ['rev-parse', 'HEAD'], {cwd: root, env, encoding: 'utf8'}), head);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('installation preserves a configured hooksPath and never overwrites a conflicting backup', () => {
  const root = fixture();
  try {
    cpSync(join(repository, '.githooks'), join(root, '.githooks'), {recursive: true});
    execFileSync(git, ['config', 'core.hooksPath', 'custom'], {cwd: root, env: environment});
    const hook = join(root, '.git/hooks/pre-commit');
    assert.notEqual(run(root, 'install_hooks.mjs').status, 0);
    assert.equal(existsSync(hook), false);
    execFileSync(git, ['config', '--unset', 'core.hooksPath'], {cwd: root, env: environment});
    writeFileSync(`${hook}.raven-previous`, 'keep');
    assert.notEqual(run(root, 'install_hooks.mjs').status, 0);
    assert.equal(readFileSync(`${hook}.raven-previous`, 'utf8'), 'keep');
    assert.equal(existsSync(hook), false);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('resource receipts verify exact identity, unchanged config and complete stop proofs without deleting evidence', () => {
  const root = fixture();
  let database;
  try {
    const work = join(root, 'work'); const home = join(root, 'home'); const controlled = join(root, 'run');
    for (const directory of [work, home, controlled]) mkdirSync(directory);
    writeFileSync(join(home, 'config.toml'), 'original');
    database = new DatabaseSync(join(root, 'state.sqlite'));
    database.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, cwd TEXT, archived INTEGER)');
    const thread = randomUUID();
    database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(thread, work, 0);
    const input = {work, home, root: controlled, database: join(root, 'state.sqlite'), thread};
    const config = join(root, 'input.json'); const baseline = join(controlled, 'baseline.json');
    writeFileSync(config, JSON.stringify(input));
    const began = run(root, 'validation_resources.mjs', ['begin', config, baseline]);
    assert.equal(began.status, 0, began.stderr);
    assert.equal(statSync(baseline).mode & 0o777, 0o600);
    const saved = readFileSync(baseline, 'utf8');
    assert.notEqual(run(root, 'validation_resources.mjs', ['begin', config, baseline]).status, 0);
    assert.equal(readFileSync(baseline, 'utf8'), saved);
    const check = () => run(root, 'validation_resources.mjs', ['check', baseline]);
    assert.notEqual(check().status, 0, 'Unarchived identity cannot pass');
    database.prepare('UPDATE threads SET archived=1 WHERE id=?').run(thread);
    assert.notEqual(check().status, 0, 'Missing execution cannot pass');
    for (const name of ['scope', 'model']) {
      const directory = join(controlled, 'execution-1', name);
      mkdirSync(directory, {recursive: true});
      const record = {boot: 'fixture', target: `gui/${process.getuid()}/dev.raven-zero.${randomUUID()}`, coalition: '123', directory};
      writeFileSync(join(directory, 'launch.json'), JSON.stringify({boot: record.boot, target: record.target}));
      writeFileSync(join(directory, 'membership.json'), JSON.stringify({coalition: record.coalition, pid: process.pid}));
      writeFileSync(join(directory, 'stopped.json'), JSON.stringify(record));
    }
    assert.equal(check().status, 0);
    // User activity outside this test's paths is not test pollution.
    database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(randomUUID(), repository, 0);
    assert.equal(check().status, 0);
    const intruder = randomUUID();
    database.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(intruder, join(work, 'removed'), 0);
    assert.notEqual(check().status, 0);
    database.prepare('DELETE FROM threads WHERE id=?').run(intruder);
    writeFileSync(join(home, 'config.toml'), 'changed');
    assert.notEqual(check().status, 0);
    assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'changed');
    writeFileSync(join(home, 'config.toml'), 'original');
    const proof = join(controlled, 'execution-1/scope/stopped.json');
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    writeFileSync(proof, JSON.stringify({...record, coalition: '999'}));
    assert.notEqual(check().status, 0);
    assert.equal(readFileSync(baseline, 'utf8'), saved);
    assert.equal(existsSync(proof), true);
  } finally {
    database?.close();
    rmSync(root, {recursive: true, force: true});
  }
});
