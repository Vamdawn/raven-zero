import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';

const git = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git' : 'git';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--staged')) throw new Error('Usage: pnpm check [--staged]');
if (args[0] === '--staged') {
  // Tests read the working tree. Require it to match the index being committed.
  const unstaged = execFileSync(git, ['diff', '--name-only'], {encoding: 'utf8'});
  const untracked = execFileSync(git, ['ls-files', '--others', '--exclude-standard'], {encoding: 'utf8'});
  if (unstaged || untracked) throw new Error('Stage the complete change before commit so tested files match the index.');
}
execFileSync(git, ['diff', '--check'], {stdio: 'inherit'});
execFileSync(git, ['diff', '--cached', '--check'], {stdio: 'inherit'});
execFileSync('pnpm', ['test'], {stdio: 'inherit'});
execFileSync('pnpm', ['test:tools'], {stdio: 'inherit'});
