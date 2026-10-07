import WebSocket from 'ws';
import {z} from 'zod';
import {realpath} from 'node:fs/promises';
import type {InitializeParams} from './protocol/InitializeParams.js';
import type {ThreadResumeParams} from './protocol/v2/ThreadResumeParams.js';
import type {TurnStartParams} from './protocol/v2/TurnStartParams.js';
import type {TurnInterruptParams} from './protocol/v2/TurnInterruptParams.js';
import type {ThreadArchiveParams} from './protocol/v2/ThreadArchiveParams.js';
import type {ThreadUnarchiveParams} from './protocol/v2/ThreadUnarchiveParams.js';
import type {ThreadReadParams} from './protocol/v2/ThreadReadParams.js';
import type {ConfigReadParams} from './protocol/v2/ConfigReadParams.js';

interface Requests {
  'initialize': InitializeParams;
  'thread/resume': ThreadResumeParams;
  'turn/start': TurnStartParams;
  'turn/interrupt': TurnInterruptParams;
  'thread/archive': ThreadArchiveParams;
  'thread/unarchive': ThreadUnarchiveParams;
  'thread/read': ThreadReadParams;
  'config/read': ConfigReadParams;
}
const envelope = z.looseObject({method: z.string().optional(), id: z.union([z.string(), z.number()]).optional(),
  params: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional()});
export type Message = z.infer<typeof envelope>;
export function socketUrl(path: string): string {
  if (path.includes(':') || path.includes('?')) throw new Error('Unsupported Unix socket path');
  return `ws+unix:${path}:/`;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Owns one observer socket. Server requests remain for native UI to answer. */
export class Rpc {
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private failure: Error | undefined;
  private constructor(private readonly socket: WebSocket, private readonly observe: (message: Message) => void) {
    socket.on('message', data => {
      try {
        const message = envelope.parse(JSON.parse(data.toString()));
        if (!message.method && typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error !== undefined) pending.reject(new Error('Codex RPC rejected request', {cause: message.error}));
            else pending.resolve(message.result);
          }
        } else this.observe(message);
      } catch (error) { this.fail(new Error('Invalid Codex event', {cause: error})); }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('Codex observer disconnected')));
  }

  static async connect(endpoint: string, observe: (message: Message) => void, expectedHome?: string): Promise<Rpc> {
    const socket = new WebSocket(socketUrl(endpoint), {maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10_000});
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { socket.removeListener('error', reject); resolve(); });
      socket.once('error', reject);
    });
    const rpc = new Rpc(socket, observe);
    const initialized = await rpc.call('initialize', {clientInfo: {name: 'raven-zero', version: '0.0.0', title: 'Raven Zero'},
      capabilities: {experimentalApi: true, requestAttestation: false}});
    if (expectedHome !== undefined) {
      const result = z.looseObject({codexHome: z.string()}).parse(initialized);
      if (await realpath(result.codexHome) !== expectedHome) { rpc.close(); throw new Error('Unexpected Codex Home'); }
    }
    socket.send(JSON.stringify({method: 'initialized'}));
    return rpc;
  }

  assertHealthy(): void { if (this.failure) throw this.failure; }

  async call<M extends keyof Requests>(method: M, params: Requests[M]): Promise<unknown> {
    this.assertHealthy();
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timed out: ${method}`)); }, 15_000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.send(JSON.stringify({id, method, params}), error => {
        if (error) this.fail(error);
      });
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  close(): void { this.socket.terminate(); }
}
