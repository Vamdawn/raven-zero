import {dirname, join, resolve} from 'node:path';

export interface BoundaryPaths {
  readonly work: string;
  readonly home: string;
  readonly sqlite: string;
  readonly rollouts: readonly string[];
  readonly thread: string;
  readonly temporary: string;
  readonly endpoint: string;
  readonly protected: readonly string[];
  readonly egressPort: number;
}

/** Paths must be canonical, framework-controlled and outside protected roots.
 * No arbitrary local IPC, privileged broker, MCP endpoint or network target.
 */
export function seatbeltProfile(paths: BoundaryPaths): string {
  const quote = (path: string) => JSON.stringify(resolve(path));
  let policy = `(version 1)
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
(allow network-outbound (remote tcp4 "localhost:${paths.egressPort}"))
`;
  for (const directory of [paths.work, paths.temporary, paths.sqlite]) policy += `(allow file-write* (subpath ${quote(directory)}))\n`;
  // Shared Home is not a blanket write grant: never allow modification of
  // personal hooks, configuration, automations, plugins or external launch data.
  for (const directory of ['log']) {
    policy += `(allow file-write* (subpath ${quote(join(paths.home, directory))}))\n`;
  }
  for (const file of paths.rollouts) policy += `(allow file-write* (literal ${quote(file)}))\n`;
  policy += `(allow file-write* (literal ${quote(join(paths.home, 'thread-writer-locks', `${paths.thread}.lock`))}))\n`;
  for (const file of ['session_index.jsonl', 'installation_id', 'app-server-control/app-server-startup.lock', 'thread-writer-locks/.coordination.lock']) policy += `(allow file-write* (literal ${quote(join(paths.home, file))}))\n`;
  policy += `(allow file-write-mode (literal ${quote(join(paths.home, 'app-server-control'))}))\n`;
  policy += `(allow network-bind network-inbound (local unix-socket (path-literal ${quote(paths.endpoint)})))\n`;
  policy += `(allow file-write* (literal ${quote(paths.endpoint)}))\n`;
  policy += `(allow network-outbound (remote unix-socket (path-literal ${quote(paths.endpoint)})))\n`;
  for (const protectedPath of paths.protected) {
    policy += `(deny file-write* (subpath ${quote(protectedPath)}))\n`;
    let ancestor = dirname(protectedPath);
    for (;;) {
      policy += `(deny file-write-unlink (literal ${quote(ancestor)}))\n`;
      if (ancestor === dirname(ancestor)) break;
      ancestor = dirname(ancestor);
    }
  }
  return policy;
}
