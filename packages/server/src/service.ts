import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {claimSchema, clientCapabilitiesSchema, progressSchema, registerClientSchema, serverIdSchema, serverResultSchema, submitTaskSchema} from '@raven-zero/contracts';
import {z} from 'zod';
import type {ClientCapabilities, Heartbeat, Progress, RegisterClient, ResultReceipt, ServerClient, ServerTask, Task, TaskResult} from '@raven-zero/contracts';

export class ServerError extends Error {
  constructor(readonly code: 'unauthorized' | 'not_found' | 'conflict' | 'invalid', message: string) {
    super(message);
  }
}

/** Persistence operations are atomic. The caller owns and closes the storage resource. */
export interface ServerStore {
  submit(task: Task, runId: string): Promise<ServerTask>;
  get(taskId: string): Promise<ServerTask>;
  cancel(taskId: string): Promise<ServerTask>;
  registerClient(client: RegisterClient, tokenHash: string): Promise<ServerClient>;
  revokeClient(clientId: string): Promise<ServerClient>;
  heartbeat(tokenHash: string, capabilities: ClientCapabilities): Promise<Heartbeat>;
  claim(tokenHash: string): Promise<ServerTask | null>;
  progress(tokenHash: string, runId: string, progress: Progress): Promise<ServerTask>;
  reportResult(tokenHash: string, result: TaskResult): Promise<ResultReceipt>;
}

export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/** Framework-independent single-task service. Never closes caller-owned storage. */
export class TaskServer {
  constructor(private readonly store: ServerStore) {}

  async submit(input: unknown): Promise<ServerTask> {
    return this.store.submit(submitTaskSchema.parse(input), randomUUID());
  }

  async get(taskId: string): Promise<ServerTask> {
    return this.store.get(serverIdSchema.parse(taskId));
  }

  /** Queued tasks stop immediately; assigned tasks retain ownership and capacity until confirmed. */
  async cancel(taskId: string): Promise<ServerTask> {
    return this.store.cancel(serverIdSchema.parse(taskId));
  }

  async registerClient(input: unknown): Promise<{client: ServerClient; token: string}> {
    const token = randomBytes(32).toString('base64url');
    const client = await this.store.registerClient(registerClientSchema.parse(input), tokenHash(token));
    return {client, token};
  }

  async revokeClient(clientId: string): Promise<ServerClient> {
    return this.store.revokeClient(serverIdSchema.parse(clientId));
  }

  async heartbeat(token: string, input: unknown): Promise<Heartbeat> {
    return this.store.heartbeat(tokenHash(token), clientCapabilitiesSchema.parse(input));
  }

  async progress(token: string, runId: string, input: unknown): Promise<ServerTask> {
    return this.store.progress(tokenHash(token), z.uuid().parse(runId), progressSchema.parse(input));
  }

  async reportResult(token: string, input: unknown): Promise<ResultReceipt> {
    return this.store.reportResult(tokenHash(token), serverResultSchema.parse(input));
  }

  /** Long polling is bounded; abort stops waiting, never unassigns a committed claim. */
  async claim(token: string, waitMs: number, signal?: AbortSignal): Promise<ServerTask | null> {
    claimSchema.parse({waitMs});
    const deadline = Date.now() + waitMs;
    for (;;) {
      signal?.throwIfAborted();
      const assignment = await this.store.claim(tokenHash(token));
      if (assignment || Date.now() >= deadline) return assignment;
      await setTimeout(Math.min(100, deadline - Date.now()), undefined, {signal});
    }
  }
}
