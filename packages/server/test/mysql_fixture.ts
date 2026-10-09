import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
import {createConnection} from 'mysql2/promise';

/** Owns only a fresh, socket-only MySQL 8.4 instance; never connects to a user's database. */
export async function startMysql(): Promise<{socketPath: string; database(): Promise<string>; close(): Promise<void>}> {
  const executable = process.env.RAVEN_MYSQLD ?? '/opt/homebrew/opt/mysql@8.4/bin/mysqld';
  const exec = promisify(execFile);
  const version = await exec(executable, ['--no-defaults', '--version']);
  if (!/Ver 8\.4\./.test(version.stdout)) throw new Error(`Requires MySQL 8.4: ${version.stdout}`);
  const root = await mkdtemp('/tmp/raven-mysql-');
  const socketPath = join(root, 'mysql.sock');
  try {
    await exec(executable, ['--no-defaults', '--initialize-insecure', `--datadir=${root}/data`], {timeout: 30_000});
  } catch (error) {
    await rm(root, {recursive: true, force: true});
    throw error;
  }
  const child = spawn(executable, ['--no-defaults', `--datadir=${root}/data`, `--socket=${socketPath}`,
    '--skip-networking', '--mysqlx=OFF', `--log-error=${root}/error.log`, `--pid-file=${root}/mysql.pid`],
  {stdio: 'ignore'});
  const exited = once(child, 'exit');
  let databaseCount = 0;
  async function database() {
    const name = `raven_test_${++databaseCount}`;
    const connection = await createConnection({socketPath, user: 'root'});
    try { await connection.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); }
    finally { await connection.end(); }
    return name;
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(root, {recursive: true, force: true});
  }
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null || Date.now() > deadline) {
        throw new Error(await readFile(join(root, 'error.log'), 'utf8'));
      }
      try {
        const connection = await createConnection({socketPath, user: 'root'});
        await connection.end();
        return {socketPath, database, close};
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !['ENOENT', 'ECONNREFUSED'].includes(String(error.code))) throw error;
        await setTimeout(50);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
}
