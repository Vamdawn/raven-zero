#!/usr/bin/env python3
"""PROTOTYPE: same Codex session, native approval, outer write restriction, recovery."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

from probe import WORKER, freeze, manifest, prepare, profile, wait_for

spec = importlib.util.spec_from_file_location('native_probe', Path(__file__).parent.parent / 'codex_native' / 'probe.py')
native_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_probe)


def turn(rpc, thread_id, text, **extra):
    after = len(rpc.messages)
    response = rpc.call('turn/start', {'threadId': thread_id,
        'input': [{'type': 'text', 'text': text}], **extra})
    return after, response['turn']['id']


def completed(rpc, thread_id, after):
    event = native_probe.wait_until(lambda: rpc.event('turn/completed', thread_id, after),
                                   'completed turn', 120)
    assert event['params']['turn']['status'] == 'completed', event['params']['turn']
    return event


def run(evidence):
    root = Path(tempfile.mkdtemp(prefix='rv-freeze-')).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    work, delivery, state = prepare(root)
    isolated_home = root / 'codex-home'
    isolated_home.mkdir(mode=0o700)
    environment = dict(os.environ, CODEX_HOME=str(isolated_home))
    environment.pop('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', None)
    # Only the cached credential is staged for this live probe, never logged or committed.
    personal_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
    staged_auth = isolated_home / 'auth.json'
    if (personal_home / 'auth.json').exists():
        shutil.copyfile(personal_home / 'auth.json', staged_auth)
        staged_auth.chmod(0o600)
    (isolated_home / 'config.toml').write_text('model = "gpt-6-astra"\ncheck_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n[features]\napps = false\nmulti_agent = false\n')
    socket_path = root / 'server.sock'
    policy = root / 'boundary.sb'
    policy.write_text(profile(delivery, state))
    (work / 'worker.py').write_text(WORKER)
    (work / 'launch.py').write_text(
        'import subprocess, sys\nsubprocess.Popen([sys.executable, "worker.py", '
        + ', '.join(repr(str(p)) for p in (work, delivery, state))
        + '], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n')
    clients, servers = [], []
    native = None
    result = {'version': subprocess.check_output(['codex', '--version'], text=True).strip(),
              'platform': sys.platform, 'scope': 'macOS live Codex, not Linux Codex'}
    print('SCRATCH', root, flush=True)

    def start_server():
        socket_path.unlink(missing_ok=True)
        server = subprocess.Popen(['sandbox-exec', '-f', str(policy), 'codex', 'app-server',
            '--listen', f'unix://{socket_path}'], cwd=work, env=environment, start_new_session=True,
            stdout=(root / f'server-{len(servers)}.stdout').open('w'),
            stderr=(root / f'server-{len(servers)}.stderr').open('w'))
        servers.append(server)
        native_probe.wait_until(socket_path.exists, 'socket startup', 20)
        rpc = native_probe.Rpc(socket_path, f'owner{len(servers)}', root)
        clients.append(rpc)
        initialized = next(m['result'] for m in rpc.messages if m.get('id') == f'{rpc.name}-1')
        assert Path(initialized['codexHome']).resolve() == isolated_home
        result['codexHomeVerified'] = True
        return server, rpc

    try:
        server, rpc = start_server()
        started = rpc.call('thread/start', {'model': 'gpt-6-astra', 'cwd': str(work),
            'sandbox': 'workspace-write', 'approvalPolicy': 'on-request', 'approvalsReviewer': 'user',
            'developerInstructions': 'Controlled scratch prototype. No web, apps, MCP, or subagents. Execute only the requested fixture commands. Never inspect authentication files.'})
        thread_id = started['thread']['id']
        result['threadId'] = thread_id
        after, _ = turn(rpc, thread_id, 'Call request_user_input exactly once. Header Probe, id color, question "Which fixture color?", options Blue and Green. Wait for the answer, then say the chosen color and finish. Do not write files.',
            collaborationMode={'mode': 'plan', 'settings': {'model': 'gpt-6-astra', 'reasoning_effort': 'low', 'developer_instructions': None}})
        native_probe.wait_until(lambda: rpc.event('item/tool/requestUserInput', thread_id, after), 'pending question')
        native = native_probe.NativeTui(socket_path, thread_id, work, root / 'native.ansi', environment)
        native_probe.wait_until(lambda: 'Which fixture color' in native.text(), 'native question', 30)
        native.keys(b'\r'); time.sleep(1); native.keys(b'\r')
        completed(rpc, thread_id, after)
        result['nativeQuestionAnswered'] = True
        after, _ = turn(rpc, thread_id, 'Run exactly `printf normal > normal.txt` with exec_command, then finish. Do not request escalation.',
            sandboxPolicy={'type': 'externalSandbox', 'networkAccess': 'enabled'},
            collaborationMode={'mode': 'default', 'settings': {'model': 'gpt-6-astra', 'reasoning_effort': 'low', 'developer_instructions': None}})
        completed(rpc, thread_id, after)
        result['ordinaryCommandWithUiAttached'] = (work / 'normal.txt').read_text() == 'normal'
        assert result['ordinaryCommandWithUiAttached']
        after, _ = turn(rpc, thread_id, 'Run exactly `python3 launch.py` using exec_command with require_escalated and a justification: controlled scratch-file fixture. Wait for native user approval. After launcher exit say done and finish; do not wait for or stop its child. Do not inspect scripts.',
            sandboxPolicy={'type': 'readOnly'},
            collaborationMode={'mode': 'default', 'settings': {'model': 'gpt-6-astra', 'reasoning_effort': 'low', 'developer_instructions': None}})
        native_probe.wait_until(lambda: rpc.event('item/commandExecution/requestApproval', thread_id, after), 'pending approval')
        native_probe.wait_until(lambda: 'Would you like to run the following command?' in native.text(), 'native approval', 30)
        native.keys(b'\r')
        completed(rpc, thread_id, after)
        wait_for(work / 'ready')
        result['nativeApprovedOnce'] = True
        result['v1Manifest'] = freeze(work, delivery / 'v1')
        (state / 'run.json').write_text(json.dumps({'threadId': thread_id, 'generation': 1, 'phase': 'frozen'}))
        state_before = (state / 'run.json').read_text()
        # The already-attached native UI attempts another turn against the protected directory.
        after = len(rpc.messages)
        native.keys(('Run exactly `printf late > ' + str(delivery / 'v1' / 'report.txt') + '` with exec_command using require_escalated and a justification: controlled write-boundary fixture. Wait for native approval; after the attempt report its result and finish. Do not retry.').encode())
        time.sleep(0.5); native.keys(b'\r')
        native_probe.wait_until(lambda: rpc.event('item/commandExecution/requestApproval', thread_id, after), 'late-write approval')
        native_probe.wait_until(lambda: 'Would you like to run the following command?' in native.text(), 'late-write native approval', 30)
        native.keys(b'\r')
        completed(rpc, thread_id, after)
        result['lateNativeWriteApprovedOnce'] = True
        result['lateNativeTurnCannotChangeV1'] = manifest(delivery / 'v1') == result['v1Manifest']
        native.close(); native = None
        native_probe.stop_server(server, result)
        result['serverExitedBeforeBackgroundRelease'] = server.poll() is not None
        (work / 'delivery-link').symlink_to(delivery / 'v1' / 'report.txt')
        (work / 'replacement').write_text('replacement late')
        (work / 'release').touch()
        wait_for(work / 'attempts.json')
        result['backgroundAttempts'] = json.loads((work / 'attempts.json').read_text())
        result['heldSourceFdChangedSource'] = (work / 'report.txt').read_text() == 'late-held-fd'
        result['backgroundCannotChangeV1'] = manifest(delivery / 'v1') == result['v1Manifest']
        result['metadataUnchanged'] = (state / 'run.json').read_text() == state_before
        assert result['lateNativeTurnCannotChangeV1'] and result['backgroundCannotChangeV1'] and result['metadataUnchanged']
        assert result['heldSourceFdChangedSource'] and all(v != 'allowed' for v in result['backgroundAttempts'].values())
        (work / 'delivery-link').unlink()
        server, rpc = start_server()
        resumed = rpc.call('thread/resume', {'threadId': thread_id})
        assert resumed['thread']['id'] == thread_id
        result['sameThreadAfterServerRestart'] = True
        after, _ = turn(rpc, thread_id, 'Run exactly `printf explicit-resume-v2 > report.txt` with exec_command, then finish.', sandboxPolicy={'type': 'externalSandbox', 'networkAccess': 'enabled'})
        completed(rpc, thread_id, after)
        result['sameWorkspaceAfterRestart'] = (work / 'report.txt').read_text() == 'explicit-resume-v2'
        freeze(work, delivery / 'v2')
        result['recoveryPreservesV1'] = manifest(delivery / 'v1') == result['v1Manifest']
        result['v2Content'] = (delivery / 'v2' / 'report.txt').read_text()
        assert result['sameWorkspaceAfterRestart'] and result['recoveryPreservesV1']
        result['passed'] = True
    finally:
        if native:
            native.close()
        for rpc in clients:
            rpc.close()
        for server in servers:
            native_probe.stop_server(server, result)
        if (work / 'ready').exists():
            try:
                os.kill(int((work / 'ready').read_text()), 15)
            except ProcessLookupError:
                pass
        # Check exact created identity only; never export personal database contents.
        if result.get('threadId'):
            database = personal_home / 'state_5.sqlite'
            if database.exists():
                with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
                    result['createdThreadAbsentFromPersonalDatabase'] = connection.execute('SELECT COUNT(*) FROM threads WHERE id = ?', (result['threadId'],)).fetchone()[0] == 0
        staged_auth.unlink(missing_ok=True)
        result['stagedCredentialRemoved'] = not staged_auth.exists()
        # Export only protocol evidence, excluding account/rate-limit/token metadata.
        for path in root.glob('owner*.jsonl'):
            rows = [line for line in path.read_text().splitlines()
                    if not json.loads(line)['message'].get('method', '').startswith(('account/', 'thread/tokenUsage/'))]
            (evidence / path.name).write_text(('\n'.join(rows) + '\n').replace(str(root), '<PROTOTYPE>').replace(str(Path.home()), '<HOME>'))
        for path in root.glob('native*.txt'):
            (evidence / path.name).write_text(path.read_text().replace(str(root), '<PROTOTYPE>').replace(str(Path.home()), '<HOME>'))
        (evidence / 'codex.json').write_text(json.dumps(result, indent=2) + '\n')
        shutil.rmtree(isolated_home)
        print('EVIDENCE', evidence, 'RUNTIME', root, flush=True)
        print(json.dumps(result, indent=2), flush=True)
    assert result.get('passed') and result.get('createdThreadAbsentFromPersonalDatabase')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=Path(__file__).parent / 'evidence' / 'codex')
    run(parser.parse_args().evidence)
