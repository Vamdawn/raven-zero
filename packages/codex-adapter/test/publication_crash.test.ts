import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import type {Socket} from 'node:net';
import {join} from 'node:path';
import {launchScope, stopScope} from '../src/mac_scope.js';
import type {ScopeRecord} from '../src/mac_scope.js';
import {recoverPublication, publish} from '../src/publication.js';

for (const phase of ['staged', 'published'] as const) {
  test(`publisher SIGKILL at acknowledged ${phase} phase recovers only complete, unchanged bytes`, async () => {
    const root = await realpath(await mkdtemp('/tmp/rv-publish-crash-'));
    const work = join(root, 'work'); const delivery = join(root, 'delivery');
    await mkdir(work); await mkdir(delivery);
    const identity = {run: 'crash-run', thread: 'owned-thread', generation: 1};
    const payload = Buffer.from('captured publication');
    await writeFile(join(work, 'report'), payload);
    const endpoint = join(root, 'checkpoint.sock');
    const listener = createServer();
    let peer: Socket | undefined;
    let scope: ScopeRecord | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reached = new Promise<string>((resolve, reject) => {
      listener.once('connection', socket => {
        peer = socket;
        socket.setEncoding('utf8');
        let message = '';
        socket.on('data', chunk => {
          message += chunk;
          if (message.endsWith('\n')) resolve(message.trim());
        });
        socket.once('error', reject);
        socket.once('end', () => reject(new Error('Publisher left checkpoint before interruption')));
      });
      timer = setTimeout(() => reject(new Error('Publisher did not acknowledge checkpoint')), 15_000);
    });
    // Own rejection immediately, including a launch failure before awaiting it.
    void reached.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(endpoint, resolve);
      });
      const program = join(root, 'publish.mjs');
      await writeFile(program, `import {publish} from ${JSON.stringify(new URL('../src/publication.js', import.meta.url).href)};
import {createConnection} from 'node:net';
import {once} from 'node:events';
await publish(${JSON.stringify(work)}, ${JSON.stringify(delivery)}, ${JSON.stringify(identity)}, async phase => {
  if (phase !== ${JSON.stringify(phase)}) return;
  const socket = createConnection(${JSON.stringify(endpoint)});
  await once(socket, 'connect');
  socket.write(phase + '\\n');
  await new Promise((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('end', () => reject(new Error('Checkpoint controller disconnected without release')));
    socket.once('error', reject);
  });
});`);
      scope = await launchScope(join(root, 'scope'), process.execPath, [program]);
      try { assert.equal(await reached, phase); }
      catch (error) {
        const stdout = await readFile(join(scope.directory, 'stdout'), 'utf8');
        const stderr = await readFile(join(scope.directory, 'stderr'), 'utf8');
        throw new Error(`Checkpoint ${phase} failed; scope=${scope.target}; stdout=${stdout}; stderr=${stderr}`, {cause: error});
      }
      clearTimeout(timer);
      assert.equal((await readdir(delivery)).some(name => name.endsWith('.partial')), phase === 'staged');
      // The fixture advances only on an explicit release message, never EOF.
      // Keep the socket open while the whole admitted scope receives SIGKILL.
      const stopped = await stopScope(scope, 0);
      assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
      const recovered = await recoverPublication(delivery, identity);
      if (phase === 'staged') assert.equal(recovered, undefined);
      else assert.ok(recovered);
      const final = recovered ?? await publish(work, delivery, identity);
      assert.deepEqual(await readFile(join(final.directory, 'report')), payload);
      assert.deepEqual(await recoverPublication(delivery, identity), final);
      await writeFile(join(work, 'report'), 'later source change');
      assert.deepEqual(await recoverPublication(delivery, identity), final);
      await writeFile(join(final.directory, '__proto__'), 'untracked tamper');
      await assert.rejects(recoverPublication(delivery, identity), /content changed/);
    } finally {
      clearTimeout(timer);
      try {
        if (scope) {
          const stopped = await stopScope(scope, 0);
          assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
          await rm(root, {recursive: true});
        }
      } finally {
        peer?.destroy();
        if (listener.listening) {
          await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
        }
      }
    }
  });
}
