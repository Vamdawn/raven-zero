import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') throw new Error('Only macOS is supported');
const root = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(`${root}dist/native`, {recursive: true});
const sdk = execFileSync('/usr/bin/xcrun',
  ['--sdk', 'macosx', '--show-sdk-path'], {encoding: 'utf8',
    env: {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'}}).trim();
execFileSync('/Library/Developer/CommandLineTools/usr/bin/clang',
  ['-isysroot', sdk, '-std=c11', '-Wall', '-Wextra', '-Werror',
    `${root}native/boundary.c`, '-o', `${root}dist/native/boundary`], {stdio: 'inherit'});
mkdirSync(`${root}dist/test`, {recursive: true});
execFileSync('/Library/Developer/CommandLineTools/usr/bin/clang',
  ['-isysroot', sdk, '-std=c11', '-Wall', '-Wextra', '-Werror',
    `${root}test/coalition_escape.c`, '-o', `${root}dist/test/coalition_escape`], {stdio: 'inherit'});
