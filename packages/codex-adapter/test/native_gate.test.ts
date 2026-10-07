import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';
import WebSocket, {WebSocketServer} from 'ws';
import {startNativeGate} from '../src/native_gate.js';
import {Rpc, socketUrl} from '../src/rpc.js';

test('native gate keeps exact identity/config, closes connected CLI and blocks reconnection; RPC requests no compression', async () => {
  const root = await mkdtemp('/tmp/rv-gate-');
  const backend = createServer();
  const server = new WebSocketServer({server: backend});
  const seen: unknown[] = [];
  const initialized: string[] = [];
  backend.listen(join(root, 'private.sock'));
  await once(backend, 'listening');
  server.on('connection', (socket, request) => {
    assert.equal(request.headers['sec-websocket-extensions'], undefined);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'initialize') initialized.push(message.params.clientInfo.name);
      if (message.id !== undefined) {
        seen.push(message);
        const result = message.method === 'turn/start' ? {turn: {id: 'native-turn'}} : {ok: true};
        socket.send(JSON.stringify({id: message.id, result}));
      }
    });
  });
  const gate = await startNativeGate(join(root, 'native.sock'), join(root, 'private.sock'), 'owned-thread', {'features.apps': false}, root);
  const observer = await Rpc.connect(join(root, 'private.sock'), () => {});
  const client = new WebSocket(socketUrl(gate.endpoint), {perMessageDeflate: false});
  await once(client, 'open');
  try {
    const reply = once(client, 'message');
    client.send(JSON.stringify({id: 1, method: 'thread/resume', params: {threadId: 'owned-thread', history: [],
      path: '/other-thread', cwd: '/other-workspace', config: {'features.apps': true}}}));
    await reply;
    assert.deepEqual(seen.at(-1), {id: 1, method: 'thread/resume', params: {threadId: 'owned-thread', cwd: root, runtimeWorkspaceRoots: [root], config: {'features.apps': false}}});
    const count = seen.length;
    const rejected = once(client, 'message');
    client.send(JSON.stringify({id: 2, method: 'thread/resume', params: {threadId: 'someone-else'}}));
    await rejected;
    assert.equal(seen.length, count);
    assert.equal(gate.hasUnfinishedInput, false);
    const started = once(client, 'message');
    client.send(JSON.stringify({id: 4, method: 'turn/start', params: {threadId: 'owned-thread'}}));
    await started;
    assert.deepEqual(seen.at(-1), {id: 4, method: 'turn/start', params: {threadId: 'owned-thread', cwd: root, runtimeWorkspaceRoots: [root], sandboxPolicy: {type: 'externalSandbox', networkAccess: 'enabled'}}});
    assert.equal(gate.hasUnfinishedInput, true);
    gate.completeTurn('native-turn');
    assert.equal(gate.hasUnfinishedInput, false);
    const accepted = seen.length;
    const closed = once(client, 'close');
    gate.closeInput();
    client.send(JSON.stringify({id: 3, method: 'turn/start', params: {threadId: 'owned-thread'}}));
    await closed;
    assert.equal(seen.length, accepted);
    const reconnect = new WebSocket(socketUrl(gate.endpoint), {perMessageDeflate: false});
    await once(reconnect, 'close');
    assert.equal(seen.length, accepted);
    assert.deepEqual(initialized, ['raven-zero']);
  } finally {
    observer.close(); client.terminate(); await gate.close();
    for (const connection of server.clients) connection.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => backend.close(() => resolve()));
    await rm(root, {recursive: true});
  }
});
