import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {launchScope, stopScope} from '../src/mac_scope.js';
import {recoverPublication, publish} from '../src/publication.js';

test('SIGKILL of publisher and native copier leaves partial unaccepted; retry and lost acknowledgement recover the same version', async () => {
  const root = await realpath(await mkdtemp('/tmp/rv-publish-crash-'));
  const work = join(root, 'work'); const delivery = join(root, 'delivery');
  await mkdir(work); await mkdir(delivery);
  const identity = {run: 'crash-run', thread: 'owned-thread', generation: 1};
  const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
  for (let i = 0; i < 8; i++) await writeFile(join(work, `file${i}`), payload);
  const program = join(root, 'publish.mjs');
  await writeFile(program, `import {publish} from ${JSON.stringify(new URL('../src/publication.js', import.meta.url).href)};
await publish(${JSON.stringify(work)}, ${JSON.stringify(delivery)}, ${JSON.stringify(identity)});`);
  const scope = await launchScope(join(root, 'scope'), process.execPath, [program]);
  try {
    let sawStage = false;
    for (let i = 0; i < 100; i++) {
      sawStage = (await readdir(delivery)).some(name => name.endsWith('.partial'));
      if (sawStage) break;
      await delay(5);
    }
    assert.equal(sawStage, true);
    const stopped = await stopScope(scope, 0);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    // A scheduling race may have allowed the whole publish to complete before
    // KILL. Both legal outcomes must recover safely, never accept a partial.
    const recovered = await recoverPublication(delivery, identity);
    const final = recovered ?? await publish(work, delivery, identity);
    assert.equal((await readFile(join(final.directory, 'file7'))).length, payload.length);
    assert.deepEqual(await recoverPublication(delivery, identity), final);
    await writeFile(join(work, 'file7'), 'later source change');
    assert.deepEqual(await recoverPublication(delivery, identity), final);
    await writeFile(join(final.directory, '__proto__'), 'untracked tamper');
    await assert.rejects(recoverPublication(delivery, identity), /content changed/);
  } finally {
    const stopped = await stopScope(scope, 0);
    assert.equal(stopped.status, 'confirmed', JSON.stringify(stopped));
    await rm(root, {recursive: true});
  }
});
