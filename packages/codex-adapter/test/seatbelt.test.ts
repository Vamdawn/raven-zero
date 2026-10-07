import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp, realpath, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {seatbeltProfile} from '../src/seatbelt.js';
import {launchScope, stopScope} from '../src/mac_scope.js';

test('protected paths and shared Home executable data stay unwritable under native escalation', async () => {
  const root = await realpath(await mkdtemp('/tmp/rv-profile-'));
  const work = join(root, 'work'); const home = join(root, 'home');
  const delivery = join(root, 'delivery'); const temporary = join(root, 'tmp'); const sqlite = join(root, 'db');
  for (const path of [work, home, delivery, temporary, sqlite]) await mkdir(path);
  for (const path of ['automations', 'shell_snapshots', 'tmp/arg0', 'sessions', 'archived_sessions']) await mkdir(join(home, path), {recursive: true});
  const protectedPaths = [join(delivery, 'guard'), join(home, 'config.toml'), join(home, 'shell_snapshots/foreign.sh'),
    join(home, 'tmp/arg0/foreign'), join(home, 'sessions/foreign.jsonl'), join(home, 'automations/job.toml')];
  for (const path of protectedPaths) await writeFile(path, 'protected');
  const ownRollout = join(home, 'sessions/owned.jsonl');
  await writeFile(ownRollout, 'own');
  const program = join(work, 'probe.mjs');
  await writeFile(program, `import {writeFileSync, linkSync, renameSync} from 'node:fs';
const result = [];
for (const path of ${JSON.stringify(protectedPaths)}) {
  try { writeFileSync(path, 'bad'); result.push('allowed'); } catch(error) {result.push(error.code);}
}
for (const action of [() => linkSync(${JSON.stringify(protectedPaths[0])}, ${JSON.stringify(join(work, 'alias'))}),
  () => renameSync(${JSON.stringify(root)}, ${JSON.stringify(`${root}-moved`)})]) {
  try {action(); result.push('allowed');} catch(error) {result.push(error.code);}
}
writeFileSync(${JSON.stringify(ownRollout)}, 'updated');
writeFileSync(${JSON.stringify(join(work, 'result.json'))}, JSON.stringify(result));`);
  const profile = join(root, 'boundary.sb');
  await writeFile(profile, seatbeltProfile({work, home, sqlite, temporary, rollouts: [ownRollout], thread: 'owned',
    endpoint: join(root, 'private.sock'), protected: [delivery, join(root, 'scope')], egressPort: 1}));
  const scope = await launchScope(join(root, 'scope'), '/usr/bin/sandbox-exec', ['-f', profile, process.execPath, program]);
  try {
    let value = '';
    for (let i = 0; i < 100 && !value; i++) {
      try { value = await readFile(join(work, 'result.json'), 'utf8'); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!value) await delay(20);
    }
    const attempts: unknown = JSON.parse(value);
    assert.deepEqual(attempts, protectedPaths.map(() => 'EPERM').concat(['EPERM', 'EPERM']));
    for (const path of protectedPaths) assert.equal(await readFile(path, 'utf8'), 'protected');
    assert.equal(await readFile(ownRollout, 'utf8'), 'updated');
  } finally {
    const stopped = await stopScope(scope, 0);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    await rm(root, {recursive: true});
  }
});

test('the model TCP4 exception rejects IPv6, other loopback addresses and UDP at the same port', async () => {
  const root = await realpath(await mkdtemp('/tmp/rv-network-'));
  const ipv4 = createServer(socket => socket.end('model'));
  const ipv6 = createServer(socket => socket.end('uncontrolled'));
  ipv4.listen(0, '127.0.0.1'); await once(ipv4, 'listening');
  const address = ipv4.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  ipv6.listen({port: address.port, host: '::1', ipv6Only: true}); await once(ipv6, 'listening');
  const work = join(root, 'work'); const temporary = join(root, 'tmp');
  const home = join(root, 'home'); const sqlite = join(root, 'db');
  for (const directory of [work, temporary, home, sqlite]) await mkdir(directory);
  const program = join(work, 'probe.mjs');
  await writeFile(program, `import {connect} from 'node:net'; import {writeFileSync} from 'node:fs'; import {createSocket} from 'node:dgram';
const outcomes = [];
for (const host of ['127.0.0.1', '::1', '127.0.0.2']) {
 outcomes.push(await new Promise(resolve => {
  const socket = connect(${address.port}, host);
  socket.setTimeout(1000, () => {resolve('timeout'); socket.destroy();});
  socket.on('data', data => {resolve(data.toString()); socket.destroy();});
  socket.on('error', error => {resolve(error.code); socket.destroy();});
 }));
}
outcomes.push(await new Promise(resolve => {
 const udp = createSocket('udp4');
 let settled = false;
 const done = value => {if (settled) return; settled = true; resolve(value); udp.close();};
 udp.on('error', error => done(error.code));
 udp.send(Buffer.from('bad'), ${address.port}, '127.0.0.1', error => done(error?.code ?? 'allowed'));
}));
writeFileSync(${JSON.stringify(join(work, 'result.json'))}, JSON.stringify(outcomes));`);
  const profile = join(root, 'boundary.sb');
  await writeFile(profile, seatbeltProfile({work, home, sqlite, temporary, rollouts: [], thread: 'fixture',
    endpoint: join(root, 'private.sock'), protected: [join(root, 'scope')], egressPort: address.port}));
  const scope = await launchScope(join(root, 'scope'), '/usr/bin/sandbox-exec', ['-f', profile, process.execPath, program]);
  try {
    let value = '';
    for (let attempt = 0; attempt < 100 && !value; attempt++) {
      try {value = await readFile(join(work, 'result.json'), 'utf8');} catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!value) await delay(20);
    }
    assert.deepEqual(JSON.parse(value), ['model', 'EPERM', 'EPERM', 'EPERM']);
  } finally {
    assert.equal((await stopScope(scope, 0)).status, 'confirmed');
    await new Promise<void>(resolve => ipv4.close(() => resolve()));
    await new Promise<void>(resolve => ipv6.close(() => resolve()));
    await rm(root, {recursive: true});
  }
});
