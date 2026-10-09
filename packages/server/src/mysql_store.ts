import {CompiledQuery, Kysely, MysqlDialect, sql} from 'kysely';
import {isDeepStrictEqual} from 'node:util';
import {Migrator} from 'kysely/migration';
import type {ColumnType, Selectable, Transaction} from 'kysely';
import {createPool} from 'mysql2';
import {clientCapabilitiesSchema, clientSchema, serverTaskSchema} from '@raven-zero/contracts';
import type {ClientCapabilities, Heartbeat, Progress, RegisterClient, ResultReceipt, ServerClient, ServerTask, Task, TaskResult} from '@raven-zero/contracts';
import {ServerError} from './service.js';
import type {ServerStore} from './service.js';
import {migrations} from './migrations.js';

type JsonColumn = ColumnType<unknown, string, string>;
interface ClientRow {
  id: string; token_hash: string; capabilities: JsonColumn; slots: number; is_revoked: number;
  heartbeat_time: string; create_time: string; update_time: string;
}
interface TaskRow {
  id: string; run_id: string; definition: JsonColumn; agent_name: string; delivery_component: string | null;
  status: string; client_id: string | null; is_cancellation_requested: number;
  progress: JsonColumn | null; result: JsonColumn | null; create_time: string; update_time: string;
}
interface ResultRow {
  run_id: string; version: number; payload: JsonColumn; create_time: string; update_time: string;
}
interface Database {raven_client: ClientRow; raven_task: TaskRow; raven_result: ResultRow;}
export interface MysqlConfig {
  readonly database: string; readonly user: string; readonly password?: string;
  readonly host?: string; readonly port?: number; readonly socketPath?: string;
}

function utcTime(): string { return new Date().toISOString().slice(0, 23).replace('T', ' '); }
function isoTime(value: string): string { return new Date(`${value.replace(' ', 'T')}Z`).toISOString(); }
function isDuplicate(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ER_DUP_ENTRY';
}
// mysql2 returns JSON text so its BIGINT conversion never changes JSON number values into strings.
function parseJson(value: unknown): unknown { return typeof value === 'string' ? JSON.parse(value) : value; }
function mapTask(row: Selectable<TaskRow>): ServerTask {
  return serverTaskSchema.parse({task: parseJson(row.definition), runId: row.run_id, status: row.status,
    clientId: row.client_id, cancellationRequested: row.is_cancellation_requested === 1,
    progress: parseJson(row.progress), result: parseJson(row.result),
    createdAt: isoTime(row.create_time), updatedAt: isoTime(row.update_time)});
}
const TASK_COLUMNS = ['id', 'run_id', 'definition', 'agent_name', 'delivery_component', 'status',
  'client_id', 'is_cancellation_requested', 'progress', 'result', 'create_time', 'update_time'] as const;
const CLIENT_COLUMNS = ['id', 'token_hash', 'capabilities', 'slots', 'is_revoked', 'heartbeat_time',
  'create_time', 'update_time'] as const;
function mapClient(row: Selectable<ClientRow>): ServerClient {
  return clientSchema.parse({id: row.id, capabilities: parseJson(row.capabilities),
    revoked: row.is_revoked === 1, heartbeatAt: isoTime(row.heartbeat_time)});
}

async function lockClient(db: Transaction<Database>, hash: string): Promise<Selectable<ClientRow>> {
  const client = await db.selectFrom('raven_client').select(CLIENT_COLUMNS)
    .where('token_hash', '=', hash).forUpdate().executeTakeFirst();
  if (!client || client.is_revoked) throw new ServerError('unauthorized', 'Unauthorized client');
  return client;
}

async function lockOwnedTask(db: Transaction<Database>, clientId: string, runId: string): Promise<Selectable<TaskRow>> {
  const row = await db.selectFrom('raven_task').select(TASK_COLUMNS).where('run_id', '=', runId).forUpdate().executeTakeFirst();
  if (!row) throw new ServerError('not_found', 'Run not found');
  if (row.client_id !== clientId) throw new ServerError('unauthorized', 'Client is not the execution owner');
  return row;
}

/** Owns a dedicated connection pool, but only raven_ tables in the specified database. */
export class MysqlStore implements ServerStore {
  private readonly db: Kysely<Database>;
  private closing: Promise<void> | undefined;
  constructor(config: MysqlConfig) {
    // Handshake collation IDs are one byte; exact identifiers use 0900_bin in the tables.
    const pool = createPool({...config, connectionLimit: 10, charset: 'utf8mb4_bin',
      timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true});
    this.db = new Kysely<Database>({dialect: new MysqlDialect({pool,
      onCreateConnection: async connection => {
        await connection.executeQuery(CompiledQuery.raw("SET time_zone = '+00:00'"));
      }})});
  }

  async migrate(): Promise<void> {
    const migrator = new Migrator({db: this.db, migrationTableName: 'raven_migration',
      migrationLockTableName: 'raven_migration_lock', provider: {getMigrations: async () => migrations}});
    const result = await migrator.migrateToLatest();
    if (result.error) throw new Error('Raven migration failed; retain partial DDL and rerun migration', {cause: result.error});
  }

  /** Read-only startup check: never creates migration records or runs DDL. */
  async checkCompatibility(): Promise<void> {
    const version = await sql<{version: string}>`SELECT VERSION() AS version`.execute(this.db);
    if (!version.rows[0]?.version.startsWith('8.4.')) throw new Error('Requires MySQL 8.4');
    let applied;
    try { applied = await sql<{name: string}>`SELECT name FROM raven_migration ORDER BY name`.execute(this.db); }
    catch (error) { throw new Error('Explicit Raven migration required', {cause: error}); }
    if (JSON.stringify(applied.rows.map(row => row.name)) !== JSON.stringify(Object.keys(migrations))) {
      throw new Error('Incompatible Raven migration version');
    }
  }

  async submit(task: Task, runId: string): Promise<ServerTask> {
    const now = utcTime();
    try {
      await this.db.insertInto('raven_task').values({id: task.id, run_id: runId, definition: JSON.stringify(task),
        agent_name: task.agent.name, delivery_component: task.delivery?.component ?? null,
        status: 'queued', client_id: null, is_cancellation_requested: 0, progress: null, result: null,
        create_time: now, update_time: now}).execute();
    } catch (error) {
      if (isDuplicate(error)) throw new ServerError('conflict', 'Task already exists');
      throw error;
    }
    return this.get(task.id);
  }

  async get(taskId: string): Promise<ServerTask> {
    const row = await this.db.selectFrom('raven_task').select(TASK_COLUMNS).where('id', '=', taskId).executeTakeFirst();
    if (!row) throw new ServerError('not_found', 'Task not found');
    return mapTask(row);
  }

  async cancel(taskId: string): Promise<ServerTask> {
    return this.db.transaction().execute(async db => {
      const row = await db.selectFrom('raven_task').select(TASK_COLUMNS).where('id', '=', taskId).forUpdate().executeTakeFirst();
      if (!row) throw new ServerError('not_found', 'Task not found');
      if (row.status !== 'queued' && row.status !== 'assigned') return mapTask(row);
      const status = row.status === 'queued' ? 'cancelled' : 'assigned';
      const now = utcTime();
      await db.updateTable('raven_task').set({status, is_cancellation_requested: 1, update_time: now})
        .where('id', '=', taskId).where('status', '=', row.status).execute();
      return mapTask({...row, status, is_cancellation_requested: 1, update_time: now});
    });
  }

  async registerClient(client: RegisterClient, tokenHash: string): Promise<ServerClient> {
    const now = utcTime();
    try {
      await this.db.insertInto('raven_client').values({id: client.id, token_hash: tokenHash,
        capabilities: JSON.stringify(client.capabilities), slots: client.capabilities.slots,
        is_revoked: 0, heartbeat_time: now, create_time: now, update_time: now}).execute();
    } catch (error) {
      if (isDuplicate(error)) throw new ServerError('conflict', 'Client already exists');
      throw error;
    }
    return {...client, revoked: false, heartbeatAt: isoTime(now)};
  }

  async revokeClient(clientId: string): Promise<ServerClient> {
    return this.db.transaction().execute(async db => {
      const row = await db.selectFrom('raven_client').select(CLIENT_COLUMNS)
        .where('id', '=', clientId).forUpdate().executeTakeFirst();
      if (!row) throw new ServerError('not_found', 'Client not found');
      await db.updateTable('raven_client').set({is_revoked: 1, update_time: utcTime()})
        .where('id', '=', clientId).execute();
      return mapClient({...row, is_revoked: 1});
    });
  }

  async heartbeat(hash: string, capabilities: ClientCapabilities): Promise<Heartbeat> {
    return this.db.transaction().execute(async db => {
      const client = await lockClient(db, hash);
      const now = utcTime();
      await db.updateTable('raven_client').set({capabilities: JSON.stringify(capabilities), slots: capabilities.slots,
        heartbeat_time: now, update_time: now}).where('id', '=', client.id).execute();
      const runs = await db.selectFrom('raven_task').select(TASK_COLUMNS).where('client_id', '=', client.id)
        .where('status', '=', 'assigned').orderBy('create_time').orderBy('run_id').execute();
      return {client: mapClient({...client, capabilities, heartbeat_time: now}), runs: runs.map(mapTask)};
    });
  }

  async claim(hash: string): Promise<ServerTask | null> {
    return this.db.transaction().execute(async db => {
      const client = await lockClient(db, hash);
      const now = utcTime();
      // A live poll proves online status; existing assignments occupy slots even after disconnection.
      await db.updateTable('raven_client').set({heartbeat_time: now, update_time: now}).where('id', '=', client.id).execute();
      const capabilities = clientCapabilitiesSchema.parse(parseJson(client.capabilities));
      const count = await db.selectFrom('raven_task').select(eb => eb.fn.countAll<string>().as('count'))
        .where('client_id', '=', client.id).where('status', '=', 'assigned').executeTakeFirstOrThrow();
      if (BigInt(count.count) >= BigInt(client.slots) || capabilities.agents.length === 0) return null;
      const row = await db.selectFrom('raven_task').select(TASK_COLUMNS).where('status', '=', 'queued')
        .where('agent_name', 'in', capabilities.agents)
        .where(eb => capabilities.deliveryComponents.length === 0 ? eb('delivery_component', 'is', null)
          : eb.or([eb('delivery_component', 'is', null), eb('delivery_component', 'in', capabilities.deliveryComponents)]))
        .orderBy('create_time').orderBy('run_id').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if (!row) return null;
      const changed = await db.updateTable('raven_task').set({status: 'assigned', client_id: client.id, update_time: now})
        .where('id', '=', row.id).where('status', '=', 'queued').executeTakeFirst();
      if (changed.numUpdatedRows !== 1n) throw new ServerError('conflict', 'Claim conflict');
      return mapTask({...row, status: 'assigned', client_id: client.id, update_time: now});
    });
  }

  async progress(hash: string, runId: string, progress: Progress): Promise<ServerTask> {
    return this.db.transaction().execute(async db => {
      const client = await lockClient(db, hash);
      const row = await lockOwnedTask(db, client.id, runId);
      if (row.status !== 'assigned') throw new ServerError('conflict', 'Run already completed');
      const now = utcTime();
      await db.updateTable('raven_task').set({progress: JSON.stringify(progress), update_time: now})
        .where('run_id', '=', runId).where('status', '=', 'assigned').execute();
      return mapTask({...row, progress, update_time: now});
    });
  }

  async reportResult(hash: string, result: TaskResult): Promise<ResultReceipt> {
    return this.db.transaction().execute(async db => {
      const client = await lockClient(db, hash);
      const row = await lockOwnedTask(db, client.id, result.runId);
      if (row.id !== result.taskId) throw new ServerError('conflict', 'Result task identity mismatch');
      const saved = await db.selectFrom('raven_result').select(['payload']).where('run_id', '=', result.runId)
        .where('version', '=', result.version).executeTakeFirst();
      if (saved) {
        if (!isDeepStrictEqual(parseJson(saved.payload), result)) throw new ServerError('conflict', 'Result already saved with different content');
        return {task: mapTask(row), duplicate: true};
      }
      if (row.status !== 'assigned') throw new ServerError('conflict', 'Run already completed');
      const task = mapTask(row).task;
      if (row.is_cancellation_requested && result.status !== 'cancelled' && result.status !== 'expired') {
        throw new ServerError('conflict', 'Cancellation requires stop confirmation');
      }
      if (result.status === 'succeeded' && task.artifacts.length > 0) {
        throw new ServerError('conflict', 'Required file artifacts await the artifact transport slice');
      }
      const now = utcTime();
      await db.insertInto('raven_result').values({run_id: result.runId, version: result.version,
        payload: JSON.stringify(result), create_time: now, update_time: now}).execute();
      const changed = await db.updateTable('raven_task').set({status: result.status, result: JSON.stringify(result), update_time: now})
        .where('run_id', '=', result.runId).where('status', '=', 'assigned').executeTakeFirst();
      if (changed.numUpdatedRows !== 1n) throw new ServerError('conflict', 'Result state conflict');
      return {task: mapTask({...row, status: result.status, result, update_time: now}), duplicate: false};
    });
  }

  async close(): Promise<void> {
    this.closing ??= this.db.destroy();
    await this.closing;
  }
}

export function createMysqlStore(config: MysqlConfig): MysqlStore { return new MysqlStore(config); }
