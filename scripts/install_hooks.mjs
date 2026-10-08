import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, lstatSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const git = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git';
const configured = spawnSync(git, ['config', '--get', 'core.hooksPath'], {encoding: 'utf8'});
if (configured.error) throw configured.error;
if (configured.status !== 1) throw new Error('Existing core.hooksPath must be integrated manually; no hooks were changed.');
const root = execFileSync(git, ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim();
if (!existsSync(join(root, '.githooks/pre-commit'))) throw new Error('Missing tracked Raven hook');
const directory = resolve(execFileSync(git, ['rev-parse', '--git-common-dir'], {encoding: 'utf8'}).trim(), 'hooks');
mkdirSync(directory, {recursive: true});
const hook = join(directory, 'pre-commit');
const previous = join(directory, 'pre-commit.raven-previous');
const bootstrap = `#!/bin/sh
# Raven Zero hook bootstrap; policy lives in the tracked .githooks/pre-commit.
set -eu
if [ -d /Library/Developer/CommandLineTools ]; then
  DEVELOPER_DIR=/Library/Developer/CommandLineTools
  export DEVELOPER_DIR
fi
exec /bin/sh "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"
`;
if (existsSync(hook) && lstatSync(hook).isFile() && readFileSync(hook, 'utf8') === bootstrap) {
  console.log('Raven pre-commit already installed.');
} else {
  if (existsSync(previous) || (existsSync(hook) && !lstatSync(hook).isFile())) {
    throw new Error('Existing hook backup or non-file hook; preserve it and integrate manually.');
  }
  const temporary = `${hook}.${randomUUID()}`;
  let backedUp = false;
  try {
    writeFileSync(temporary, bootstrap, {flag: 'wx', mode: 0o755});
    if (existsSync(hook)) { renameSync(hook, previous); backedUp = true; }
    renameSync(temporary, hook);
  } catch (error) {
    if (backedUp) renameSync(previous, hook);
    throw error;
  } finally {
    rmSync(temporary, {force: true});
  }
  console.log('Raven pre-commit installed; previous hook preserved.');
}
