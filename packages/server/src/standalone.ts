import Fastify from 'fastify';
import type {FastifyInstance} from 'fastify';
import {ravenRoutes} from './http.js';
import {createMysqlStore} from './mysql_store.js';
import type {MysqlConfig} from './mysql_store.js';
import {TaskServer} from './service.js';

/** Explicit deployment operation. Owns and closes only its temporary Raven pool. */
export async function migrateMysql(config: MysqlConfig): Promise<void> {
  const store = createMysqlStore(config);
  try { await store.migrate(); } finally { await store.close(); }
}

/** Standalone assembly owns its pool; startup only checks compatibility. close() releases it. */
export async function createServerApp(config: MysqlConfig, managementToken: string): Promise<FastifyInstance> {
  const store = createMysqlStore(config);
  const app = Fastify({logger: {redact: ['req.headers.authorization']}});
  app.addHook('onClose', async () => store.close());
  try {
    await store.checkCompatibility();
    await app.register(ravenRoutes, {server: new TaskServer(store), managementToken, prefix: '/raven/v1'});
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
