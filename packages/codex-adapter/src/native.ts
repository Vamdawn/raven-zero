import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {z} from 'zod';

const execute = promisify(execFile);
export const BOUNDARY = fileURLToPath(new URL('../native/boundary', import.meta.url));

export async function command(file: string, args: readonly string[]): Promise<string> {
  const result = await execute(file, [...args], {timeout: 10_000, maxBuffer: 1024 * 1024});
  return result.stdout.trim();
}

export async function native<T>(args: readonly string[], schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await command(BOUNDARY, args)));
}

export async function sync(path: string): Promise<void> {
  await command(BOUNDARY, ['sync', path]);
}
