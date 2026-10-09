import {setTimeout} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {clientCapabilitiesSchema, progressSchema} from '@raven-zero/contracts';
import type {ClientCapabilities, ServerTask, TaskRun} from '@raven-zero/contracts';
import {LocalTaskRunner} from '@raven-zero/local-runner';
import type {FileExecution, RunnerOptions} from '@raven-zero/local-runner';
import type {ClientTaskServer} from './http.js';
import type {ClientRecord, ClientStore} from './store.js';

export interface ClientOptions extends Omit<RunnerOptions, 'runId'> {
  readonly server: ClientTaskServer;
  readonly store: ClientStore;
  readonly slots?: number;
  readonly pollMs?: number;
}
const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

/** User-started reception manager. Waits retain their slot. Dependencies remain
 * caller-owned; closing a UI is not a stop confirmation.
 */
export class ClientManager {
  private accepting = false;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private readonly runners = new Map<string, LocalTaskRunner>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly recovering = new Set<string>();
  private readonly files: FileExecution;
  private readonly capabilities: ClientCapabilities;
  private readonly pollMs: number;
  private failure: unknown;
  private readonly connectionErrors = new Map<string, string>();
  private transport = new AbortController();
  private claimController = new AbortController();
  private wake = new AbortController();

  constructor(private readonly options: ClientOptions) {
    const files = options.files;
    this.files = {isolation: files.isolation,
      prepare: files.prepare.bind(files), verifyWorkspace: files.verifyWorkspace.bind(files),
      copyInput: files.copyInput.bind(files), command: files.command.bind(files),
      fileExists: files.fileExists.bind(files), publish: files.publish.bind(files),
      verify: files.verify.bind(files), artifact: files.artifact.bind(files),
      saveRun: async run => options.store.saveRun(run),
      saveResult: async (_root, result) => options.store.saveResult(result)};
    if (files.recoverPublication) this.files.recoverPublication = files.recoverPublication.bind(files);
    this.capabilities = clientCapabilitiesSchema.parse({agents: [options.agent.name],
      deliveryComponents: options.delivery ? [options.delivery.name] : [], slots: options.slots ?? 1});
    this.pollMs = options.pollMs ?? 1000;
    if (!Number.isInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 30_000) throw new Error('Invalid poll interval');
  }

  snapshot(): {accepting: boolean; connectionError: string | undefined; runs: ClientRecord[]} {
    return {accepting: this.accepting, connectionError: [...this.connectionErrors.values()].join('; ') || undefined,
      runs: this.options.store.list()};
  }

  /** Runs reception, observations and retries until stopped or drained. Caller
   * must own/await the returned Promise; local storage failures reject it.
   */
  start(): Promise<void> {
    if (this.loop) throw new Error('Client manager is already running');
    this.accepting = true;
    this.stopping = false;
    this.failure = undefined;
    this.runners.clear();
    this.transport = new AbortController();
    this.wake = new AbortController();
    this.loop = this.runLoop().finally(() => { this.loop = undefined; this.accepting = false; });
    return this.loop;
  }

  /** Stops new reception. The start Promise waits for existing work and receipts,
   * including local questions, offline reporting and pending verification.
   */
  stopAccepting(): void { this.accepting = false; this.claimController.abort(); this.wake.abort(); }

  /** Requests cancellation, or rechecks an earlier unconfirmed cancellation /
   * expiry. Returns only the observed state, never infers a full process stop.
   */
  async cancel(runId: string): Promise<TaskRun> {
    if (this.recovering.has(runId)) throw new Error('Run operation is active');
    const record = this.options.store.get(runId);
    if (!record?.run) throw new Error('No retained execution to stop');
    this.recovering.add(runId);
    try {
      const runner = this.runners.get(runId) ?? await LocalTaskRunner.restore(record.run, {...this.options, files: this.files});
      this.runners.set(runId, runner);
      const requested = await runner.cancel();
      return requested.status === 'stop_requested' ? await runner.execute() : requested;
    } finally { this.recovering.delete(runId); }
  }

  /** Explicit choice after interruption: continue retained progress or retry
   * Agent work in a new version. Saved results require server retry scheduling,
   * which is outside this single-run protocol.
   */
  async recover(runId: string, choice: 'continue' | 'retry'): Promise<TaskRun> {
    if (!this.loop || this.stopping) throw new Error('Start the manager before explicit recovery');
    if (this.active.has(runId) || this.recovering.has(runId)) throw new Error('Run operation is active');
    const record = this.options.store.get(runId);
    if (!record?.run) throw new Error('No retained execution; preserve the workspace for verification');
    if (record.run.results.length) throw new Error('Result already saved; server retry scheduling is required');
    if (record.assignment.cancellationRequested || record.run.stopReason === 'cancelled' || record.run.stopReason === 'expired') {
      throw new Error('Confirm cancellation or expiry before reopening Agent input');
    }
    this.recovering.add(runId);
    try {
      const runner = this.runners.get(runId) ?? await LocalTaskRunner.restore(record.run, {...this.options, files: this.files});
      this.runners.set(runId, runner);
      const source = record.run.pendingFrom ?? record.run.status;
      const run = choice === 'retry' ? await runner.resume() :
        source === 'delivering' || source === 'checking_after' ? await runner.recoverDelivery() : await runner.recover();
      if (run.status !== 'pending_verification') this.execute(runner);
      return run;
    } finally { this.recovering.delete(runId); }
  }

  /** Requests immediate stop, waits for available confirmations, preserves unknown
   * executions and unsent results. Does not close caller-owned resources.
   */
  async stop(): Promise<ClientRecord[]> {
    this.accepting = false;
    this.stopping = true;
    this.transport.abort();
    for (const runner of this.runners.values()) await this.stopRunner(runner);
    await this.loop;
    return this.options.store.list();
  }

  private async runLoop(): Promise<void> {
    try {
      for (const record of this.options.store.list()) {
        const run = record.run;
        if (run && !FINISHED.has(run.status) && run.status !== 'pending_verification' && !this.runners.has(run.id)) {
          this.options.store.saveRun({...run, status: 'pending_verification', pendingFrom: run.status,
            history: [...run.history, 'pending_verification'], reason: 'Explicit recovery required after client restart'});
        }
      }
      while (this.shouldContinue()) {
        await this.synchronize();
        for (const [id, runner] of this.runners) {
          const run = runner.snapshot();
          if (!FINISHED.has(run.status) && run.status !== 'pending_verification' && !this.active.has(id) && !this.recovering.has(id)) this.execute(runner);
        }
        if (this.failure) throw this.failure;
        if (this.accepting && this.occupied() < this.capabilities.slots) {
          this.claimController = new AbortController();
          const signal = AbortSignal.any([this.transport.signal, this.claimController.signal, this.wake.signal]);
          const assignment = await this.network('claim', () => this.options.server.claim(this.pollMs, signal));
          if (assignment) await this.receive(assignment);
        }
        if (this.shouldContinue()) {
          try { await setTimeout(this.pollMs, undefined, {signal: AbortSignal.any([this.transport.signal, this.wake.signal])}); }
          catch (error) { if (!this.stopping && !this.wake.signal.aborted) throw error; }
          finally { if (this.wake.signal.aborted) this.wake = new AbortController(); }
        }
      }
    } catch (error) {
      this.fail(error);
      throw this.failure;
    } finally {
      if (this.failure) {
        // Preserve the first storage failure even if stopping another execution
        // cannot persist. Cancellation aborts its Agent/command signal; unknown
        // stops remain pending rather than being inferred from loop shutdown.
        await Promise.allSettled([...this.runners.values()].map(runner => this.stopRunner(runner)));
      }
      await Promise.all(this.active.values());
    }
    if (this.failure) throw this.failure;
  }

  private occupied(): number {
    return this.options.store.list().filter(record => !record.run || !FINISHED.has(record.run.status)).length;
  }

  private shouldContinue(): boolean {
    return !this.stopping && (this.accepting || this.occupied() > 0 || this.options.store.pendingResults().length > 0);
  }

  private async synchronize(): Promise<void> {
    const heartbeat = await this.network('heartbeat', () => this.options.server.heartbeat({...this.capabilities,
      slots: this.accepting ? this.capabilities.slots : 0}, this.transport.signal));
    if (heartbeat) {
      for (const assignment of heartbeat.runs) {
        await this.receive(assignment);
        const runner = this.runners.get(assignment.runId);
        if (assignment.cancellationRequested && runner && !FINISHED.has(runner.snapshot().status) &&
          runner.snapshot().status !== 'pending_verification' && !this.recovering.has(assignment.runId)) await this.cancel(assignment.runId);
      }
    }
    for (const result of this.options.store.pendingResults()) {
      const key = `result:${result.runId}`;
      const record = this.options.store.get(result.runId);
      if (record?.assignment.cancellationRequested && (result.status === 'succeeded' || result.status === 'failed')) {
        const run = record.run;
        if (!run || run.version !== result.version || run.status !== result.status ||
          run.history.lastIndexOf('stop_confirmed') <= run.history.lastIndexOf('working')) {
          this.connectionErrors.set(key, 'Cancellation requires retained stop confirmation for this version');
          continue;
        }
        await this.network(`stop:${result.runId}`, () => this.options.server.progress(result.runId,
          {status: 'stop_confirmed'}, this.transport.signal));
        // A lost result receipt may mean the server is already terminal and
        // rejects progress. Replaying the immutable result retrieves its receipt;
        // a still-assigned server continues to require the stop confirmation.
      }
      const receipt = await this.network(key, () => this.options.server.reportResult(result, this.transport.signal));
      if (receipt) {
        const assignment = this.options.store.get(result.runId)?.assignment;
        if (receipt.task.runId !== result.runId || receipt.task.task.id !== result.taskId ||
          receipt.task.clientId !== assignment?.clientId ||
          receipt.task.status !== result.status || !isDeepStrictEqual(receipt.task.result, result)) {
          this.connectionErrors.set(key, 'Result receipt identity or content mismatch');
          continue;
        }
        this.options.store.saveAssignment(receipt.task);
        this.options.store.acknowledge(result);
        this.connectionErrors.delete(`progress:${result.runId}`);
        this.connectionErrors.delete(`stop:${result.runId}`);
      }
    }
    for (const record of this.options.store.list()) {
      const run = record.run;
      if (!run || FINISHED.has(run.status)) continue;
      await this.network(`progress:${run.id}`, () => this.options.server.progress(run.id, progressSchema.parse({status: run.status,
        ...(run.reason === undefined ? {} : {reason: run.reason.slice(0, 4096)})}), this.transport.signal));
    }
  }

  private async receive(assignment: ServerTask): Promise<void> {
    const known = this.options.store.get(assignment.runId);
    this.options.store.saveAssignment(assignment);
    if (known || this.stopping) return;
    const runner = await LocalTaskRunner.create(assignment.task, {...this.options, runId: assignment.runId, files: this.files});
    this.runners.set(assignment.runId, runner);
    if (this.stopping) {
      await runner.cancel();
      await runner.execute();
      return;
    }
    if (assignment.cancellationRequested) await runner.cancel();
    this.execute(runner);
  }

  private execute(runner: LocalTaskRunner): void {
    const id = runner.snapshot().id;
    const operation = (async () => {
      while (!this.stopping) {
        const run = runner.snapshot();
        if (FINISHED.has(run.status) || run.status === 'pending_verification') break;
        if (!this.recovering.has(id)) await runner.execute();
        const current = runner.snapshot();
        if (FINISHED.has(current.status) || current.status === 'pending_verification') break;
        const remaining = current.deadlineAt === undefined ? this.pollMs : current.deadlineAt - Date.now();
        try { await setTimeout(Math.max(1, Math.min(this.pollMs, remaining)), undefined, {signal: this.transport.signal}); }
        catch (error) { if (!this.stopping) throw error; }
      }
    })().catch(error => { this.fail(error); }).finally(() => {
      this.active.delete(id);
      this.wake.abort();
    });
    this.active.set(id, operation);
  }

  private fail(error: unknown): void {
    this.failure ??= error;
    this.accepting = false;
    this.stopping = true;
    this.transport.abort();
  }

  private async stopRunner(runner: LocalTaskRunner): Promise<void> {
    if (FINISHED.has(runner.snapshot().status) || runner.snapshot().status === 'pending_verification') return;
    await runner.cancel();
    if (!FINISHED.has(runner.snapshot().status) && runner.snapshot().status !== 'pending_verification') await runner.execute();
  }

  private async network<T>(key: string, operation: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await operation();
      this.connectionErrors.delete(key);
      return value;
    } catch (error) {
      if (!this.stopping && !(key === 'claim' && (!this.accepting || this.wake.signal.aborted))) {
        this.connectionErrors.set(key, error instanceof Error ? error.message : String(error));
      }
      return undefined;
    }
  }
}
