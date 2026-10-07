import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {launchScope, recoverScope, stopScope} from '../src/mac_scope.js';
import {native} from '../src/native.js';

async function waitFile(path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try {
      const value = await readFile(path, 'utf8');
      if (value.trim()) return value;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(20);
  }
  throw new Error(`Missing fixture ${path}`);
}

test('kernel scope includes unregistered orphan, rejects stale PID generation, and survives manager restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-scope-test-'));
  const childProgram = join(root, 'child.mjs');
  const parentProgram = join(root, 'parent.mjs');
  // The child never registers with the adapter. The test knows its PID only
  // to test a stale audit token; stopScope discovers it through the kernel.
  await writeFile(childProgram, `import {writeFileSync, existsSync} from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(join(root, 'child.pid'))}, String(process.pid));
setInterval(() => {if (existsSync(${JSON.stringify(join(root, 'release'))})) writeFileSync(${JSON.stringify(join(root, 'late'))}, 'bad');}, 20);`);
  await writeFile(parentProgram, `import {spawn} from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(childProgram)}], {detached: true, stdio: 'ignore'});
child.unref();`);
  const scope = await launchScope(join(root, 'scope'), process.execPath, [parentProgram]);
  try {
    const child = (await waitFile(join(root, 'child.pid'))).trim();
    const identity = await native(['membership', child], z.strictObject({coalition: z.string(), version: z.number().int()}));
    assert.equal(identity.coalition, scope.coalition);
    const stale = await native(['signal-token', scope.coalition, child, String(identity.version + 1), '9'], z.strictObject({errno: z.number().int()}));
    assert.equal(stale.errno, 3); // ESRCH: generation rejected by the kernel.
    // Read the launcher's durable metadata as a new manager would.
    const restored = await recoverScope(scope.directory);
    assert.deepEqual(restored, scope);
    const stopped = await stopScope(restored, 100);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    assert.equal(stopped.escalated, true);
    await writeFile(join(root, 'release'), 'go');
    await delay(100);
    await assert.rejects(readFile(join(root, 'late')));
    assert.equal((await stopScope(restored)).status, 'confirmed');
  } finally {
    const stopped = await stopScope(scope, 0);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    await rm(root, {recursive: true});
  }
});

test('scope stop leaves independent live job untouched and unknown scope pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-scope-pair-'));
  const sleeper = join(root, 'sleep.mjs');
  await writeFile(sleeper, 'setInterval(() => {}, 1000);');
  const first = await launchScope(join(root, 'first'), process.execPath, [sleeper]);
  const second = await launchScope(join(root, 'second'), process.execPath, [sleeper]);
  try {
    assert.notEqual(first.coalition, second.coalition);
    assert.equal((await stopScope(first, 0)).status, 'confirmed');
    const counts = await native(['usage', second.coalition], z.strictObject({started: z.string(), exited: z.string()}));
    assert.notEqual(counts.started, counts.exited);
    const unknown = {...second, coalition: '9999999999'};
    assert.equal((await stopScope(unknown, 0, 100)).status, 'pending_verification');
    assert.equal((await stopScope({...first, coalition: second.coalition}, 0)).status, 'pending_verification');
  } finally {
    assert.equal((await stopScope(first, 0)).status, 'confirmed');
    const result = await stopScope(second, 0);
    assert.equal(result.status, 'confirmed', JSON.stringify(result));
    await rm(root, {recursive: true});
  }
});

test('an unprivileged job cannot spawn into another kernel resource scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-scope-escape-'));
  const manager = await native(['membership', String(process.pid)], z.strictObject({coalition: z.string(), version: z.number()}));
  const probe = fileURLToPath(new URL('./coalition_escape', import.meta.url));
  const scope = await launchScope(join(root, 'scope'), probe, [manager.coalition]);
  try {
    const response = JSON.parse(await waitFile(join(scope.directory, 'stdout')));
    assert.equal(response.configured, 0);
    assert.equal(response.spawnError, 1); // EPERM, after a valid spawn attribute.
  } finally {
    const stopped = await stopScope(scope, 0);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    await rm(root, {recursive: true});
  }
});

test('controller SIGKILL after empty proof and bootout recovers without reusing vanished kernel counters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-stop-crash-'));
  const module = new URL('../src/mac_scope.js', import.meta.url).href;
  const nativeModule = new URL('../src/native.js', import.meta.url).href;
  const controller = spawn(process.execPath, ['--input-type=module', '-e', `
import {launchScope} from ${JSON.stringify(module)};
import {BOUNDARY,command,native} from ${JSON.stringify(nativeModule)};
import {setTimeout as delay} from 'node:timers/promises';
const scope=await launchScope(${JSON.stringify(join(root, 'scope'))}, '/usr/bin/true', []);
while(true){
 const usage=JSON.parse(await command(BOUNDARY,['usage',scope.coalition]));
 if(usage.started===usage.exited)break;await delay(20);
}
await command(BOUNDARY,['journal',scope.directory+'/empty.json',scope.directory,JSON.stringify(scope)]);
await command('/bin/launchctl',['bootout',scope.target]);
process.stdout.write('bootout-complete\\n');setInterval(()=>{},1000);`], {stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd()});
  const ended = once(controller, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      controller.stdout.once('data', () => resolve());
      controller.once('exit', () => reject(new Error('Crash fixture exited before checkpoint')));
      controller.once('error', reject);
    });
    controller.kill('SIGKILL'); await ended;
    const record = await recoverScope(join(root, 'scope'));
    const stopped = await stopScope(record, 0);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    assert.equal((await stopScope(record)).status, 'confirmed');
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) {controller.kill('SIGKILL'); await ended;}
    const record = await recoverScope(join(root, 'scope'));
    assert.equal((await stopScope(record, 0)).status, 'confirmed');
    await rm(root, {recursive: true});
  }
});
