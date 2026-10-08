import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, realpath, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {CodexSession} from '../src/session.js';

test('session rejects overlapping task workspace and Home before starting Codex', async () => {
  const fixture = await realpath(await mkdtemp('/tmp/rv-layout-'));
  const work = join(fixture, 'work');
  const home = join(fixture, 'home');
  const root = join(fixture, 'root');
  const nestedHome = join(work, 'codex-home');
  const dotHome = join(work, '..home');
  const nestedWork = join(home, 'task');
  const alias = join(fixture, 'home-alias');
  try {
    for (const directory of [work, home, root, nestedHome, dotHome, nestedWork]) await mkdir(directory);
    await symlink(nestedHome, alias);
    for (const [taskDirectory, homeDirectory] of [
      [work, nestedHome], [work, alias], [work, dotHome], [nestedWork, home], [work, work],
    ]) {
      assert.ok(taskDirectory && homeDirectory);
      await assert.rejects(CodexSession.open({
        run: 'layout', generation: 1, work: taskDirectory, home: homeDirectory, root,
        thread: '00000000-0000-4000-8000-000000000001', model: 'unused',
        codex: join(fixture, 'must-not-start'),
      }), /Protected root\/Home\/task workspace overlap/);
    }
  } finally {
    await rm(fixture, {recursive: true});
  }
});
