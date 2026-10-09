import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, readlink, realpath, writeFile} from 'node:fs/promises';
import {join, posix} from 'node:path';
import {z} from 'zod';
import {BOUNDARY, command, sync} from './native.js';

const MARKER = '.raven-manifest.json';
const entrySchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('file'), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean()}),
  z.strictObject({kind: z.literal('directory')}),
  z.strictObject({kind: z.literal('link'), target: z.string()}),
]);
const manifestSchema = z.strictObject({
  version: z.literal(1), run: z.string().min(1), thread: z.string().min(1),
  generation: z.number().int().positive(), entries: z.array(z.tuple([z.string(), entrySchema])),
});
type Entries = Record<string, z.infer<typeof entrySchema>>;
export type Manifest = z.infer<typeof manifestSchema>;

export interface Publication {
  readonly directory: string;
  readonly manifest: Manifest;
}

async function inventory(root: string): Promise<Entries> {
  const entries = new Map<string, z.infer<typeof entrySchema>>();
  async function walk(prefix: string): Promise<void> {
    const names = (await readdir(join(root, prefix), {encoding: 'buffer'})).sort(Buffer.compare);
    for (const bytes of names) {
      const name = bytes.toString('utf8');
      if (!Buffer.from(name).equals(bytes)) throw new Error('Non-UTF8 publication path');
      if (prefix === '' && name === MARKER) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(root, relative);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const bytes = await readlink(path, {encoding: 'buffer'});
        const target = bytes.toString('utf8');
        if (!Buffer.from(target).equals(bytes)) throw new Error('Non-UTF8 publication link');
        entries.set(relative, {kind: 'link', target});
      }
      else if (info.isDirectory()) {
        entries.set(relative, {kind: 'directory'});
        await walk(relative);
      } else if (info.isFile()) {
        const hash = createHash('sha256');
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          for await (const chunk of file.createReadStream({autoClose: false})) hash.update(chunk);
        } finally { await file.close(); }
        entries.set(relative, {kind: 'file', sha256: hash.digest('hex'), executable: Boolean(info.mode & 0o111)});
      } else throw new Error(`Unsupported entry: ${relative}`);
    }
  }
  await walk('');
  return Object.fromEntries(entries);
}

function verifyLinks(entries: Entries): void {
  for (const [name, entry] of Object.entries(entries)) {
    if (name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Invalid manifest path');
    }
    if (entry.kind !== 'link') continue;
    let pending = name.split('/');
    const stack: string[] = [];
    let followed = 0;
    while (pending.length) {
      const component = pending.shift();
      if (component === undefined || component === '' || component === '.') continue;
      if (component === '..') {
        if (!stack.length) throw new Error(`Link escapes publication: ${name}`);
        stack.pop();
        continue;
      }
      const current = [...stack, component].join('/');
      const target = Object.hasOwn(entries, current) ? entries[current] : undefined;
      if (target === undefined) throw new Error(`Dangling link: ${name}`);
      if (target.kind === 'link') {
        if (posix.isAbsolute(target.target) || ++followed > 40) throw new Error(`Absolute/cyclic link: ${name}`);
        pending = [...target.target.split('/'), ...pending];
      } else {
        if (pending.length && target.kind !== 'directory') throw new Error(`Non-directory link component: ${name}`);
        stack.push(component);
      }
    }
  }
}

/** Captures only after the caller has closed native input and confirmed its
 * execution boundary. Source reads are fd-relative/O_NOFOLLOW in native code.
 * The stage is never valid delivery input. Failure leaves it for diagnosis.
 * An optional checkpoint is awaited after staging is durable and after the
 * final publication barrier. Rejection retains the corresponding bytes.
 */
export async function publish(source: string, delivery: string,
  identity: Readonly<{run: string; thread: string; generation: number}>,
  checkpoint?: (phase: 'staged' | 'published') => Promise<void>): Promise<Publication> {
  const parsed = manifestSchema.omit({entries: true}).parse({...identity, version: 1});
  delivery = await realpath(delivery);
  const destination = join(delivery, `v${parsed.generation}`);
  const stage = `${destination}.${randomUUID()}.partial`;
  await mkdir(stage, {mode: 0o700});
  await command(BOUNDARY, ['copy', source, stage]);
  const entries = await inventory(stage);
  verifyLinks(entries);
  const manifest = manifestSchema.parse({...parsed, entries: Object.entries(entries)});
  await writeFile(join(stage, MARKER), JSON.stringify(manifest), {flag: 'wx', mode: 0o600});
  await sync(join(stage, MARKER));
  await sync(stage);
  await checkpoint?.('staged');
  await command(BOUNDARY, ['publish', stage, destination, delivery]);
  await checkpoint?.('published');
  return {directory: destination, manifest};
}

/** Verifies existing captured bytes; never reruns Agent or adopts a partial.
 * A caller's SQLite execution record supplies the expected identity.
 */
export async function recoverPublication(delivery: string,
  identity: Readonly<{run: string; thread: string; generation: number}>): Promise<Publication | undefined> {
  delivery = await realpath(delivery);
  const directory = join(delivery, `v${identity.generation}`);
  try { await lstat(directory); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid publication root');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, MARKER), {encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW})));
  if (manifest.run !== identity.run || manifest.thread !== identity.thread || manifest.generation !== identity.generation) {
    throw new Error('Publication identity does not match execution record');
  }
  const actual = await inventory(directory);
  const expected = Object.fromEntries(manifest.entries);
  if (Object.keys(expected).length !== manifest.entries.length) throw new Error('Duplicate manifest paths');
  verifyLinks(expected);
  const sorted = (entries: Entries) => JSON.stringify(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  if (sorted(actual) !== sorted(expected)) throw new Error('Publication content changed; verification required');
  // Re-establish the durable barrier if the previous publisher disappeared
  // after rename but before acknowledging its final volume flush.
  await sync(join(directory, MARKER));
  await sync(directory); await sync(delivery);
  await sync(join(directory, MARKER));
  return {directory, manifest};
}
