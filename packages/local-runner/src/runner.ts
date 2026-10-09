import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {dirname} from 'node:path';
import {agentObservationSchema, commandResultSchema, fileArtifactSchema, jsonValueSchema, publicationSchema, sessionSchema,
  taskRunSchema, taskSchema, taskResultSchema} from '@raven-zero/contracts';
import type {AgentSession, CheckResult, FileArtifact, Publication, RunStatus, TaskResult, TaskRun} from '@raven-zero/contracts';
import type {RunnerOptions} from './dependencies.js';
import {DeliveryFailure} from './dependencies.js';
import {workspacePath} from './node_files.js';

const NEXT: Partial<Record<RunStatus, readonly RunStatus[]>> = {
  created: ['initializing'], initializing: ['working'],
  working: ['waiting_for_input', 'completion_candidate'],
  waiting_for_input: ['working', 'completion_candidate'],
  completion_candidate: ['stop_requested'], stop_requested: ['stop_confirmed'],
  stop_confirmed: ['publishing', 'saving_result', 'working'], publishing: ['published'],
  published: ['checking_before'], checking_before: ['delivering', 'saving_result'],
  delivering: ['checking_after', 'saving_result'], checking_after: ['saving_result'],
  saving_result: ['succeeded', 'failed', 'cancelled', 'expired'],
  succeeded: ['working'], failed: ['working'], cancelled: ['working'], expired: ['working'],
  pending_verification: ['working'],
};
const TERMINAL: readonly RunStatus[] = ['succeeded', 'failed', 'cancelled', 'expired', 'pending_verification'];

/** Owns one run. Every advance saves a separate phase before the next effect.
 * Dependencies remain caller-owned. Snapshots cannot mutate the execution.
 * execute returns at local input/working waits; it never approves interaction.
 */
export class LocalTaskRunner {
  private controller = new AbortController();
  private stopIntent: 'cancelled' | 'expired' | undefined;
  private active: Promise<TaskRun> | undefined;
  private execution: Promise<TaskRun> | undefined;
  private constructor(private run: TaskRun, private readonly options: RunnerOptions) {}

  static async create(input: unknown, options: RunnerOptions): Promise<LocalTaskRunner> {
    const task = taskSchema.parse(input);
    if (task.agent.name !== options.agent.name) throw new Error('Agent capability is unavailable');
    if (task.delivery && task.delivery.component !== options.delivery?.name) throw new Error('Delivery component is unavailable');
    for (const step of task.initialization) if (step.kind === 'file') workspacePath('/workspace', step.destination);
    for (const check of [...task.checks.before, ...task.checks.after]) if (check.kind === 'file') workspacePath('/workspace', check.path);
    for (const path of task.artifacts) workspacePath('/workspace', path);
    const id = randomUUID();
    const workspace = await options.files.prepare(options.root, id);
    const startedAt = Date.now();
    const run = taskRunSchema.parse({id, task, ...workspace, version: 1, status: 'created', history: ['created'],
      isolation: options.agent.isolation === 'simulated' && options.files.isolation === 'simulated' ? 'simulated' : 'pending_verification',
      startedAt, ...(task.timeoutMs ? {deadlineAt: startedAt + task.timeoutMs} : {}),
      output: null, publications: [], checks: [], results: []});
    const runner = new LocalTaskRunner(run, options);
    await runner.persist();
    return runner;
  }

  snapshot(): TaskRun { return taskRunSchema.parse(this.run); }

  /** Loads retained delivery progress; dependencies must reverify their ownership. */
  static async restoreDelivery(input: unknown, options: RunnerOptions): Promise<LocalTaskRunner> {
    const run = taskRunSchema.parse(input);
    if (run.task.agent.name !== options.agent.name || !run.task.delivery ||
      run.task.delivery.component !== options.delivery?.name) throw new Error('Retained delivery capability is unavailable');
    if (dirname(run.root) !== await realpath(options.root)) throw new Error('Retained run is outside the configured root');
    const runner = new LocalTaskRunner(run, options);
    await runner.recoverDelivery();
    return runner;
  }

  /** Requests cancellation and closes input. Caller must advance/execute to
   * obtain stop confirmation; cancellation never publishes a new version.
   * It can interrupt an active Agent observation or command via AbortSignal.
   */
  async cancel(): Promise<TaskRun> {
    if (TERMINAL.includes(this.run.status)) throw new Error(`Cannot cancel ${this.run.status}`);
    this.stopIntent = 'cancelled';
    this.controller.abort();
    if (this.execution) await this.execution;
    else if (this.active) await this.active;
    if (TERMINAL.includes(this.run.status)) return this.snapshot();
    return this.exclusive(async () => {
      if (this.run.status !== 'stop_requested') await this.requestStop('cancelled');
      else { this.run.stopReason = 'cancelled'; await this.persist(); }
      return this.snapshot();
    });
  }

  /** Explicitly continues the same session/workspace; never initializes again.
   * Old publications/results remain immutable. Failed verification preserves the
   * run for inspection, rather than substituting a new Agent identity.
   */
  async resume(): Promise<TaskRun> {
    return this.exclusive(() => this.resumeOnce());
  }

  /** Continues delivery of the retained version without reopening Agent input. */
  async recoverDelivery(): Promise<TaskRun> {
    return this.exclusive(async () => {
      const lostTransition = this.run.status === 'checking_after' &&
        !this.run.checks.some(check => check.stage === 'after');
      if (this.run.status !== 'delivering' && !lostTransition &&
        !(this.run.status === 'pending_verification' && this.run.pendingFrom === 'delivering')) {
        throw new Error(`Cannot recover delivery from ${this.run.status}`);
      }
      try {
        if (this.run.isolation !== 'simulated' || this.options.agent.isolation !== 'simulated' ||
          this.options.files.isolation !== 'simulated' || !await this.options.files.verifyWorkspace(this.run) ||
          !await this.options.agent.verify(this.session())) return await this.pending('Delivery boundary or original session could not be verified');
        await this.publication();
        const checks = this.run.checks.filter(check => check.stage === 'before');
        if (checks.length !== this.run.task.checks.before.length || checks.some((result, index) =>
          !result.passed || JSON.stringify(result.check) !== JSON.stringify(this.run.task.checks.before[index]))) {
          return await this.pending('Before checks do not belong to the retained publication');
        }
        this.controller = new AbortController();
        this.stopIntent = undefined;
        delete this.run.reason;
        delete this.run.pendingFrom;
        // Recovery continues the same version, rather than a state-machine replay of Agent work.
        this.run.status = 'delivering';
        this.run.history.push('delivering');
        await this.persist();
        return this.snapshot();
      } catch (error) {
        return await this.pending(error instanceof Error ? error.message : String(error));
      }
    });
  }

  private async resumeOnce(): Promise<TaskRun> {
    if (!TERMINAL.includes(this.run.status)) throw new Error(`Cannot resume ${this.run.status}`);
    try {
      if (!await this.options.files.verifyWorkspace({root: this.run.root, workspace: this.run.workspace})) {
        return await this.pending('Original workspace or command execution could not be verified');
      }
      if (this.run.status === 'pending_verification' && this.run.session) {
        await this.requestStop(this.run.stopReason ?? 'failure');
        if (!await this.options.agent.confirmStop(this.session())) return await this.pending('Original Agent stop is unconfirmed');
        await this.move('stop_confirmed');
      }
      if (this.run.isolation !== 'simulated' || !await this.options.agent.verify(this.session())) {
        return await this.pending('Original session/workspace or boundary could not be verified');
      }
      for (const publication of this.run.publications) {
        if (!await this.options.files.verify(publication)) return await this.pending('Previous publication changed');
      }
      this.run.version++;
      this.run.output = null;
      this.run.checks = [];
      delete this.run.delivery;
      delete this.run.reason;
      delete this.run.stopReason;
      delete this.run.pendingFrom;
      if (this.run.task.timeoutMs) this.run.deadlineAt = Date.now() + this.run.task.timeoutMs;
      this.controller = new AbortController();
      this.stopIntent = undefined;
      // Persist the new generation before opening the existing session's input.
      await this.move('working');
      await this.options.agent.resume(this.session());
      return this.snapshot();
    } catch (error) {
      return await this.pending(error instanceof Error ? error.message : String(error));
    }
  }

  async execute(): Promise<TaskRun> {
    if (this.execution) throw new Error('Another automatic execution is active');
    this.execution = this.executeOnce();
    try { return await this.execution; }
    finally { this.execution = undefined; }
  }

  private async executeOnce(): Promise<TaskRun> {
    while (!TERMINAL.includes(this.run.status)) {
      const previous = this.run.status;
      await this.advance();
      if ((previous === 'working' || previous === 'waiting_for_input') && this.run.status === 'working') break;
      if (this.run.status === 'waiting_for_input') break;
    }
    return this.snapshot();
  }

  async advance(): Promise<TaskRun> {
    return this.exclusive(async () => {
      const remaining = this.run.deadlineAt === undefined ? undefined : this.run.deadlineAt - Date.now();
      const expire = () => {
        if (!this.stopIntent) this.stopIntent = 'expired';
        this.controller.abort();
      };
      if (remaining !== undefined && remaining <= 0) expire();
      const timer = remaining !== undefined && remaining > 0 ? setTimeout(expire, remaining) : undefined;
      try { return await this.advanceOnce(); }
      finally { clearTimeout(timer); }
    });
  }

  private async advanceOnce(): Promise<TaskRun> {
    if (TERMINAL.includes(this.run.status)) throw new Error(`Cannot advance ${this.run.status}`);
    try {
      if (this.run.isolation !== 'simulated') return await this.pending('Writing boundary has not been established');
      if (this.stopIntent && !['stop_requested', 'stop_confirmed', 'saving_result'].includes(this.run.status)) {
        await this.requestStop(this.stopIntent);
        return this.snapshot();
      }
      if (this.stopIntent) this.run.stopReason = this.stopIntent;
      switch (this.run.status) {
        case 'created': await this.move('initializing'); break;
        case 'initializing': {
          if (this.run.task.delivery && this.options.delivery?.initialize) {
            await this.options.delivery.initialize({root: this.run.root, workspace: this.run.workspace},
              this.run.task.delivery.parameters, this.controller.signal);
          }
          for (const step of this.run.task.initialization) {
            if (step.kind === 'file') await this.options.files.copyInput(step.source, this.run.workspace, step.destination);
            else {
              const result = commandResultSchema.parse(await this.options.files.command(step.command, this.run.workspace, this.controller.signal));
              if (result.status === 'pending_verification') return await this.pending(`Initialization command stop is unconfirmed: ${result.stderr}`);
              if (result.status !== 'exited' || result.exitCode !== 0) {
                this.run.reason = `Initialization command failed (${result.status}, exit ${result.exitCode}): ${result.stderr}`;
                await this.requestStop(this.stopIntent ?? 'failure');
                return this.snapshot();
              }
            }
          }
          if (this.stopIntent) {
            await this.requestStop(this.stopIntent);
            return this.snapshot();
          }
          const session = sessionSchema.parse(await this.options.agent.start(this.run.task, this.run.workspace));
          if (session.workspace !== this.run.workspace) throw new Error('Agent workspace mismatch');
          this.run.session = session;
          await this.move('working'); break;
        }
        case 'working': case 'waiting_for_input': {
          const observation = agentObservationSchema.parse(await this.options.agent.observe(this.session(), this.run.version, this.controller.signal));
          if (observation.status === 'completion_candidate') {
            this.run.output = observation.output;
            delete this.run.reason;
          } else if (observation.status === 'waiting_for_input') this.run.reason = observation.reason;
          await this.move(observation.status); break;
        }
        case 'completion_candidate':
          await this.requestStop('completion'); break;
        case 'stop_requested':
          if (this.run.session && !await this.options.agent.confirmStop(this.session())) return await this.pending('Agent stop is unconfirmed');
          await this.move('stop_confirmed'); break;
        case 'stop_confirmed': await this.move(this.run.stopReason === 'completion' ? 'publishing' : 'saving_result'); break;
        case 'publishing': {
          const publication = publicationSchema.parse(await this.options.files.publish({root: this.run.root,
            workspace: this.run.workspace, runId: this.run.id, sessionId: this.session().id, version: this.run.version}));
          if (publication.runId !== this.run.id || publication.sessionId !== this.session().id || publication.version !== this.run.version ||
            !await this.options.files.verify(publication)) return await this.pending('Publication is incomplete or has the wrong identity');
          this.run.publications.push(publication);
          await this.move('published'); break;
        }
        case 'published': await this.move('checking_before'); break;
        case 'checking_before': await this.check('before'); break;
        case 'delivering': {
          const publication = await this.publication();
          if (this.run.task.delivery) {
            if (!this.options.delivery) throw new Error('Delivery component is unavailable');
            try {
              const evidence = await this.options.delivery.deliver(publication, this.run.task.delivery.parameters,
                this.controller.signal, {root: this.run.root,
                  ...(this.run.delivery === undefined ? {} : {evidence: this.run.delivery}), checkpoint: async evidence => {
                  this.run.delivery = jsonValueSchema.parse(evidence);
                  await this.persist();
                }});
              this.run.delivery = jsonValueSchema.parse(evidence);
            } catch (error) {
              if (!(error instanceof DeliveryFailure)) throw error;
              this.run.delivery = jsonValueSchema.parse(error.evidence);
              this.run.reason = error.message;
              this.run.stopReason = 'failure';
              await this.move('saving_result');
              break;
            }
          }
          await this.move('checking_after'); break;
        }
        case 'checking_after': await this.check('after'); break;
        case 'saving_result': {
          let status: TaskResult['status'] = this.run.stopReason === 'cancelled' || this.run.stopReason === 'expired'
            ? this.run.stopReason : this.run.stopReason === 'failure' || this.run.checks.some(check => !check.passed) ? 'failed' : 'succeeded';
          const artifacts: FileArtifact[] = [];
          if (status === 'succeeded') {
            const publication = await this.publication();
            for (const path of this.run.task.artifacts) {
              if (!publication.entries.some(entry => entry.kind === 'file' && entry.path === path)) {
                status = 'failed';
                this.run.reason = `Missing file artifact: ${path}`;
                artifacts.length = 0;
                break;
              }
              const artifact = fileArtifactSchema.parse(await this.options.files.artifact(publication, path));
              if (artifact.version !== this.run.version || artifact.path !== path || artifact.file !== workspacePath(publication.directory, path)) {
                throw new Error('File artifact does not belong to the published version');
              }
              artifacts.push(artifact);
            }
          }
          if (this.stopIntent) { status = this.stopIntent; artifacts.length = 0; }
          const result = taskResultSchema.parse({runId: this.run.id, taskId: this.run.task.id, version: this.run.version,
            status, output: this.run.output, checks: this.run.checks, artifacts,
            ...(this.run.delivery === undefined ? {} : {delivery: this.run.delivery}),
            ...(this.run.reason === undefined ? {} : {reason: this.run.reason})});
          await this.options.files.saveResult(this.run.root, result);
          this.run.results.push(result);
          await this.move(status); break;
        }
      }
    } catch (error) {
      if (this.stopIntent && error instanceof Error && error.name === 'AbortError' &&
        (this.run.status === 'working' || this.run.status === 'waiting_for_input')) {
        await this.requestStop(this.stopIntent);
        return this.snapshot();
      }
      return await this.pending(error instanceof Error ? error.message : String(error));
    }
    return this.snapshot();
  }

  private async check(stage: 'before' | 'after'): Promise<void> {
    const publication = await this.publication();
    for (const check of this.run.task.checks[stage]) {
      let result: CheckResult;
      if (check.kind === 'file') result = {stage, check, passed: await this.options.files.fileExists(publication.directory, check.path)};
      else {
        const command = commandResultSchema.parse(await this.options.files.command(check.command, publication.directory, this.controller.signal));
        if (command.status === 'pending_verification') {
          this.run.checks.push({stage, check, passed: false, command});
          await this.pending(`Check command stop is unconfirmed: ${command.stderr}`);
          return;
        }
        result = {stage, check, passed: command.status === 'exited' && command.exitCode === 0, command};
      }
      this.run.checks.push(result);
      await this.persist();
      if (!result.passed) {
        this.run.reason = `${stage} completion check failed`;
        await this.move('saving_result');
        return;
      }
    }
    await this.move(stage === 'before' ? 'delivering' : 'saving_result');
  }

  private session(): AgentSession {
    if (!this.run.session) throw new Error('Agent session has not been recorded');
    return {...this.run.session};
  }

  private async publication(): Promise<Publication> {
    const publication = this.run.publications.find(item => item.version === this.run.version);
    if (!publication || !await this.options.files.verify(publication)) throw new Error('Published version could not be verified');
    return structuredClone(publication);
  }

  private async move(status: RunStatus): Promise<void> {
    if (status !== this.run.status && status !== 'stop_requested' && !NEXT[this.run.status]?.includes(status)) {
      throw new Error(`Illegal transition ${this.run.status} -> ${status}`);
    }
    const previous = this.run.status;
    this.run.status = status;
    this.run.history.push(status);
    try { await this.persist(); }
    catch (error) {
      // A lost transition acknowledgment must keep its source phase recoverable.
      this.run.status = previous;
      this.run.history.pop();
      throw error;
    }
  }

  private async pending(reason: string): Promise<TaskRun> {
    if (this.run.status !== 'pending_verification') this.run.pendingFrom = this.run.status;
    this.run.reason = reason;
    this.run.status = 'pending_verification';
    this.run.history.push('pending_verification');
    await this.persist();
    return this.snapshot();
  }

  private async persist(): Promise<void> { await this.options.files.saveRun(this.snapshot()); }

  private async requestStop(reason: NonNullable<TaskRun['stopReason']>): Promise<void> {
    this.run.stopReason = reason;
    await this.move('stop_requested');
    if (this.run.session) await this.options.agent.requestStop(this.session());
  }

  private async exclusive(operation: () => Promise<TaskRun>): Promise<TaskRun> {
    if (this.active) throw new Error('Another run operation is active');
    this.active = operation();
    try { return await this.active; }
    finally { this.active = undefined; }
  }
}
