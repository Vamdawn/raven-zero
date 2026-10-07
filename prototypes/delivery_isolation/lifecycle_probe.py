#!/usr/bin/env python3
"""THROWAWAY: interrupt foreground execution on the exact owned personal thread."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from codex_probe import native_probe, turn


def run(owned_root, evidence):
    ownership = json.loads((owned_root / 'owned-thread.json').read_text())
    thread_id = ownership['threadId']
    work = Path(ownership['cwd'])
    assert work == owned_root / 'work'
    personal_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))).resolve()
    config_path = personal_home / 'config.toml'
    config_before = config_path.read_text()
    environment = dict(os.environ, CODEX_HOME=str(personal_home))
    environment.pop('CODEX_INTERNAL_ORIGINATOR_OVERRIDE', None)
    endpoint = owned_root / 'lifecycle.sock'
    endpoint.unlink(missing_ok=True)
    server = subprocess.Popen(['sandbox-exec', '-f', str(owned_root / 'boundary.sb'), 'codex', 'app-server', '--listen', f'unix://{endpoint}'], cwd=work, env=environment, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = {'threadId': thread_id, 'homeMode': 'personal', 'scope': 'macOS interruption counterexample and fixture supervisor stop after simulated deadline'}
    rpc = None
    try:
        native_probe.wait_until(endpoint.exists, 'lifecycle endpoint', 20)
        rpc = native_probe.Rpc(endpoint, 'lifecycle', owned_root)
        rpc.call('thread/unarchive', {'threadId': thread_id})
        assert rpc.call('thread/resume', {'threadId': thread_id})['thread']['id'] == thread_id
        script = work / 'active.py'
        script.write_text('import os, pathlib, time\npathlib.Path("active-ready").write_text(str(os.getpid()))\nwhile not pathlib.Path("active-release").exists(): time.sleep(0.1)\npathlib.Path("active-late-write").write_text("late")\n')
        for reason in ('cancel', 'deadline'):
            for name in ('active-ready', 'active-release', 'active-late-write'):
                (work / name).unlink(missing_ok=True)
            after, turn_id = turn(rpc, thread_id, 'Run exactly `python3 active.py` with exec_command; wait using write_stdin until it completes. Do not inspect files or launch other commands.', sandboxPolicy={'type': 'externalSandbox', 'networkAccess': 'enabled'}, collaborationMode={'mode': 'default', 'settings': {'model': 'gpt-6-astra', 'reasoning_effort': 'low', 'developer_instructions': None}})
            native_probe.wait_until((work / 'active-ready').exists, 'foreground started')
            pid = int((work / 'active-ready').read_text())
            if reason == 'deadline': time.sleep(1)
            rpc.call('turn/interrupt', {'threadId': thread_id, 'turnId': turn_id})
            event = native_probe.wait_until(lambda: rpc.event('turn/completed', thread_id, after), 'foreground interrupted', 20)
            time.sleep(1)
            process_before = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
            if reason == 'deadline' and process_before.returncode == 0:
                os.kill(pid, signal.SIGTERM)
                native_probe.wait_until(lambda: subprocess.run(['ps', '-p', str(pid)], stdout=subprocess.DEVNULL).returncode != 0, 'fixture stop confirmation', 5)
            (work / 'active-release').touch(); time.sleep(1)
            process = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
            result[reason] = {'turnStatus': event['params']['turn']['status'], 'noLateWrite': not (work / 'active-late-write').exists(), 'fixtureProcessAbsent': process.returncode != 0, 'processAliveAfterInterruptedEvent': process_before.returncode == 0, 'supervisorStoppedExactFixturePid': reason == 'deadline' and process_before.returncode == 0}
            assert result[reason]['turnStatus'] == 'interrupted', result
            if reason == 'deadline': assert result[reason]['noLateWrite'] and result[reason]['fixtureProcessAbsent'], result
        result['passed'] = True
    finally:
        if rpc:
            rpc.call('thread/archive', {'threadId': thread_id})
            result['exactOwnedThreadArchived'] = True
            rpc.close()
        native_probe.stop_server(server, result)
        if (work / 'active-ready').exists():
            try: os.kill(int((work / 'active-ready').read_text()), signal.SIGTERM)
            except ProcessLookupError: pass
        current_config = config_path.read_text()
        pattern = r'(?m)^\[projects\."' + re.escape(str(work)) + r'"\]\n[^\[]*'
        match = re.search(pattern, current_config)
        if match and str(work) not in config_before:
            assert match.group().strip() == f'[projects."{work}"]\ntrust_level = "trusted"'
            config_path.write_text(current_config[:match.start()] + current_config[match.end():])
        result['personalConfigUnchanged'] = config_path.read_text() == config_before
        evidence.mkdir(parents=True, exist_ok=True)
        rows = [line for line in (owned_root / 'lifecycle.jsonl').read_text().splitlines() if not json.loads(line)['message'].get('method', '').startswith(('account/', 'thread/tokenUsage/'))]
        (evidence / 'lifecycle.jsonl').write_text(('\n'.join(rows)+'\n').replace(str(owned_root), '<PROTOTYPE>').replace(str(Path.home()), '<HOME>'))
        (evidence / 'lifecycle.json').write_text(json.dumps(result, indent=2)+'\n')
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    run(Path(sys.argv[1]).resolve(), Path(__file__).parent / 'evidence' / 'codex-personal')
