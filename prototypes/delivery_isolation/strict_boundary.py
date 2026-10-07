"""THROWAWAY macOS default-deny fixture, not a production permission profile.
Syntax checked against Codex rust-v0.155.1 sandboxing/seatbelt*.sbpl.
"""
import json
from pathlib import Path


def strict_profile(work, home, temporary, endpoint, delivery, state, egress_port=None):
    quoted = lambda path: json.dumps(str(Path(path).resolve()))
    rules = '''(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-read* file-map-executable sysctl-read file-ioctl)
(allow file-write* (literal "/dev/null") (literal "/dev/tty") (subpath "/dev/fd") (regex #"^/dev/ttys[0-9]+$"))
(allow pseudo-tty)
(allow file-write* (literal "/dev/ptmx"))
(allow ipc-posix-sem)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
'''
    if egress_port is None:
        rules += '(allow network-outbound (remote ip))\n(deny network-outbound (remote ip "localhost:*"))\n'
    else:
        rules += f'(allow network-outbound (remote ip "localhost:{egress_port}"))\n'
    for directory in (work, home, temporary):
        rules += f'(allow file-write* (subpath {quoted(directory)}))\n'
    rules += f'(allow network-bind network-inbound (local unix-socket (path-literal {quoted(endpoint)})))\n'
    rules += f'(allow file-write* (literal {quoted(endpoint)}))\n'
    rules += f'(allow network-outbound (remote unix-socket (path-literal {quoted(endpoint)})))\n'
    for directory in (delivery, state):
        rules += f'(deny file-write* (subpath {quoted(directory)}))\n'
        for ancestor in Path(directory).resolve().parents:
            rules += f'(deny file-write-unlink (literal {quoted(ancestor)}))\n'
    return rules
