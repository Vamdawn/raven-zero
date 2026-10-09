import {z} from 'zod';
import {claimResponseSchema, clientCapabilitiesSchema, claimSchema, errorSchema, heartbeatSchema,
  progressSchema, resultReceiptSchema, serverResultSchema, serverTaskSchema} from '@raven-zero/contracts';
import type {ClientCapabilities, Heartbeat, Progress, ResultReceipt, ServerTask, TaskResult} from '@raven-zero/contracts';

export interface ClientTaskServer {
  heartbeat(capabilities: ClientCapabilities, signal?: AbortSignal): Promise<Heartbeat>;
  claim(waitMs: number, signal?: AbortSignal): Promise<ServerTask | null>;
  progress(runId: string, progress: Progress, signal?: AbortSignal): Promise<ServerTask>;
  reportResult(result: TaskResult, signal?: AbortSignal): Promise<ResultReceipt>;
}

export class HttpTaskServer implements ClientTaskServer {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async heartbeat(capabilities: ClientCapabilities, signal?: AbortSignal): Promise<Heartbeat> {
    return this.post('/heartbeat', clientCapabilitiesSchema.parse(capabilities), heartbeatSchema, signal);
  }
  async claim(waitMs: number, signal?: AbortSignal): Promise<ServerTask | null> {
    return (await this.post('/claim', claimSchema.parse({waitMs}), claimResponseSchema, signal)).assignment;
  }
  async progress(runId: string, progress: Progress, signal?: AbortSignal): Promise<ServerTask> {
    return this.post(`/runs/${z.uuid().parse(runId)}/progress`, progressSchema.parse(progress), serverTaskSchema, signal);
  }
  async reportResult(result: TaskResult, signal?: AbortSignal): Promise<ResultReceipt> {
    return this.post('/results', serverResultSchema.parse(result), resultReceiptSchema, signal);
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {method: 'POST',
      headers: {authorization: `Bearer ${this.token}`, 'content-type': 'application/json'},
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35_000)]) : AbortSignal.timeout(35_000)});
    const input: unknown = await response.json();
    if (!response.ok) {
      const error = errorSchema.parse(input);
      throw new Error(`HTTP ${response.status} ${error.code}: ${error.message}`);
    }
    return schema.parse(input);
  }
}
