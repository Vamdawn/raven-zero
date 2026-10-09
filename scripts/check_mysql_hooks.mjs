import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createScanner, SyntaxKind} from 'typescript/unstable/ast';

// A narrow guard for callback-driver initialization; this is not general Promise linting.
const directory = fileURLToPath(new URL('../packages/server/src/', import.meta.url));
const paths = process.argv.length > 2 ? process.argv.slice(2)
  : readdirSync(directory, {recursive: true}).filter(path => path.endsWith('.ts')).map(path => join(directory, path));
const listeners = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
for (const path of paths) {
  const source = readFileSync(path, 'utf8');
  const scanner = createScanner(true, undefined, source);
  const tokens = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    tokens.push({kind, value: kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText(),
      position: scanner.getTokenStart()});
  }
  if (!tokens.some((token, index) => token.kind === SyntaxKind.StringLiteral &&
    token.value === 'mysql2' && tokens[index - 1]?.value === 'from')) continue;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!listeners.has(token.value)) continue;
    const previous = tokens[index - 1]?.value;
    const bracket = previous === '[' && token.kind === SyntaxKind.StringLiteral && tokens[index + 1]?.value === ']';
    if (!bracket && previous !== '.' && previous !== '?.') continue;
    let next = index + (bracket ? 2 : 1);
    if (tokens[next]?.value === '?.') next++;
    if (tokens[next]?.value !== '(' || tokens[next + 1]?.kind !== SyntaxKind.StringLiteral ||
        tokens[next + 1]?.value !== 'connection') continue;
    const line = source.slice(0, token.position).split('\n').length;
    console.error(`${path}:${line}: use Kysely's awaited onCreateConnection instead of mysql2 connection event hooks`);
    process.exitCode = 1;
  }
}
