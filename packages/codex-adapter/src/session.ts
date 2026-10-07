import {mkdir, lstat, realpath, writeFile, readFile, readdir} from 'node:fs/promises';
import {join, relative, isAbsolute, basename} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {BOUNDARY, command, sync} from './native.js';
import {launchScope, stopScope, platformCheck} from './mac_scope.js';
import type {ScopeRecord, StopResult} from './mac_scope.js';
import {startProtectedEgress} from './protected_egress.js';
import type {ProtectedEgress} from './protected_egress.js';
import {seatbeltProfile} from './seatbelt.js';
import {Rpc} from './rpc.js';
import type {Message} from './rpc.js';
import {startNativeGate} from './native_gate.js';
import type {NativeGate} from './native_gate.js';
import {publish, recoverPublication} from './publication.js';
import type {Publication} from './publication.js';
import type {TurnStartParams} from './protocol/v2/TurnStartParams.js';

const threadResponse = z.looseObject({thread: z.looseObject({id: z.string(), cwd: z.string(),
  turns: z.array(z.looseObject({id: z.string(), status: z.string()})).optional()})});
const LOCKED_CONFIG: Readonly<Record<string, boolean>> = {
  'features.apps': false, 'features.plugins': false, 'features.hooks': false,
  'features.remote_plugin': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.browser_use': false, 'features.computer_use': false, 'features.in_app_local_automation': false,
  'features.shell_snapshot': false,
};

export interface SessionOptions {
  readonly run: string;
  readonly generation: number;
  readonly work: string;
  readonly home: string;
  /** Existing framework-owned root, outside the task workspace and Home. */
  readonly root: string;
  readonly codex: string;
  readonly model: string;
  readonly upstreamProxy?: string;
  /** Already-created task identity, owned by caller's execution record.
   * Creation is a separate pre-admission step; this package never borrows a
   * personal conversation or grants write access to all personal rollouts.
   */
  readonly thread: string;
}

export interface FinishResult {
  readonly status: 'published' | 'waiting' | 'pending_verification';
  readonly publication?: Publication;
  readonly reason?: string;
}

/** Owns only this generation's app-server, native gate and model relay.
 * Execution records/SQLite, scheduler deadlines and checks belong to caller.
 * The caller persists scope, identity and publication before releasing a slot.
 */
export class CodexSession {
  private readonly pendingRequests = new Set<string | number>();
  private completed = false;
  private active = false;
  private failure: string | undefined;
  private inputClosed = false;
  private resourcesClosed = false;
  private cancelRequested = false;
  private stopPromise: Promise<StopResult> | undefined;
  private finishPromise: Promise<FinishResult> | undefined;
  private constructor(readonly options: SessionOptions, readonly scope: ScopeRecord,
    readonly thread: string, private readonly rpc: Rpc, private readonly gate: NativeGate,
    private readonly egress: ProtectedEgress) {}

  get modelScope(): ScopeRecord { return this.egress.scope; }
  get nativeEndpoint(): string { return this.gate.endpoint; }
  get unresolvedRequests(): readonly (string | number)[] { return [...this.pendingRequests]; }

  static async open(input: SessionOptions): Promise<CodexSession> {
    await platformCheck();
    z.strictObject({run: z.string().min(1), generation: z.number().int().positive(),
      thread: z.string().uuid()}).parse({run: input.run, generation: input.generation, thread: input.thread});
    const options: SessionOptions = {...input, work: await realpath(input.work),
      home: await realpath(input.home), root: await realpath(input.root)};
    function contains(parent: string, child: string): boolean {
      const path = relative(parent, child);
      return path === '' || (!path.startsWith('..') && !isAbsolute(path));
    }
    if (contains(options.work, options.root) || contains(options.home, options.root) ||
        contains(options.root, options.home) || contains(options.home, options.work)) {
      throw new Error('Protected root/Home/task workspace overlap');
    }
    if (contains(options.work, await realpath(BOUNDARY)) || contains(options.work, await realpath(process.execPath))) {
      throw new Error('Trusted adapter/runtime installation is inside the Agent workspace');
    }
    if (await command(options.codex, ['--version']) !== 'codex-cli 0.155.1') throw new Error('Unverified Codex version');
    const rollouts: string[] = [];
    for (const subdirectory of ['sessions', 'archived_sessions']) {
      const directory = join(options.home, subdirectory);
      await mkdir(directory, {recursive: true, mode: 0o700});
      for (const entry of await readdir(directory, {recursive: true, withFileTypes: true})) {
        if (entry.isFile() && entry.name.endsWith(`-${options.thread}.jsonl`)) {
          rollouts.push(join(entry.parentPath, entry.name));
        }
      }
    }
    if (rollouts.length !== 1 || !rollouts[0]) throw new Error('Owned task rollout could not be uniquely located');
    const archived = rollouts[0].startsWith(`${join(options.home, 'archived_sessions')}/`);
    const meta = z.looseObject({type: z.literal('session_meta'), payload: z.looseObject({id: z.string(), cwd: z.string()})}).parse(
      JSON.parse((await readFile(rollouts[0], 'utf8')).split('\n')[0] ?? ''));
    if (meta.payload.id !== options.thread || await realpath(meta.payload.cwd) !== options.work) throw new Error('Task rollout/workspace mismatch');
    // Resume moves an archived rollout into its date directory; archive moves
    // it back. Both names refer only to the exact owned identity.
    const name = basename(rollouts[0]);
    const date = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
    if (!date?.[1] || !date[2] || !date[3]) throw new Error('Unverified rollout path format');
    const activeDirectory = join(options.home, 'sessions', date[1], date[2], date[3]);
    await mkdir(activeDirectory, {recursive: true, mode: 0o700});
    rollouts.push(join(activeDirectory, name), join(options.home, 'archived_sessions', name));
    const execution = join(options.root, `execution-${options.generation}`);
    const delivery = join(options.root, 'delivery');
    const sqlite = join(options.root, 'codex-state');
    await mkdir(delivery, {recursive: true, mode: 0o700});
    await mkdir(sqlite, {recursive: true, mode: 0o700});
    await mkdir(join(options.home, 'app-server-control'), {recursive: true, mode: 0o700});
    await mkdir(execution, {mode: 0o700});
    const temporary = join(execution, 'tmp');
    await mkdir(temporary, {mode: 0o700});
    await sync(execution); await sync(options.root);
    const privateEndpoint = join(execution, 'codex.sock');
    const endpoint = join(execution, 'native.sock');
    if (Buffer.byteLength(privateEndpoint) >= 104 || Buffer.byteLength(endpoint) >= 104) {
      throw new Error('Unix socket path exceeds macOS limit; use a shorter runtime root');
    }
    const egress = await startProtectedEgress(join(execution, 'model'), options.upstreamProxy);
    let agentAdmissionAttempted = false;
    let scope: ScopeRecord | undefined;
    let rpc: Rpc | undefined;
    let gate: NativeGate | undefined;
    const state = {observe(_message: Message): void {}};
    // Keep events received before thread/resume returns, rather than lose a
    // pending request when a native observer attaches later.
    const buffered: Message[] = [];
    state.observe = message => { buffered.push(message); };
    try {
      const policyPath = join(execution, 'boundary.sb');
      // The protected execution root includes proof and policy; only its
      // explicit tmp/socket exceptions may be written by Agent.
      const profile = seatbeltProfile({work: options.work, home: options.home, sqlite, temporary, rollouts, thread: options.thread,
        endpoint: privateEndpoint, protected: [delivery, join(execution, 'scope'), join(execution, 'model'), policyPath, endpoint],
        egressPort: egress.port});
      await writeFile(policyPath, profile, {flag: 'wx', mode: 0o600});
      await sync(policyPath); await sync(execution);
      const environment: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? options.home,
        LANG: 'en_US.UTF-8', CODEX_HOME: options.home, TMPDIR: temporary,
        HTTP_PROXY: `http://127.0.0.1:${egress.port}`, HTTPS_PROXY: `http://127.0.0.1:${egress.port}`,
        http_proxy: `http://127.0.0.1:${egress.port}`, https_proxy: `http://127.0.0.1:${egress.port}`,
        NO_PROXY: '', no_proxy: '', ALL_PROXY: '', all_proxy: '',
      };
      agentAdmissionAttempted = true;
      scope = await launchScope(join(execution, 'scope'), '/usr/bin/sandbox-exec',
        ['-f', policyPath, options.codex, 'app-server', '--listen', `unix://${privateEndpoint}`,
          '-c', 'check_for_update_on_startup=false', '-c', `sqlite_home=${JSON.stringify(sqlite)}`,
          ...Object.keys(LOCKED_CONFIG).flatMap(key => ['-c', `${key}=false`])],
        environment, options.work);
      for (let tries = 0; tries < 1_200; tries++) {
        try { await lstat(privateEndpoint); break; } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (tries === 1_199) throw new Error('Codex endpoint did not start');
        await delay(50);
      }
      rpc = await Rpc.connect(privateEndpoint, message => state.observe(message), options.home);
      const config = z.looseObject({config: z.looseObject({sqlite_home: z.string(), mcp_servers: z.record(z.string(), z.unknown()).optional()})}).parse(
        await rpc.call('config/read', {includeLayers: false}));
      if (await realpath(config.config.sqlite_home) !== sqlite) throw new Error('Runtime database override was not honored');
      const locked: Record<string, boolean | string> = {...LOCKED_CONFIG, sqlite_home: sqlite};
      for (const name of Object.keys(config.config.mcp_servers ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Unverified MCP configuration key');
        locked[`mcp_servers.${name}.enabled`] = false;
      }
      if (archived) await rpc.call('thread/unarchive', {threadId: options.thread});
      const response = threadResponse.parse(await rpc.call('thread/resume', {
        threadId: options.thread, cwd: options.work, runtimeWorkspaceRoots: [options.work], model: options.model,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', config: locked,
      }));
      if (response.thread.id !== options.thread || await realpath(response.thread.cwd) !== options.work) {
        throw new Error('Codex returned a different session identity/workspace');
      }
      gate = await startNativeGate(endpoint, privateEndpoint, response.thread.id, locked, options.work);
      const session = new CodexSession(options, scope, response.thread.id, rpc, gate, egress);
      state.observe = message => session.observe(message);
      for (const message of buffered) state.observe(message);
      return session;
    } catch (error) {
      if (gate) await gate.close();
      if (rpc) rpc.close();
      const stop = scope ? await stopScope(scope, 0) : undefined;
      if (!agentAdmissionAttempted || stop?.status === 'confirmed') await egress.close();
      throw new Error(`Codex launch failed; scope=${stop?.status ?? 'unknown'}; preserve ${execution}`, {cause: error});
    }
  }

  private observe(message: Message): void {
    if (!message.method) return;
    if (message.method === 'turn/started' || message.method === 'turn/completed') {
      const params = z.looseObject({threadId: z.string(), turn: z.looseObject({id: z.string(), status: z.string()})}).parse(message.params);
      if (params.threadId !== this.thread) throw new Error('Unexpected task event');
      this.active = message.method === 'turn/started';
      this.completed = message.method === 'turn/completed' && params.turn.status === 'completed';
      this.failure = message.method === 'turn/completed' && !this.completed ? `Codex turn ${params.turn.status}; preserve workspace` : undefined;
      if (message.method === 'turn/completed') this.gate.completeTurn(params.turn.id);
    } else if (message.method === 'serverRequest/resolved') {
      const params = z.looseObject({threadId: z.string(), requestId: z.union([z.string(), z.number()])}).parse(message.params);
      if (params.threadId === this.thread) this.pendingRequests.delete(params.requestId);
    } else if (message.id !== undefined) {
      const params = z.looseObject({threadId: z.string().optional()}).parse(message.params);
      if (params.threadId === this.thread || params.threadId === undefined) this.pendingRequests.add(message.id);
    }
  }

  async startTurn(params: Omit<TurnStartParams, 'threadId'>): Promise<unknown> {
    if (this.inputClosed) throw new Error('Session input already closed');
    if (params.environments?.length) throw new Error('Remote environment outside task scope');
    this.active = true; this.completed = false; this.failure = undefined;
    return this.rpc.call('turn/start', {...params, threadId: this.thread, cwd: this.options.work, runtimeWorkspaceRoots: [this.options.work],
      ...((!params.sandboxPolicy || params.sandboxPolicy.type === 'workspaceWrite') && !params.permissions ? {sandboxPolicy: {type: 'externalSandbox', networkAccess: 'enabled'}} : {})});
  }

  /** Serialized finish; returns waiting without answering requests or closing
   * their native UI. After cutover, any uncertainty is pending verification.
   */
  finish(): Promise<FinishResult> {
    if (!this.finishPromise) this.finishPromise = this.finishOnce().then(result => {
      if (result.status === 'waiting') this.finishPromise = undefined;
      return result;
    });
    return this.finishPromise;
  }

  private async finishOnce(): Promise<FinishResult> {
    try { this.rpc.assertHealthy(); } catch (error) {
      return this.verification(error instanceof Error ? error.message : String(error));
    }
    if (this.failure) return this.verification(this.failure);
    if (!this.completed || this.active || this.pendingRequests.size || this.gate.hasUnfinishedInput) return {status: 'waiting'};
    this.gate.closeInput(); this.inputClosed = true;
    try {
      this.rpc.assertHealthy();
      const response = threadResponse.parse(await this.rpc.call('thread/read', {threadId: this.thread, includeTurns: true}));
      const latest = response.thread.turns?.at(-1);
      if (!latest || latest.status !== 'completed' || this.active || this.pendingRequests.size) {
        throw new Error('Native input raced finish or a request remains unresolved');
      }
      const stopped = await this.stopResources();
      if (stopped.status !== 'confirmed') throw new Error(stopped.reason ?? 'Stop not confirmed');
      if (this.active || this.pendingRequests.size || !this.completed) throw new Error('Task changed while stopping; verify before publication');
      if (this.cancelRequested) throw new Error('Cancellation takes precedence over publication');
      const identity = {run: this.options.run, thread: this.thread, generation: this.options.generation};
      const delivery = join(this.options.root, 'delivery');
      const existing = await recoverPublication(delivery, identity);
      const publication = existing ?? await publish(this.options.work, delivery, identity);
      if (this.cancelRequested) throw new Error('Cancelled during publication; do not run checks');
      return {status: 'published', publication};
    } catch (error) {
      return this.verification(error instanceof Error ? error.message : String(error));
    }
  }

  private verification(reason: string): FinishResult {
    this.inputClosed = true; this.gate.closeInput();
    return {status: 'pending_verification', reason};
  }

  /** Used identically for user cancellation and caller-enforced deadlines.
   * A completed turn/interrupt response is never substituted for scope proof.
   */
  async cancel(): Promise<StopResult> {
    this.cancelRequested = true;
    return this.stopResources();
  }

  private stopResources(): Promise<StopResult> {
    this.inputClosed = true; this.gate.closeInput();
    this.stopPromise ??= this.stopOnce().then(result => {
      if (result.status === 'pending_verification') this.stopPromise = undefined;
      return result;
    });
    return this.stopPromise;
  }

  private async stopOnce(): Promise<StopResult> {
    const stopped = await stopScope(this.scope);
    if (!this.resourcesClosed) {
      this.resourcesClosed = true;
      this.rpc.close(); await this.gate.close();
    }
    if (stopped.status !== 'confirmed') return stopped;
    const relay = await this.egress.close();
    return relay.status === 'confirmed' ? stopped : relay;
  }

  /** Test ownership cleanup is explicit; normal production retains sessions. */
  async archive(): Promise<void> { await this.rpc.call('thread/archive', {threadId: this.thread}); }
}
