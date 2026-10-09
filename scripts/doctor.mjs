import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

function probe(label, executable, args) {
  try {
    return execFileSync(executable, args, {encoding: 'utf8', timeout: 5000,
      env: {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools'}}).trim();
  } catch (error) { throw new Error(`${label}: ${executable}`, {cause: error}); }
}

try {
  const config = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.versions.node.split('.')[0] !== config.engines.node.split('.')[0]) {
    throw new Error(`Requires Node.js ${config.engines.node}; found ${process.versions.node}`);
  }
  const pnpm = probe('pnpm', 'pnpm', ['--version']);
  if (`pnpm@${pnpm}` !== config.packageManager) throw new Error(`Requires ${config.packageManager}; found pnpm@${pnpm}`);
  const executable = process.env.RAVEN_MYSQLD ?? '/opt/homebrew/opt/mysql@8.4/bin/mysqld';
  const mysql = probe('MySQL 8.4 (set RAVEN_MYSQLD to the executable)', executable, ['--no-defaults', '--version']);
  if (!/Ver 8\.4\./.test(mysql)) throw new Error(`Requires MySQL 8.4 (RAVEN_MYSQLD); found ${mysql}`);
  const uid = process.getuid?.();
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || uid === undefined || uid === 0) {
    throw new Error('Full validation requires macOS arm64 and a non-root GUI user');
  }
  const version = probe('macOS', '/usr/bin/sw_vers', ['-productVersion']);
  probe('GUI launchd domain', '/bin/launchctl', ['print', `gui/${uid}`]);
  probe('Command Line Tools Git', '/Library/Developer/CommandLineTools/usr/bin/git', ['--version']);
  probe('Command Line Tools compiler', '/Library/Developer/CommandLineTools/usr/bin/clang', ['--version']);
  probe('macOS SDK', '/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
  console.log(`[environment] ready: Node ${process.versions.node}, pnpm ${pnpm}, macOS ${version} arm64, MySQL 8.4`);
} catch (error) {
  console.error(`[environment] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
