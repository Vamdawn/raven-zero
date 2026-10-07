import {createServer} from 'node:http';
import {connect, type Socket} from 'node:net';

export interface Egress {
  readonly port: number;
  close(): Promise<void>;
}

/** One fixed model endpoint. Uses a local HTTP CONNECT upstream if supplied;
 * does not forward arbitrary HTTP, credentials, caller headers or authorities.
 */
export async function startEgress(upstreamUrl?: string, activatedFd?: number): Promise<Egress> {
  const upstream = upstreamUrl ? new URL(upstreamUrl) : undefined;
  if (upstream && (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(upstream.hostname) ||
      upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash)) {
    throw new Error('Only a local, unauthenticated HTTP CONNECT upstream is supported');
  }
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => { response.writeHead(403); response.end(); });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  server.on('connect', (request, client, head) => {
    if (request.url !== 'chatgpt.com:443') {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const remote = connect(upstream ? Number(upstream.port || '80') : 443,
      upstream?.hostname ?? 'chatgpt.com');
    sockets.add(remote);
    remote.on('close', () => { sockets.delete(remote); client.destroy(); });
    client.on('close', () => remote.destroy());
    remote.on('error', () => { remote.destroy(); client.destroy(); });
    remote.setTimeout(30_000, () => remote.destroy());
    function relay(): void {
      remote.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    }
    remote.once('connect', () => {
      if (!upstream) { relay(); return; }
      remote.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n');
      let buffered = Buffer.alloc(0);
      function response(chunk: Buffer): void {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 16_384) { remote.destroy(); return; }
        const boundary = buffered.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        remote.removeListener('data', response);
        if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(buffered.toString('ascii'))) { remote.destroy(); return; }
        relay();
        if (buffered.length > boundary + 4) client.write(buffered.subarray(boundary + 4));
      }
      remote.on('data', response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const listening = (): void => { server.removeListener('error', reject); resolve(); };
    if (activatedFd === undefined) server.listen(0, '127.0.0.1', listening);
    else server.listen({fd: activatedFd}, listening);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model egress listener');
  return {port: address.port, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }};
}
