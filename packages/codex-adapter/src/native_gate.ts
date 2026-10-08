import {createServer} from 'node:http';
import {chmod} from 'node:fs/promises';
import WebSocket, {WebSocketServer} from 'ws';
import {z} from 'zod';
import {socketUrl} from './rpc.js';

const inputSchema = z.looseObject({id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(), params: z.unknown().optional()});
const ALLOWED = new Set(['initialize', 'initialized', 'thread/read', 'thread/turns/list', 'thread/items/list',
  'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'config/read', 'account/read',
  'configRequirements/read', 'mcpServerStatus/list',
  'account/rateLimits/read', 'model/list', 'collaborationMode/list', 'skills/list',
  'thread/loaded/list', 'thread/list', 'experimentalFeature/list']);

export interface NativeGate {
  readonly endpoint: string;
  readonly hasUnfinishedInput: boolean;
  completeTurn(turn: string): void;
  /** Synchronous cutover: no message callback can forward once called. */
  closeInput(): void;
  close(): Promise<void>;
}

/** Exposes only the task's owned thread. Each native CLI keeps its own Codex
 * connection, preserving upstream multi-connection approval semantics.
 */
export async function startNativeGate(endpoint: string, privateEndpoint: string,
  thread: string, lockedConfig: Readonly<Record<string, boolean | string>>, workspace: string): Promise<NativeGate> {
  let accepting = true;
  const starts = new Set<Set<string | number>>();
  const turns = new Set<string>();
  const completed = new Set<string>();
  let uncertain = false;
  const http = createServer();
  const server = new WebSocketServer({server: http, maxPayload: 1024 * 1024});
  const upstreams = new Set<WebSocket>();
  server.on('connection', client => {
    if (!accepting) { client.terminate(); return; }
    const upstream = new WebSocket(socketUrl(privateEndpoint), {perMessageDeflate: false, handshakeTimeout: 10_000});
    upstreams.add(upstream);
    const queued: string[] = [];
    const pending = new Set<string | number>();
    starts.add(pending);
    function forward(data: string): void {
      if (!accepting) return;
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else if (upstream.readyState === WebSocket.CONNECTING && queued.length < 64) queued.push(data);
      else client.terminate();
    }
    client.on('message', data => {
      if (!accepting) return;
      try {
        const message = inputSchema.parse(JSON.parse(data.toString()));
        if (message.method && !ALLOWED.has(message.method)) throw new Error('Native method outside task scope');
        if (message.method?.startsWith('thread/') || message.method?.startsWith('turn/')) {
          const params = z.looseObject({threadId: z.string().optional()}).parse(message.params);
          if (message.method === 'thread/resume' && params.threadId !== thread) throw new Error('Different thread identity');
          if (params.threadId && params.threadId !== thread) throw new Error('Different thread identity');
          if (message.method === 'thread/resume' || message.method === 'turn/start') {
            params.cwd = workspace;
            params.runtimeWorkspaceRoots = [workspace];
            if (Array.isArray(params.environments) && params.environments.length) throw new Error('Remote environment outside task scope');
          }
          if (message.method === 'turn/start') {
            const policy = z.looseObject({type: z.string()}).nullish().parse(params.sandboxPolicy);
            if ((!policy || policy.type === 'workspaceWrite') && !params.permissions) {
              params.sandboxPolicy = {type: 'externalSandbox', networkAccess: 'enabled'};
            }
          }
          if (message.method === 'thread/resume') {
            const config = z.record(z.string(), z.unknown()).optional().nullable().parse(params.config);
            params.config = {...config, ...lockedConfig};
            // Alternative history/path can substitute a different identity.
            delete params.history; delete params.path;
          }
          message.params = params;
        }
        if (message.method === 'turn/start' || message.method === 'turn/steer') {
          if (message.id === undefined) throw new Error('Mutation requires a request identity');
          pending.add(message.id);
        }
        forward(JSON.stringify(message));
      } catch {
        try {
          const parsed = inputSchema.safeParse(JSON.parse(data.toString()));
          if (parsed.success && parsed.data.id !== undefined) client.send(JSON.stringify({id: parsed.data.id,
            error: {code: -32001, message: 'Input outside Raven Zero task boundary'}}));
          else client.terminate();
        } catch { client.terminate(); }
      }
    });
    upstream.on('open', () => { if (accepting) for (const message of queued.splice(0)) upstream.send(message); else upstream.terminate(); });
    upstream.on('message', data => {
      try {
        const message = inputSchema.parse(JSON.parse(data.toString()));
        if (!message.method && message.id !== undefined && pending.delete(message.id) && message.error === undefined) {
          const result = z.looseObject({turn: z.looseObject({id: z.string()}).optional(), turnId: z.string().optional()}).parse(message.result);
          const turn = result.turn?.id ?? result.turnId;
          if (!turn) uncertain = true;
          else if (!completed.has(turn)) turns.add(turn);
        }
      } catch { uncertain = true; }
      if (accepting && client.readyState === WebSocket.OPEN) client.send(data.toString());
    });
    upstream.on('error', () => client.terminate());
    client.on('error', () => upstream.terminate());
    upstream.on('close', () => { upstreams.delete(upstream); client.terminate(); });
    client.on('close', () => upstream.terminate());
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject); http.listen(endpoint, () => { http.removeListener('error', reject); resolve(); });
  });
  await chmod(endpoint, 0o600);
  function closeInput(): void {
    accepting = false;
    for (const client of server.clients) client.terminate();
    for (const upstream of upstreams) upstream.terminate();
  }
  return {endpoint, get hasUnfinishedInput() {
    return uncertain || turns.size > 0 || [...starts].some(pending => pending.size > 0);
  }, completeTurn(turn: string) { completed.add(turn); turns.delete(turn); }, closeInput, async close() {
    closeInput();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }};
}
