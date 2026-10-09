import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const checker = fileURLToPath(new URL('../check_mysql_hooks.mjs', import.meta.url));

test('static check rejects unowned mysql2 connection hooks with a file and line diagnostic', () => {
  const root = mkdtempSync('/tmp/raven mysql hooks-');
  try {
    const source = join(root, 'store.ts');
    writeFileSync(source, `import {createPool as poolFactory} from 'mysql2';
const pool = poolFactory(config);
pool.on('connection', connection => connection.query("SET time_zone = '+00:00'"));
`);
    const result = spawnSync(process.execPath, [checker, source], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /store\.ts:3:.*onCreateConnection/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('static check handles listener aliases, comments and quoted property access', () => {
  const root = mkdtempSync('/tmp/raven mysql hooks-');
  try {
    const source = join(root, 'store.ts');
    for (const listener of ["pool.once('connection', init)", "pool['addListener'] /* comment */ ('connection', init)",
      "pool?.prependListener?.('connection', init)"]) {
      writeFileSync(source, `import * as mysql from 'mysql2';\n${listener};`);
      const result = spawnSync(process.execPath, [checker, source], {encoding: 'utf8'});
      assert.equal(result.status, 1);
      assert.match(result.stderr, /store\.ts:2:.*onCreateConnection/);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('static check accepts awaited Kysely hooks, promise drivers and unrelated socket listeners', () => {
  const root = mkdtempSync('/tmp/raven mysql hooks-');
  try {
    const source = join(root, 'store.ts');
    for (const code of [
      `import {createPool} from 'mysql2';
new MysqlDialect({pool: createPool(config), onCreateConnection: async connection => {
  await connection.executeQuery(query);
}});
// pool.on('connection', init);
const example = "pool.on('connection', init)";
`,
      "import {createPool} from 'mysql2/promise';\nawait pool.query(sql);",
      "import {createServer} from 'node:net';\nserver.on('connection', listen);",
    ]) {
      writeFileSync(source, code);
      const result = spawnSync(process.execPath, [checker, source], {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});
