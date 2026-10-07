#!/usr/bin/env python3
"""THROWAWAY: external local Unix/TCP executors under a default-deny fixture."""
import ctypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading

from strict_boundary import strict_profile
from egress_broker import Broker


def run():
    result = {'scope': 'controlled Unix and IPv4/IPv6 loopback services; not complete host IPC audit'}
    with tempfile.TemporaryDirectory(prefix='rv-ipc-') as temporary:
        root = Path(temporary).resolve()
        work, home, runtime, delivery, state = [root / name for name in ('work', 'home', 'tmp', 'delivery', 'state')]
        for path in (work, home, runtime, delivery, state): path.mkdir()
        own_endpoint = root / 'native.sock'
        policy = root / 'strict.sb'
        policy.write_text(strict_profile(work, home, runtime, own_endpoint, delivery, state))
        protected = delivery / 'report'; protected.write_text('original')
        for label, family, address in (
            ('unix-external', socket.AF_UNIX, str(root / 'external.sock')),
            ('ipv4-external', socket.AF_INET, ('127.0.0.1', 0)),
            ('ipv6-external', socket.AF_INET6, ('::1', 0)),
            ('unix-owned', socket.AF_UNIX, str(own_endpoint)),
        ):
            service = socket.socket(family); service.bind(address); service.listen(); service.settimeout(0.1)
            destination = service.getsockname()
            stopped = threading.Event()
            def executor():
                while not stopped.is_set():
                    try: connection, _ = service.accept()
                    except socket.timeout: continue
                    with connection:
                        if connection.recv(32) == b'write':
                            protected.write_text('outside executor')
                            connection.sendall(b'done')
            worker = threading.Thread(target=executor); worker.start()
            code = f'import socket; s=socket.socket({family}); s.connect({destination!r}); s.sendall(b"write"); assert s.recv(32)==b"done"; s.close()'
            control = subprocess.run([sys.executable, '-c', code], capture_output=True)
            assert control.returncode == 0 and protected.read_text() == 'outside executor'
            protected.write_text('original')
            restricted = subprocess.run(['sandbox-exec', '-f', str(policy), sys.executable, '-c', code], capture_output=True)
            result[label] = {'controlExecutes': True, 'restrictedExit': restricted.returncode, 'restrictedWrites': protected.read_text() != 'original', 'permissionError': b'Operation not permitted' in restricted.stderr}
            stopped.set(); worker.join(2); service.close()
            if label == 'unix-owned': assert restricted.returncode == 0
            else: assert restricted.returncode != 0 and not result[label]['restrictedWrites'] and result[label]['permissionError'], result
        # Non-mutating lookup of excluded platform service: control versus fixture.
        code = '''import ctypes, json
lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib')
bootstrap=ctypes.c_uint.in_dll(lib, 'bootstrap_port').value
port=ctypes.c_uint()
rc=lib.bootstrap_look_up(bootstrap, b'com.apple.cfprefsd.agent', ctypes.byref(port))
print(json.dumps({'lookupStatus':rc,'hasPort':bool(port.value)}))
if port.value: lib.mach_port_deallocate(lib.mach_task_self(), port)
'''
        control = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True)
        restricted = subprocess.run(['sandbox-exec', '-f', str(policy), sys.executable, '-c', code], capture_output=True, text=True)
        assert control.returncode == 0 and restricted.returncode == 0
        result['excludedMachLookup'] = {'control': json.loads(control.stdout), 'restricted': json.loads(restricted.stdout)}
        assert result['excludedMachLookup']['control']['hasPort'] and not result['excludedMachLookup']['restricted']['hasPort']
        broker = Broker()
        try:
            policy.write_text(strict_profile(work,home,runtime,own_endpoint,delivery,state,broker.port))
            rejected = []
            for request in ('CONNECT 127.0.0.1:9999 HTTP/1.1', 'CONNECT [::1]:9999 HTTP/1.1', 'CONNECT localhost:9999 HTTP/1.1', 'CONNECT chatgpt.com.evil.invalid:443 HTTP/1.1', 'GET http://localhost:9999/ HTTP/1.1'):
                code = f'import socket; s=socket.create_connection(("127.0.0.1",{broker.port})); s.sendall({(request+chr(13)+chr(10)+chr(13)+chr(10)).encode()!r}); assert b"403 Forbidden" in s.recv(4096); s.close()'
                attempt = subprocess.run(['sandbox-exec','-f',str(policy),sys.executable,'-c',code],capture_output=True)
                rejected.append(attempt.returncode==0)
            result['brokerRejectsLocalIpv4Ipv6HostnameSpoofAndPlainHttp'] = all(rejected)
            service=socket.socket(); service.bind(('127.0.0.1',0)); service.listen()
            code=f'import socket; s=socket.create_connection({service.getsockname()!r}); s.close()'
            attempt=subprocess.run(['sandbox-exec','-f',str(policy),sys.executable,'-c',code],capture_output=True)
            result['brokerProfileStillBlocksDirectLocalService']=attempt.returncode!=0 and b'Operation not permitted' in attempt.stderr
            service.close()
            code='import socket; socket.create_connection(("1.1.1.1",443),timeout=2)'
            attempt=subprocess.run(['sandbox-exec','-f',str(policy),sys.executable,'-c',code],capture_output=True)
            result['brokerProfileBlocksDirectPublicConnection']=attempt.returncode!=0 and b'Operation not permitted' in attempt.stderr
            assert result['brokerRejectsLocalIpv4Ipv6HostnameSpoofAndPlainHttp'] and result['brokerProfileStillBlocksDirectLocalService'] and result['brokerProfileBlocksDirectPublicConnection']
        finally: broker.close()
    result['passed'] = True
    output = Path(__file__).parent / 'evidence' / 'strict-ipc.json'
    output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__': run()
