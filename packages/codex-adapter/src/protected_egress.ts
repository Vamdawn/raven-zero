import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {BOUNDARY} from './native.js';
import {launchScope, stopScope} from './mac_scope.js';
import type {ScopeRecord, StopResult} from './mac_scope.js';

export interface ProtectedEgress {
  readonly port: number;
  readonly scope: ScopeRecord;
  /** Release only after the Agent's entire scope has confirmed its stop.
   * launchd retains the port even if either controller or relay crashes.
   */
  close(): Promise<StopResult>;
}

export async function startProtectedEgress(directory: string, upstreamUrl?: string): Promise<ProtectedEgress> {
  const worker = fileURLToPath(new URL('./egress_worker.js', import.meta.url));
  const scope = await launchScope(directory, BOUNDARY,
    ['broker', join(directory, 'port.json'), directory, process.execPath, worker],
    {RAVEN_EGRESS_UPSTREAM: upstreamUrl ?? ''}, directory, true);
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const port = z.strictObject({port: z.number().int().min(1).max(65535)}).parse(
          JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')));
        return {port: port.port, scope, close: () => stopScope(scope)};
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await delay(20);
    }
    throw new Error('Model listener admission not confirmed');
  } catch (error) {
    const stopped = await stopScope(scope, 0);
    throw new Error(`Model relay launch failed; stop=${stopped.status}; preserve ${directory}`, {cause: error});
  }
}
