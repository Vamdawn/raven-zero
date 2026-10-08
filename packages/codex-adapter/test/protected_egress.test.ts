import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {recoverScope, stopScope} from '../src/mac_scope.js';
import {native} from '../src/native.js';
import {stopExecution} from '../src/recovery.js';
import {launchScope} from '../src/mac_scope.js';
import {startProtectedEgress} from '../src/protected_egress.js';

test('launchd reserves model port through controller and relay SIGKILL, until recovery releases the scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-relay-test-'));
  const directory = join(root, 'model');
  const module = new URL('../src/protected_egress.js', import.meta.url).href;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', `
import {startProtectedEgress} from ${JSON.stringify(module)};
await startProtectedEgress(${JSON.stringify(directory)});
process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`], {stdio: ['ignore', 'pipe', 'inherit']});
  const ended = once(controller, 'exit');
  let admitted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      controller.stdout.once('data', () => resolve());
      controller.once('exit', () => reject(new Error('Relay fixture exited before admission')));
      controller.once('error', reject);
    });
    const scope = await recoverScope(directory);
    admitted = true;
    const port = z.strictObject({port: z.number().int()}).parse(JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'))).port;
    controller.kill('SIGKILL'); await ended;
    const counters = z.strictObject({started: z.string(), exited: z.string()});
    assert.notEqual((await native(['usage', scope.coalition], counters)).started,
      (await native(['usage', scope.coalition], counters)).exited);
    await native(['signal', scope.coalition, '9'], z.strictObject({signalled: z.number()}));
    let empty = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const usage = await native(['usage', scope.coalition], counters);
      if (usage.started === usage.exited) { empty = true; break; }
      await delay(20);
    }
    assert.equal(empty, true);
    const intruder = createServer();
    try {
      await assert.rejects(new Promise<void>((resolve, reject) => {
        intruder.once('error', reject);
        intruder.listen(port, '127.0.0.1', resolve);
      }), {code: 'EADDRINUSE'});
    } finally { intruder.close(); }
    assert.equal((await stopScope(scope, 0)).status, 'confirmed');
    const available = createServer();
    await new Promise<void>((resolve, reject) => {
      available.once('error', reject);
      available.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>(resolve => available.close(() => resolve()));
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) { controller.kill('SIGKILL'); await ended; }
    if (admitted) assert.equal((await stopScope(await recoverScope(directory), 0)).status, 'confirmed');
    await rm(root, {recursive: true});
  }
});


test('restart cleanup preserves model listener when Agent scope is uncertain, then closes in safe order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-execution-test-'));
  const sleeper = join(root, 'sleep.mjs');
  await writeFile(sleeper, 'setInterval(() => {}, 1000);');
  const relay = await startProtectedEgress(join(root, 'model'));
  const agent = await launchScope(join(root, 'scope'), process.execPath, [sleeper]);
  const journal = join(agent.directory, 'membership.json');
  const admitted = await readFile(journal, 'utf8');
  try {
    await writeFile(journal, JSON.stringify({coalition: '999999999999', pid: 1}));
    assert.equal((await stopExecution(root)).status, 'pending_verification');
    const counts = await native(['usage', relay.scope.coalition], z.strictObject({started: z.string(), exited: z.string()}));
    assert.notEqual(counts.started, counts.exited);
    await writeFile(journal, admitted);
    assert.equal((await stopExecution(root)).status, 'confirmed');
    assert.equal((await stopExecution(root)).status, 'confirmed');
  } finally {
    await writeFile(journal, admitted);
    assert.equal((await stopScope(agent, 0)).status, 'confirmed');
    assert.equal((await relay.close()).status, 'confirmed');
    await rm(root, {recursive: true});
  }
});
