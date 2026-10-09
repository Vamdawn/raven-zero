import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {copyFile, lstat, mkdir, readFile, readdir, rename, chmod, writeFile, realpath} from 'node:fs/promises';
import {isAbsolute, join, resolve, relative, sep} from 'node:path';
import {publicationSchema, taskRunSchema, taskResultSchema} from '@raven-zero/contracts';
import type {Command, CommandResult, FileArtifact, Publication, TaskResult, TaskRun} from '@raven-zero/contracts';
import type {FileExecution, PublicationRequest, RunWorkspace} from './dependencies.js';

/** Paths refer only to files inside a workspace, never to its root or parent. */
export function workspacePath(workspace: string, path: string): string {
  if (isAbsolute(path) || path.includes('\\') || path.includes('\0') ||
    path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error(`Invalid workspace path: ${path}`);
  }
  return join(workspace, path);
}

async function inventory(root: string): Promise<Publication['entries']> {
  const entries: Publication['entries'] = [];
  async function walk(prefix: string): Promise<void> {
    for (const name of (await readdir(join(root, prefix))).sort()) {
      if (name === '.git') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const file = workspacePath(root, path);
      const info = await lstat(file);
      if (info.isDirectory()) {
        entries.push({kind: 'directory', path});
        await walk(path);
      } else if (info.isFile()) {
        const bytes = await readFile(file);
        entries.push({kind: 'file', path, sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length, executable: Boolean(info.mode & 0o111)});
      } else throw new Error(`Simulated publication rejects links and special files: ${path}`);
    }
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid workspace root');
  await walk('');
  return entries;
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

interface DirectoryIdentity {
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly workDevice: number;
  readonly workInode: number;
}

interface CommandExecution {
  readonly workspace: string;
  pid?: number;
  closed: boolean;
}

/** Real files and commands, simulated isolation only. Cooperative fixtures must
 * not race path checks. This is not the production safe-copy/process boundary.
 * Caller owns retained directories; failures leave staging and evidence intact.
 */
export class NodeFileExecution implements FileExecution {
  readonly isolation = 'simulated';
  private readonly directories = new Map<string, DirectoryIdentity>();
  private readonly commands = new Set<CommandExecution>();

  async prepare(root: string, runId: string): Promise<RunWorkspace> {
    root = resolve(root);
    await mkdir(root, {recursive: true});
    const runRoot = join(await realpath(root), runId);
    await mkdir(runRoot, {mode: 0o700});
    const workspace = join(runRoot, 'work');
    for (const directory of [workspace, join(runRoot, 'delivery'), join(runRoot, 'results')]) {
      await mkdir(directory, {mode: 0o700});
    }
    const rootInfo = await lstat(runRoot);
    const workInfo = await lstat(workspace);
    this.directories.set(runRoot, {rootDevice: rootInfo.dev, rootInode: rootInfo.ino,
      workDevice: workInfo.dev, workInode: workInfo.ino});
    return {root: runRoot, workspace};
  }

  async verifyWorkspace(workspace: RunWorkspace): Promise<boolean> {
    const identity = this.directories.get(workspace.root);
    if (!identity || workspace.workspace !== join(workspace.root, 'work')) return false;
    const root = await lstat(workspace.root);
    const work = await lstat(workspace.workspace);
    if (!root.isDirectory() || !work.isDirectory() || root.dev !== identity.rootDevice || root.ino !== identity.rootInode ||
      work.dev !== identity.workDevice || work.ino !== identity.workInode) return false;
    for (const execution of this.commands) {
      const path = relative(workspace.root, execution.workspace);
      if (path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
        if (!execution.closed || (execution.pid !== undefined && groupExists(execution.pid))) return false;
        this.commands.delete(execution);
      }
    }
    return true;
  }

  async copyInput(source: string, workspace: string, destination: string): Promise<void> {
    const target = workspacePath(workspace, destination);
    let parent = workspace;
    for (const part of destination.split('/').slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent, {recursive: true});
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Input parent is not a directory');
    }
    await writeFile(target, await readFile(source), {flag: 'wx'});
  }

  async command(command: Command, workspace: string, signal: AbortSignal,
    environment?: Readonly<Record<string, string | undefined>>): Promise<CommandResult> {
    if (signal.aborted) return {status: 'cancelled', exitCode: null, stdout: '', stderr: ''};
    return new Promise((resolveResult, reject) => {
      const child = spawn(command.executable, command.args, {cwd: workspace, detached: true,
        env: {...process.env, ...environment}, stdio: ['ignore', 'pipe', 'pipe']});
      const execution: CommandExecution = {workspace, closed: false, ...(child.pid === undefined ? {} : {pid: child.pid})};
      this.commands.add(execution);
      let stdout = ''; let stderr = '';
      let status: CommandResult['status'] = 'exited';
      let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (reason: 'cancelled' | 'timed_out') => {
        status = reason;
        try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            stderr += `\nCommand stop failed: ${String(error)}`;
          }
        }
        confirmationTimer ??= setTimeout(() => resolveResult({status: 'pending_verification',
          exitCode: child.exitCode, stdout, stderr: `${stderr}\nCommand group ${child.pid} stop is unconfirmed`}), 500);
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timed_out'), command.timeoutMs);
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text: string) => { stdout += text; });
      child.stderr.on('data', (text: string) => { stderr += text; });
      const cleanup = () => { clearTimeout(timer); clearTimeout(confirmationTimer); signal.removeEventListener('abort', abort); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup(); execution.closed = true;
        try {
          const pending = child.pid !== undefined && groupExists(child.pid);
          if (!pending) this.commands.delete(execution);
          resolveResult({status: pending ? 'pending_verification' : status, exitCode: code, stdout,
            stderr: pending ? `${stderr}\nCommand group ${child.pid} remains active` : stderr});
        } catch (error) { reject(error); }
      });
    });
  }

  async fileExists(workspace: string, path: string): Promise<boolean> {
    const entries = await inventory(workspace);
    return entries.some(entry => entry.kind === 'file' && entry.path === path);
  }

  async publish(request: PublicationRequest): Promise<Publication> {
    const destination = join(request.root, 'delivery', `v${request.version}`);
    const stage = `${destination}.${randomUUID()}.partial`;
    await mkdir(stage);
    const entries = await inventory(request.workspace);
    for (const entry of entries) {
      const target = workspacePath(stage, entry.path);
      if (entry.kind === 'directory') await mkdir(target);
      else {
        await copyFile(workspacePath(request.workspace, entry.path), target);
        await chmod(target, entry.executable ? 0o700 : 0o600);
      }
    }
    const captured = await inventory(stage);
    if (JSON.stringify(entries) !== JSON.stringify(captured)) throw new Error('Source changed during simulated capture');
    // Exclusive reservation; even an empty or failed version is never overwritten.
    await mkdir(destination);
    await rename(stage, join(destination, 'content'));
    const publication = publicationSchema.parse({runId: request.runId, sessionId: request.sessionId,
      version: request.version, directory: join(destination, 'content'), entries: captured});
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(publication), {flag: 'wx'});
    return publication;
  }

  async verify(publication: Publication): Promise<boolean> {
    const manifest = publicationSchema.parse(JSON.parse(await readFile(join(publication.directory, '..', 'manifest.json'), 'utf8')));
    return JSON.stringify(manifest) === JSON.stringify(publication) &&
      JSON.stringify(await inventory(publication.directory)) === JSON.stringify(publication.entries);
  }

  async artifact(publication: Publication, path: string): Promise<FileArtifact> {
    if (!await this.verify(publication)) throw new Error('Publication changed');
    const entry = publication.entries.find(entry => entry.path === path && entry.kind === 'file');
    if (!entry || entry.kind !== 'file') throw new Error(`Missing file artifact: ${path}`);
    return {path, file: workspacePath(publication.directory, path), version: publication.version,
      sha256: entry.sha256, size: entry.size};
  }

  async saveRun(run: TaskRun): Promise<void> {
    const stage = join(run.root, `run.${randomUUID()}.partial`);
    await writeFile(stage, JSON.stringify(taskRunSchema.parse(run)), {flag: 'wx'});
    await rename(stage, join(run.root, 'run.json'));
  }

  async saveResult(root: string, result: TaskResult): Promise<void> {
    await writeFile(join(root, 'results', `v${result.version}.json`),
      JSON.stringify(taskResultSchema.parse(result)), {flag: 'wx'});
  }
}
