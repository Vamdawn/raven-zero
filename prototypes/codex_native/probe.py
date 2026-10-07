#!/usr/bin/env python3
"""PROTOTYPE: real Codex 0.155.1 protocol + native terminal probes, not production."""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time


def wait_until(predicate, description, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise TimeoutError(description)


def stop_server(server, result):
    if server.poll() is None:
        os.killpg(server.pid, signal.SIGTERM)
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            result['serverRequiredSigkill'] = True
            os.killpg(server.pid, signal.SIGKILL)
            server.wait(timeout=5)


class Rpc:
    def __init__(self, socket_path, name, output):
        self.name = name
        self.messages = []
        self.next_id = 0
        self.log = (output / f'{name}.jsonl').open('w')
        self.lock = threading.Lock()
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.connect(str(socket_path))
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                             'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                             f'Sec-WebSocket-Key: {key}\r\n\r\n').encode())
        header = bytearray()
        while not header.endswith(b'\r\n\r\n'):
            header.extend(self.socket.recv(1))
        if not header.startswith(b'HTTP/1.1 101'):
            raise RuntimeError(header.decode())
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.call('initialize', {
            'clientInfo': {'name': f'raven_zero_prototype_{name}',
                           'title': 'Raven Zero prototype', 'version': '0.0.0'},
            'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized'})

    def record(self, direction, message):
        with self.lock:
            self.log.write(json.dumps({'time': time.time(), 'direction': direction,
                                       'message': message}, ensure_ascii=False) + '\n')
            self.log.flush()

    def read(self):
        while True:
            try:
                header = self.receive(2)
                opcode = header[0] & 15
                length = header[1] & 127
                if length == 126:
                    length = struct.unpack('!H', self.receive(2))[0]
                elif length == 127:
                    length = struct.unpack('!Q', self.receive(8))[0]
                payload = self.receive(length)
                if opcode == 8:
                    break
                if opcode == 9:
                    self.frame(payload, 10)
                    continue
                message = json.loads(payload)
            except (OSError, EOFError):
                break
            self.record('received', message)
            self.messages.append(message)
            if message.get('method') in (
                    'turn/completed', 'item/tool/requestUserInput',
                    'item/commandExecution/requestApproval', 'thread/closed', 'error'):
                print(self.name, message['method'],
                      json.dumps(message.get('params'), ensure_ascii=False)[:1500], flush=True)

    def send(self, message):
        self.record('sent', message)
        self.frame(json.dumps(message).encode())

    def receive(self, length):
        payload = bytearray()
        while len(payload) < length:
            chunk = self.socket.recv(length - len(payload))
            if not chunk:
                raise EOFError()
            payload.extend(chunk)
        return payload

    def frame(self, payload, opcode=1):
        length = len(payload)
        header = bytes([128 | opcode])
        if length < 126:
            header += bytes([128 | length])
        elif length < 65536:
            header += bytes([128 | 126]) + struct.pack('!H', length)
        else:
            header += bytes([128 | 127]) + struct.pack('!Q', length)
        mask = os.urandom(4)
        encoded = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        with self.lock:
            self.socket.sendall(header + mask + encoded)

    def call(self, method, params=None):
        self.next_id += 1
        request_id = f'{self.name}-{self.next_id}'
        message = {'id': request_id, 'method': method, 'params': params or {}}
        self.send(message)
        response = wait_until(lambda: next((m for m in self.messages
                                            if m.get('id') == request_id
                                            and 'method' not in m), None), method)
        if 'error' in response:
            raise RuntimeError(f'{method}: {response["error"]}')
        return response['result']

    def event(self, method, thread_id, after=0):
        failed = next((m for m in self.messages[after:]
                       if m.get('method') == 'turn/completed'
                       and m.get('params', {}).get('threadId') == thread_id
                       and m['params']['turn']['status'] == 'failed'), None)
        if failed and method != 'turn/completed':
            raise RuntimeError(failed['params']['turn']['error'])
        return next((m for m in self.messages[after:]
                     if m.get('method') == method
                     and m.get('params', {}).get('threadId') == thread_id), None)

    def close(self):
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.socket.close()
        self.reader.join(timeout=2)
        self.log.close()


class NativeTui:
    def __init__(self, socket, thread_id, workspace, output, environment=None):
        self.output = output
        self.raw = bytearray()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(workspace)
            if environment is not None:
                os.environ.update(environment)
            os.environ['TERM'] = 'xterm-256color'
            os.execvp('codex', ['codex', 'resume', thread_id, '--remote',
                               f'unix://{socket}', '--no-alt-screen',
                               '-c', 'check_for_update_on_startup=false'])
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                    struct.pack('HHHH', 42, 140, 0, 0))
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        while True:
            try:
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    break
                self.raw.extend(chunk)
                if b'\x1b[6n' in chunk:
                    os.write(self.fd, b'\x1b[1;1R')
                if b'\x1b[c' in chunk:
                    os.write(self.fd, b'\x1b[?1;2c')
                self.output.write_bytes(self.raw)
            except OSError:
                break

    def text(self):
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', self.raw.decode(errors='replace'))

    def keys(self, value):
        os.write(self.fd, value)

    def close(self):
        try:
            # An exited CLI may no longer own its former process group. Our
            # unreaped child PID remains ours; never signal another group.
            exited, _ = os.waitpid(self.pid, os.WNOHANG)
            if not exited:
                os.kill(self.pid, signal.SIGTERM)
                os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        self.reader.join(timeout=2)
        os.close(self.fd)
        self.output.with_suffix('.txt').write_text(self.text())


def run(case, model):
    root = Path(tempfile.mkdtemp(prefix=f'raven-PROTOTYPE-{case}-'))
    workspace = root / 'workspace'
    workspace.mkdir()
    if case == 'background':
        (workspace / 'linger.py').write_text(
            'from pathlib import Path\nimport time\n'
            'Path("child-ready.txt").write_text("ready")\n'
            'deadline = time.monotonic() + 45\n'
            'while time.monotonic() < deadline:\n'
            '    if Path("release-background.txt").exists():\n'
            '        Path("after-server-exit-background.txt").write_text("late background write")\n'
            '        break\n'
            '    time.sleep(0.1)\n')
        (workspace / 'launch_background.py').write_text(
            'import subprocess\nfrom pathlib import Path\n'
            'child = subprocess.Popen(["python3", "linger.py"], start_new_session=True, '
            'stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n'
            'Path("child-pid.txt").write_text(str(child.pid))\n')
    output = root / 'evidence'
    output.mkdir()
    socket = root / 'server.sock'
    print(f'EVIDENCE={output}', flush=True)
    version = subprocess.check_output(['codex', '--version'], text=True).strip()
    server = subprocess.Popen(
        ['codex', 'app-server', '--listen', f'unix://{socket}',
         '-c', 'features.apps=false', '-c', 'features.multi_agent=false'],
        cwd=workspace, stdout=(output / 'server.stdout').open('w'),
        stderr=(output / 'server.stderr').open('w'), start_new_session=True)
    clients = []
    native = None
    result = {'case': case, 'version': version, 'workspace': str(workspace)}
    try:
        wait_until(socket.exists, 'socket startup', 20)
        owner = Rpc(socket, 'owner', output)
        clients.append(owner)
        started = owner.call('thread/start', {
            'model': model,
            'cwd': str(workspace), 'sandbox': 'read-only' if case == 'approval' else 'workspace-write',
            'approvalPolicy': 'on-request', 'approvalsReviewer': 'user',
            'config': {'features.apps': False, 'features.multi_agent': False},
            'developerInstructions': 'This is a controlled compatibility probe. Work only in the '
            'given scratch workspace. Do not use apps, MCP, web, subagents, or read external files. '
            'Follow the exact probe instructions, then finish the turn.'})
        thread_id = started['thread']['id']
        result.update(threadId=thread_id, model=started['model'],
                      approvalPolicy=started['approvalPolicy'],
                      approvalsReviewer=started['approvalsReviewer'], sandbox=started['sandbox'])
        observer = Rpc(socket, 'observer', output)
        clients.append(observer)
        params = {'threadId': thread_id}
        if case == 'question':
            prompt = ('Call request_user_input exactly once: header Probe, id color, question '
            '"Which fixture color?", options Blue and Green with short descriptions. '
            'Wait for the answer. Then say the selected color and end; do not write files.')
            params['collaborationMode'] = {'mode': 'plan', 'settings': {
                'model': started['model'], 'reasoning_effort': 'low', 'developer_instructions': None}}
            pending_method = 'item/tool/requestUserInput'
            screen_marker = 'Which fixture color'
        elif case == 'approval':
            prompt = ('Run exactly `printf approved > approval-marker.txt` using exec_command. '
            'The sandbox is read-only; explicitly request require_escalated permission for '
            'this harmless scratch-file write with a justification. Wait for approval, '
            'then run and finish. Do not use apply_patch or any other approach.')
            pending_method = 'item/commandExecution/requestApproval'
            screen_marker = 'approval-marker'
        elif case == 'disconnect':
            prompt = ('Run exactly `sleep 12; printf continued > disconnect-marker.txt` '
            'with exec_command, wait for it to finish, then say done and end.')
            pending_method = 'item/started'
            screen_marker = None
        elif case == 'background':
            prompt = ('Run exactly `python3 launch_background.py` with exec_command. '
                      'This is a controlled scratch fixture with a child that exits within 45 seconds. '
                      'Do not inspect the scripts, wait for the child, or stop it. '
                      'After the launcher exits, say done and finish.')
            pending_method = None
            screen_marker = None
        else:
            prompt = ('Run exactly `printf finished > completion-marker.txt` with exec_command, '
            'then say done and finish. Do nothing else.')
            pending_method = None
            screen_marker = None
        params['input'] = [{'type': 'text', 'text': prompt}]
        turn = owner.call('turn/start', params)
        result['turnId'] = turn['turn']['id']
        observer.call('thread/resume', {'threadId': thread_id})
        if pending_method:
            if case == 'disconnect':
                pending = wait_until(lambda: next((m for m in owner.messages
                    if m.get('method') == 'item/started'
                    and m.get('params', {}).get('threadId') == thread_id
                    and m['params']['item']['type'] == 'commandExecution'), None), 'running command')
            else:
                pending = wait_until(lambda: owner.event(pending_method, thread_id), 'pending request/command')
            result['pendingRequestId'] = pending.get('id')
            if case in ('question', 'approval'):
                if case == 'question':
                    screen_marker = pending['params']['questions'][0]['question']
                else:
                    screen_marker = 'Would you like to run the following command?'
                wait_until(lambda: observer.event(pending_method, thread_id), 'second observer request')
                time.sleep(2)
                result['stillWaitingWithoutUi'] = owner.event('turn/completed', thread_id) is None
                result['markerAbsentBeforeAnswer'] = not (workspace / 'approval-marker.txt').exists()
        if case != 'background':
            native = NativeTui(socket, thread_id, workspace, output / 'native.ansi')
        if screen_marker:
            wait_until(lambda: screen_marker.lower() in native.text().lower(), 'native pending request render', 30)
            print('NATIVE_SCREEN', native.text()[-7000:], flush=True)
            native.keys(b'\r')
            if case == 'question':
                time.sleep(1)
                native.keys(b'\r')
            result['answeredViaNativeKeys'] = True
        elif case == 'disconnect':
            wait_until(lambda: started['model'] in native.text(), 'native attach', 30)
            native.close()
            native = None
            result['nativeDisconnectedBeforeCompletion'] = owner.event('turn/completed', thread_id) is None
        completed = wait_until(lambda: owner.event('turn/completed', thread_id), 'turn completion', 120)
        result['turnStatus'] = completed['params']['turn']['status']
        if result['turnStatus'] != 'completed':
            raise RuntimeError(completed['params']['turn']['error'])
        wait_until(lambda: observer.event('turn/completed', thread_id), 'second observer completion')
        result['bothObserversCompleted'] = True
        result['files'] = {p.name: p.read_text() for p in workspace.iterdir() if p.is_file()}
        if case == 'isolation':
            after = len(owner.messages)
            wait_until(lambda: started['model'] in native.text(), 'native attach', 30)
            native.keys(b'Run exactly `printf late > after-completion-marker.txt` with exec_command, then finish.')
            time.sleep(0.5)
            native.keys(b'\r')
            late = wait_until(lambda: owner.event('turn/completed', thread_id, after), 'late native turn', 120)
            result['nativeCanStartAfterCompleted'] = (workspace / 'after-completion-marker.txt').exists()
            result['lateTurnStatus'] = late['params']['turn']['status']
            result['archiveResponse'] = owner.call('thread/archive', {'threadId': thread_id})
            time.sleep(1)
            result['loadedAfterArchive'] = thread_id in owner.call('thread/loaded/list')['data']
            try:
                result['resumeAfterArchive'] = owner.call('thread/resume', {'threadId': thread_id})['thread']['id']
            except RuntimeError as error:
                result['resumeArchivedError'] = str(error)
                owner.call('thread/unarchive', {'threadId': thread_id})
                result['resumeAfterUnarchive'] = owner.call('thread/resume', {'threadId': thread_id})['thread']['id']
            result['canAcceptInputAfterArchiveResume'] = owner.call('thread/read', {
                'threadId': thread_id})['thread']['canAcceptDirectInput']
            native.close()
            native = NativeTui(socket, thread_id, workspace, output / 'native_after_archive.ansi')
            wait_until(lambda: started['model'] in native.text(), 'native reattach after archive', 30)
            time.sleep(1)
            stop_server(server, result)
            result['serverExitedBeforeChecks'] = server.poll() is not None
            try:
                native.keys(b'Run exactly `printf blocked > after-server-exit-marker.txt` with exec_command.')
                time.sleep(0.5)
                native.keys(b'\r')
            except OSError as error:
                result['nativeInputAfterServerExitError'] = str(error)
            time.sleep(2)
            result['noWriteAfterServerExit'] = not (workspace / 'after-server-exit-marker.txt').exists()
            result['filesAfterClosure'] = {p.name: p.read_text() for p in workspace.iterdir() if p.is_file()}
        elif case == 'background':
            wait_until(lambda: (workspace / 'child-ready.txt').exists(), 'detached child ready')
            result['backgroundPid'] = int((workspace / 'child-pid.txt').read_text())
            result['backgroundMarkerAbsentAtCompletion'] = not (workspace / 'after-server-exit-background.txt').exists()
            stop_server(server, result)
            result['serverExitedBeforeRelease'] = server.poll() is not None
            (workspace / 'release-background.txt').write_text('release')
            time.sleep(2)
            result['backgroundWriteAfterServerExit'] = (workspace / 'after-server-exit-background.txt').exists()
            if result['backgroundWriteAfterServerExit']:
                result['backgroundWrite'] = (workspace / 'after-server-exit-background.txt').read_text()
        print('RESULT', json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    except Exception as error:
        result['error'] = str(error)
        if native:
            print('NATIVE_SCREEN', native.text()[-10000:], flush=True)
        print('PROBE_ERROR', str(error), flush=True)
    finally:
        if native:
            native.close()
        for client in clients:
            client.close()
        stop_server(server, result)
        result['serverExitCode'] = server.returncode
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(f'SAVED={output}', flush=True)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', choices=['question', 'approval', 'disconnect', 'isolation', 'background'])
    parser.add_argument('--model', default=None, help='Override only the probe model, not user config')
    args = parser.parse_args()
    result = run(args.case, args.model)
    raise SystemExit(1 if 'error' in result else 0)
