import assert from 'node:assert/strict';
import {createMysqlStore, TaskServer} from '@raven-zero/server';
import {startMysql} from './mysql_fixture.js';

try {
  const mysql = await startMysql();
  try {
    const store = createMysqlStore({socketPath: mysql.socketPath, user: 'root', database: await mysql.database()});
    try {
      await store.migrate();
      await store.checkCompatibility();
      const server = new TaskServer(store);
      await server.submit({id: 'mysql-smoke', agent: {name: 'simulated', prompt: '连接冒烟 🐦'},
        initialization: [], checks: {before: [], after: []}, artifacts: []});
      assert.equal((await server.get('mysql-smoke')).task.agent.prompt, '连接冒烟 🐦');
    } finally { await store.close(); }
  } finally { await mysql.close(); }
  console.log('[mysql-smoke] connection, query and close passed');
} catch (error) {
  console.error('[mysql-smoke] isolated MySQL connection/query/close failed:', error);
  process.exitCode = 1;
}
