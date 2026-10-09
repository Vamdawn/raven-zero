import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {startMysql} from './mysql_fixture.js';

test('mysqld 初始化失败时保留错误并清理夹具拥有的临时目录', async () => {
  const root = await mkdtemp('/tmp/raven-mysql-failure-');
  const executable = join(root, 'fake mysqld');
  const witness = join(root, 'initialized-directory');
  const previous = process.env.RAVEN_MYSQLD;
  let initialized: string | undefined;
  try {
    await writeFile(executable, `#!${process.execPath}
const {mkdirSync, writeFileSync} = require('node:fs');
const {dirname} = require('node:path');
if (process.argv.includes('--version')) {
  console.log('mysqld Ver 8.4.11');
} else if (process.argv.includes('--initialize-insecure')) {
  const directory = process.argv.find(value => value.startsWith('--datadir=')).slice('--datadir='.length);
  mkdirSync(directory, {recursive: true});
  writeFileSync(directory + '/partial', 'partial initialization');
  writeFileSync(${JSON.stringify(witness)}, dirname(directory));
  console.error('injected initialization failure');
  process.exitCode = 23;
} else {
  throw new Error('must not start mysqld after failed initialization');
}
`, {mode: 0o755});
    process.env.RAVEN_MYSQLD = executable;
    await assert.rejects(startMysql(), /injected initialization failure/);
    initialized = await readFile(witness, 'utf8');
    assert.match(initialized, /^\/tmp\/raven-mysql-[^/]+$/);
    await assert.rejects(stat(initialized), {code: 'ENOENT'});
    assert.equal(await readFile(witness, 'utf8'), initialized);
  } finally {
    if (previous === undefined) delete process.env.RAVEN_MYSQLD;
    else process.env.RAVEN_MYSQLD = previous;
    if (initialized !== undefined) await rm(initialized, {recursive: true, force: true});
    await rm(root, {recursive: true, force: true});
  }
});
