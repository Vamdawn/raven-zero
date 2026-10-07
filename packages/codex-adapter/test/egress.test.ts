import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {connect, type Socket} from 'node:net';
import {once} from 'node:events';
import {startEgress} from '../src/egress.js';

test('model relay forwards only the fixed CONNECT authority; HTTP/local/IP/spoofed targets are rejected', async () => {
  const upstream = createServer();
  const sockets = new Set<Socket>();
  const authorities: string[] = [];
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.on('connect', (request, socket) => {
    authorities.push(request.url ?? '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.on('data', data => socket.write(data));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture upstream');
  const relay = await startEgress(`http://127.0.0.1:${address.port}`);
  async function exchange(packet: string): Promise<string> {
    const socket = connect(relay.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const response = once(socket, 'data');
      socket.write(packet);
      const [data] = await response;
      if (!Buffer.isBuffer(data)) throw new Error('Invalid fixture response');
      return data.toString();
    } finally { socket.destroy(); }
  }
  try {
    for (const target of ['localhost:443', '127.0.0.1:443', '[::1]:443', 'chatgpt.com.evil:443', 'chatgpt.com:80']) {
      assert.match(await exchange(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`), /^HTTP\/1\.1 403/);
    }
    assert.match(await exchange('GET http://chatgpt.com/ HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403/);
    assert.equal(authorities.length, 0);
    assert.match(await exchange('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: attacker.example\r\n\r\n'), /^HTTP\/1\.1 200/);
    assert.deepEqual(authorities, ['chatgpt.com:443']);
    await assert.rejects(startEgress('http://user:password@127.0.0.1:7897'), /unauthenticated/);
  } finally {
    await relay.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
