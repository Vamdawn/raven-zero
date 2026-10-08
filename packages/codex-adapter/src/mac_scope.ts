import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {BOUNDARY, command, native, sync} from './native.js';

const membershipSchema = z.strictObject({coalition: z.string().regex(/^\d+$/), version: z.number().int()});
const usageSchema = z.strictObject({started: z.string().regex(/^\d+$/), exited: z.string().regex(/^\d+$/)});
const launchSchema = z.strictObject({coalition: z.string().regex(/^\d+$/), pid: z.number().int().positive()});
export const scopeRecordSchema = z.strictObject({
  boot: z.string(), target: z.string().regex(/^gui\/\d+\/dev\.raven-zero\.[a-f0-9-]+$/),
  coalition: z.string().regex(/^\d+$/), directory: z.string(),
});
export type ScopeRecord = z.infer<typeof scopeRecordSchema>;

export interface StopResult {
  readonly status: 'confirmed' | 'pending_verification';
  readonly reason?: string;
  readonly escalated: boolean;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, part => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[part] ?? part));
}

export async function platformCheck(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' ||
      process.getuid?.() === 0 ||
      await command('/usr/bin/sw_vers', ['-productVersion']) !== '26.6.1') {
    throw new Error('Unverified macOS version/architecture; refusing to launch Agent');
  }
  const manager = await native(['membership', String(process.pid)], membershipSchema);
  await native(['usage', manager.coalition], usageSchema);
}

export async function bootIdentity(): Promise<string> {
  return command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
}

/** Creates one ephemeral launchd job; no persistent LaunchAgent installation.
 * directory must be framework-owned and excluded from all Agent write grants.
 * The native launcher records its coalition durably before executing program.
 */
export async function launchScope(directory: string, program: string,
  args: readonly string[], environment: Readonly<Record<string, string>> = {},
  workingDirectory = directory, modelSocket = false): Promise<ScopeRecord> {
  await platformCheck();
  await mkdir(directory, {mode: 0o700});
  directory = await realpath(directory);
  await sync(dirname(directory));
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Missing user identity');
  const label = `dev.raven-zero.${randomUUID()}`;
  const target = `gui/${uid}/${label}`;
  const boot = await bootIdentity();
  const recordPath = join(directory, 'membership.json');
  const programArguments = [BOUNDARY, 'launch', recordPath, directory, program, ...args];
  const env = Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
  const plist = `<?xml version="1.0"?><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${programArguments.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${env}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
${modelSocket ? '<key>Sockets</key><dict><key>Model</key><dict><key>SockFamily</key><string>IPv4</string><key>SockType</key><string>stream</string><key>SockProtocol</key><string>TCP</string><key>SockNodeName</key><string>127.0.0.1</string><key>SockServiceName</key><string>0</string></dict></dict>' : ''}
<key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
<key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>${xml(join(directory, 'stdout'))}</string>
<key>StandardErrorPath</key><string>${xml(join(directory, 'stderr'))}</string></dict></plist>`;
  const plistPath = join(directory, 'job.plist');
  await writeFile(join(directory, 'launch.json'), JSON.stringify({boot, target}), {flag: 'wx', mode: 0o600});
  await sync(join(directory, 'launch.json'));
  await writeFile(plistPath, plist, {flag: 'wx', mode: 0o600});
  await sync(plistPath);
  await sync(directory);
  await command('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  for (let attempts = 0; attempts < 100; attempts++) {
    try {
      const info = launchSchema.parse(JSON.parse(await readFile(recordPath, 'utf8')));
      const manager = await native(['membership', String(process.pid)], membershipSchema);
      if (info.coalition === manager.coalition) throw new Error('Shared resource scope');
      await native(['usage', info.coalition], usageSchema);
      return scopeRecordSchema.parse({coalition: info.coalition, boot, target, directory});
    } catch (error) {
      // Only the absence of the admission record is transient. Invalid records
      // and native ABI failures must remain observable, never become success.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(20);
  }
  throw new Error(`Admission not confirmed; preserve ${directory} for scope recovery`);
}

export async function recoverScope(directory: string): Promise<ScopeRecord> {
  directory = await realpath(directory);
  const launch = z.strictObject({boot: z.string(), target: z.string()}).parse(
    JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8')));
  const membership = launchSchema.parse(JSON.parse(await readFile(join(directory, 'membership.json'), 'utf8')));
  return scopeRecordSchema.parse({boot: launch.boot, target: launch.target, coalition: membership.coalition, directory});
}

async function jobPresent(target: string): Promise<boolean> {
  try { await command('/bin/launchctl', ['print', target]); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 113) return false;
    throw error;
  }
}

async function readProof(path: string, record: ScopeRecord): Promise<boolean> {
  try {
    const proof = scopeRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (JSON.stringify(proof) !== JSON.stringify(record)) throw new Error('Stop proof does not match admission');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function persistProof(name: string, record: ScopeRecord): Promise<void> {
  const path = join(record.directory, name);
  if (!await readProof(path, record)) {
    await command(BOUNDARY, ['journal', path, record.directory, JSON.stringify(record)]);
  }
  // Also re-establish the barrier when recovering a lost journal acknowledgement.
  await sync(path); await sync(record.directory); await sync(path);
}

/** Stops every kernel-accounted process, including unregistered orphans.
 * TERM/KILL requests are separate from confirmation. Errors preserve the scope.
 * Repeated calls and manager restarts reuse the durable admission/close proof.
 */
export async function stopScope(input: unknown, graceMs = 500, deadlineMs = 5_000): Promise<StopResult> {
  const record = scopeRecordSchema.parse(input);
  let escalated = false;
  try {
    const admitted = await recoverScope(record.directory);
    if (JSON.stringify(admitted) !== JSON.stringify(record)) throw new Error('Scope does not match durable admission record');
    const boot = await bootIdentity();
    if (boot !== record.boot) {
      if (await jobPresent(record.target)) throw new Error('Job identity changed across boot');
      return {status: 'confirmed', escalated};
    }
    if (await readProof(join(record.directory, 'stopped.json'), record)) {
      if (await jobPresent(record.target)) throw new Error('Stopped job identity became active');
      await persistProof('stopped.json', record);
      return {status: 'confirmed', escalated};
    }
    // The empty proof precedes bootout: kernel counters can disappear when
    // launchd reaps the job, including before the stopped proof is published.
    // Exclusive admission prevents a reactivated launcher from executing Agent.
    if (await readProof(join(record.directory, 'empty.json'), record) && !await jobPresent(record.target)) {
      await persistProof('stopped.json', record);
      return {status: 'confirmed', escalated};
    }
    const startedAt = performance.now();
    while (performance.now() - startedAt < deadlineMs) {
      const counters = await native(['usage', record.coalition], usageSchema);
      if (counters.started === counters.exited) {
        // KeepAlive/StartInterval are absent; socket-activated relays may
        // reactivate, but the exclusive admission journal prevents another
        // worker from executing. Before reporting confirmation,
        // remove the job too: it must no longer admit a fresh root process.
        await persistProof('empty.json', record);
        if (await jobPresent(record.target)) await command('/bin/launchctl', ['bootout', record.target]);
        if (await jobPresent(record.target)) throw new Error('Job still admits processes');
        await persistProof('stopped.json', record);
        return {status: 'confirmed', escalated};
      }
      escalated = performance.now() - startedAt >= graceMs;
      await native(['signal', record.coalition, escalated ? '9' : '15'], z.strictObject({signalled: z.number().int().nonnegative()}));
      await delay(25);
    }
    throw new Error('Whole scope did not become empty before deadline');
  } catch (error) {
    return {status: 'pending_verification', escalated,
      reason: error instanceof Error ? error.message : String(error)};
  }
}
