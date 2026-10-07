import {execFileSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, mkdir, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

if (execFileSync('codex', ['--version'], {encoding: 'utf8'}).trim() !== 'codex-cli 0.155.1') {
  throw new Error('Protocol generator requires Codex 0.155.1');
}
const source = await mkdtemp(join(tmpdir(), 'rv-protocol-'));
const output = fileURLToPath(new URL('../src/protocol/', import.meta.url));
const queue = ['InitializeParams.ts', 'v2/ThreadResumeParams.ts', 'v2/TurnStartParams.ts',
  'v2/TurnInterruptParams.ts', 'v2/ThreadArchiveParams.ts', 'v2/ThreadReadParams.ts',
  'v2/ThreadUnarchiveParams.ts', 'v2/ConfigReadParams.ts'];
const seen = new Set();
try {
  execFileSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', source]);
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const path = join(source, name);
    const body = (await readFile(path, 'utf8')).replace(/from "([^"]+)"/g, (_match, dependency) => {
      const local = relative(source, resolve(dirname(path), `${dependency}.ts`));
      if (local.startsWith('..')) throw new Error('Unexpected protocol dependency');
      queue.push(local);
      return `from "${dependency}.js"`;
    });
    await mkdir(dirname(join(output, name)), {recursive: true});
    await writeFile(join(output, name), body);
  }
  for (const entry of await readdir(output, {recursive: true, withFileTypes: true})) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && entry.name.endsWith('.ts') && !seen.has(relative(output, path))) await rm(path);
  }
} finally { await rm(source, {recursive: true}); }
