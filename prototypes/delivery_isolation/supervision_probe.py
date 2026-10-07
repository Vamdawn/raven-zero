#!/usr/bin/env python3
"""THROWAWAY: scoped registered fixture, detached child, TERM/KILL confirmation.
A cooperative registration fixture cannot prove arbitrary task process coverage.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from strict_boundary import strict_profile
from probe import wait_for

WORKER = '''import json, os, pathlib, signal, sys, time
root=pathlib.Path(sys.argv[1]); child=os.fork()
if child:
 root.joinpath('launcher-child.json').write_text(json.dumps({'pid':child}))
 sys.exit(0)
os.setsid()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
root.joinpath('child-ready.json').write_text(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()}))
while not root.joinpath('release').exists(): time.sleep(0.05)
root.joinpath('late').write_text('old generation')
'''


def status(pid):
    response = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return response.stdout.strip() if response.returncode == 0 else 'absent'


def run():
    result = {'scope': 'cooperatively registered PID fixture; unregistered descendants remain unverified'}
    with tempfile.TemporaryDirectory(prefix='rv-stop-') as temporary:
        root = Path(temporary).resolve()
        work, home, runtime, delivery, state = [root / n for n in ('work','home','tmp','delivery','state')]
        for directory in (work,home,runtime,delivery,state): directory.mkdir()
        policy = root / 'strict.sb'; policy.write_text(strict_profile(work,home,runtime,root/'native.sock',delivery,state))
        script = work / 'worker.py'; script.write_text(WORKER)
        launcher = subprocess.Popen(['sandbox-exec','-f',str(policy),sys.executable,str(script),str(work)],start_new_session=True)
        pid = None
        try:
            launcher.wait(timeout=10); wait_for(work/'child-ready.json')
            child = json.loads((work/'child-ready.json').read_text()); pid=child['pid']
            assert json.loads((work/'launcher-child.json').read_text())['pid']==pid
            result['launcherExitedButDetachedChildRuns'] = status(pid) not in ('absent','Z') and child['pgid']!=launcher.pid
            os.kill(pid,signal.SIGTERM); time.sleep(0.1)
            result['termRequestDoesNotConfirmStop'] = status(pid) not in ('absent','Z')
            os.kill(pid,signal.SIGKILL)
            deadline=time.monotonic()+5
            while time.monotonic()<deadline and status(pid)!='absent' and not status(pid).startswith('Z'): time.sleep(0.05)
            result['killThenNonRunnableConfirmed'] = status(pid)=='absent' or status(pid).startswith('Z')
            (work/'release').touch(); time.sleep(0.2)
            result['oldGenerationNoLateWriteAfterConfirmation'] = not (work/'late').exists()
            # Complete accounting is a separate prerequisite; known PID exit is insufficient.
            result['incompleteAccountingDecision'] = 'pending_verification'
            result['cancelConfirmedOnlyForRegisteredFixture'] = all(result[k] for k in ('launcherExitedButDetachedChildRuns','termRequestDoesNotConfirmStop','killThenNonRunnableConfirmed','oldGenerationNoLateWriteAfterConfirmation'))
            assert result['cancelConfirmedOnlyForRegisteredFixture'],result
        finally:
            if pid and status(pid)!='absent' and not status(pid).startswith('Z'): os.kill(pid,signal.SIGKILL)
    (Path(__file__).parent/'evidence'/'supervision.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__': run()
