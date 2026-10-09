import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const doctor = fileURLToPath(new URL('../doctor.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../../', import.meta.url));

test('doctor reports a missing MySQL executable as an environment failure', () => {
  const root = mkdtempSync('/tmp/raven doctor-');
  try {
    const result = spawnSync(process.execPath, [doctor], {
      env: {...process.env, RAVEN_MYSQLD: join(root, 'missing mysqld')}, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[environment\].*MySQL 8\.4/);
    assert.match(result.stderr, /RAVEN_MYSQLD/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('doctor rejects other MySQL versions without initializing or starting a daemon', () => {
  const root = mkdtempSync('/tmp/raven doctor-');
  try {
    const executable = join(root, 'fake mysqld');
    writeFileSync(executable, `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== '--no-defaults --version') process.exit(23);
console.log('mysqld Ver 8.0.26');
`, {mode: 0o755});
    const result = spawnSync(process.execPath, [doctor], {
      env: {...process.env, RAVEN_MYSQLD: executable}, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[environment\] Requires MySQL 8\.4.*8\.0\.26/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('MySQL smoke CLI connects, queries through the public store, and closes its private instance', () => {
  const result = spawnSync('pnpm', ['run', 'test:mysql-smoke'], {
    cwd: repository, env: process.env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[mysql-smoke\] connection, query and close passed/);
});

test('MySQL smoke CLI reports connection setup failure separately from business tests', () => {
  const root = mkdtempSync('/tmp/raven smoke-');
  try {
    const result = spawnSync('pnpm', ['run', 'test:mysql-smoke'], {
      cwd: repository, env: {...process.env, RAVEN_MYSQLD: join(root, 'missing mysqld')},
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[mysql-smoke\] isolated MySQL connection\/query\/close failed/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
