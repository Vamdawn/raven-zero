import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, symlink, link, lstat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {publish, recoverPublication} from '../src/publication.js';

test('publishes independent files, internal links, executable bits and distinct versions; resumes saved bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-publish-test-'));
  const work = join(root, 'work');
  const delivery = join(root, 'delivery');
  await mkdir(work); await mkdir(delivery);
  try {
    await writeFile(join(work, 'report'), 'candidate', {mode: 0o755});
    await mkdir(join(work, 'nested'));
    await symlink('../report', join(work, 'nested/link'));
    await symlink('nested', join(work, 'directory-link'));
    await symlink('directory-link/link', join(work, 'chain'));
    await link(join(work, 'report'), join(work, 'alias'));
    await writeFile(join(work, '.git'), 'gitdir: /external');
    await writeFile(join(work, '__proto__'), 'tracked');
    await symlink('__proto__', join(work, 'prototype-link'));
    const identity = {run: 'test-run', thread: 'existing-thread', generation: 1};
    const first = await publish(work, delivery, identity);
    assert.equal(await readFile(join(first.directory, 'chain'), 'utf8'), 'candidate');
    assert.notEqual((await lstat(join(first.directory, 'report'))).ino, (await lstat(join(work, 'report'))).ino);
    assert.equal((await lstat(join(first.directory, 'report'))).mode & 0o111, 0o111);
    await assert.rejects(lstat(join(first.directory, '.git')));
    assert.deepEqual(await recoverPublication(delivery, identity), first);
    assert.equal(await readFile(join(first.directory, 'prototype-link'), 'utf8'), 'tracked');
    await writeFile(join(work, 'report'), 'second');
    const second = await publish(work, delivery, {...identity, generation: 2});
    assert.equal(await readFile(join(first.directory, 'report'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(second.directory, 'chain'), 'utf8'), 'second');
    await assert.rejects(publish(work, delivery, identity));
    await writeFile(join(first.directory, 'report'), 'tampered');
    await assert.rejects(recoverPublication(delivery, identity), /content changed/);
  } finally { await rm(root, {recursive: true}); }
});

test('unsafe links, source root symlink and reserved marker never become a publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rv-bad-publication-'));
  const work = join(root, 'work'); const delivery = join(root, 'delivery');
  await mkdir(work); await mkdir(delivery);
  try {
    const identity = {run: 'test-run', thread: 'thread', generation: 1};
    await writeFile(join(work, 'outside'), 'decoy');
    await symlink('.', join(work, 'root-alias'));
    for (const [index, target] of ['/etc/passwd', '../outside', 'missing', 'bad', 'root-alias/../outside'].entries()) {
      await symlink(target, join(work, 'bad'));
      const current = {...identity, generation: index + 1};
      await assert.rejects(publish(work, delivery, current));
      assert.equal(await recoverPublication(delivery, current), undefined);
      await rm(join(work, 'bad'));
    }
    const alias = join(root, 'work-alias');
    await symlink(work, alias);
    await assert.rejects(publish(alias, delivery, {...identity, generation: 6}));
    await writeFile(join(work, '.raven-manifest.json'), '{}');
    await assert.rejects(publish(work, delivery, {...identity, generation: 7}));
    assert.equal(await recoverPublication(delivery, {...identity, generation: 7}), undefined);
  } finally { await rm(root, {recursive: true}); }
});
