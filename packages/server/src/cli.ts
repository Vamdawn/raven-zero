import {Command} from 'commander';
import {z} from 'zod';
import {createServerApp, migrateMysql} from './standalone.js';
import type {MysqlConfig} from './mysql_store.js';

function databaseConfig(): MysqlConfig {
  const config = z.strictObject({
    database: z.string().min(1), user: z.string().min(1), password: z.string().optional(),
    host: z.string().min(1).optional(), port: z.coerce.number().int().min(1).max(65535).optional(),
    socketPath: z.string().min(1).optional(),
  }).parse({database: process.env.RAVEN_MYSQL_DATABASE, user: process.env.RAVEN_MYSQL_USER,
    password: process.env.RAVEN_MYSQL_PASSWORD, host: process.env.RAVEN_MYSQL_HOST,
    port: process.env.RAVEN_MYSQL_PORT, socketPath: process.env.RAVEN_MYSQL_SOCKET});
  return {database: config.database, user: config.user,
    ...(config.password === undefined ? {} : {password: config.password}),
    ...(config.host === undefined ? {} : {host: config.host}),
    ...(config.port === undefined ? {} : {port: config.port}),
    ...(config.socketPath === undefined ? {} : {socketPath: config.socketPath})};
}

const program = new Command().name('raven-server');
program.command('migrate').description('Explicitly migrate Raven tables in an existing database').action(async () => {
  await migrateMysql(databaseConfig());
});
program.command('start').description('Start the single-instance HTTP server').action(async () => {
  const token = z.string().min(32).parse(process.env.RAVEN_MANAGEMENT_TOKEN);
  const port = z.coerce.number().int().min(0).max(65535).parse(process.env.RAVEN_PORT ?? '3000');
  const app = await createServerApp(databaseConfig(), token);
  const shutdown = (): void => {
    app.close().catch(error => { app.log.error(error); process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try { await app.listen({port, host: process.env.RAVEN_HOST ?? '127.0.0.1'}); }
  catch (error) { await app.close(); throw error; }
});

await program.parseAsync();
