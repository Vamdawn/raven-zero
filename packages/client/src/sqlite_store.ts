import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {serverTaskSchema, taskResultSchema, taskRunSchema} from '@raven-zero/contracts';
import type {TaskResult} from '@raven-zero/contracts';
import type {ClientRecord, ClientStore} from './store.js';

const rowSchema = z.object({assignment: z.string(), run: z.string().nullable()});
const resultRowSchema = z.object({payload: z.string()});
const MIGRATIONS = [String.raw`
  CREATE TABLE raven_assignment (
    run_id TEXT PRIMARY KEY, assignment TEXT NOT NULL, run TEXT
  ) STRICT;
  CREATE TABLE raven_result (
    run_id TEXT NOT NULL REFERENCES raven_assignment(run_id), version INTEGER NOT NULL,
    payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0, 1)),
    PRIMARY KEY (run_id, version)
  ) STRICT;
`];

/** Opens only the explicitly supplied Raven database; startup applies numbered
 * migrations atomically. Does not own files, Agent sessions or HTTP resources.
 */
export class SqliteClientStore implements ClientStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA synchronous = FULL; PRAGMA journal_mode = WAL;');
      this.db.exec('CREATE TABLE IF NOT EXISTS raven_migration (version INTEGER PRIMARY KEY) STRICT');
      const versions = this.db.prepare('SELECT version FROM raven_migration ORDER BY version').all()
        .map(row => z.object({version: z.number().int().positive()}).parse(row).version);
      if (versions.some((version, index) => version !== index + 1) || versions.length > MIGRATIONS.length) {
        throw new Error('Incompatible client migration versions');
      }
      for (const [index, sql] of MIGRATIONS.entries()) {
        if (index < versions.length) continue;
        this.transaction(() => {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO raven_migration(version) VALUES (?)').run(index + 1);
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }

  saveAssignment(input: unknown): void {
    const assignment = serverTaskSchema.parse(input);
    const retained = this.get(assignment.runId);
    if (retained) {
      if (!isDeepStrictEqual(retained.assignment.task, assignment.task) || retained.assignment.clientId !== assignment.clientId) {
        throw new Error('Assignment identity changed');
      }
      this.db.prepare('UPDATE raven_assignment SET assignment = ? WHERE run_id = ?')
        .run(JSON.stringify(assignment), assignment.runId);
    } else {
      this.db.prepare('INSERT INTO raven_assignment(run_id, assignment) VALUES (?, ?)')
        .run(assignment.runId, JSON.stringify(assignment));
    }
  }

  saveRun(input: unknown): void {
    const run = taskRunSchema.parse(input);
    const record = this.get(run.id);
    if (!record || !isDeepStrictEqual(record.assignment.task, run.task)) throw new Error('Run assignment mismatch');
    if (record.run?.results.some(result => result.version === run.version) && !run.results.some(result => result.version === run.version)) {
      return; // The durable result wins over a lost final phase acknowledgment.
    }
    for (const result of record.run?.results ?? []) {
      if (!isDeepStrictEqual(result, run.results.find(item => item.version === result.version))) {
        throw new Error('Saved result is immutable');
      }
    }
    this.db.prepare('UPDATE raven_assignment SET run = ? WHERE run_id = ?').run(JSON.stringify(run), run.id);
  }

  saveResult(input: unknown): void {
    const result = taskResultSchema.parse(input);
    const record = this.get(result.runId);
    if (!record?.run || record.run.task.id !== result.taskId || record.run.version !== result.version) {
      throw new Error('Result run/version mismatch');
    }
    const saved = this.db.prepare('SELECT payload FROM raven_result WHERE run_id = ? AND version = ?')
      .get(result.runId, result.version);
    if (saved) {
      if (!isDeepStrictEqual(this.result(saved), result)) throw new Error('Saved result is immutable');
      return;
    }
    const run = taskRunSchema.parse({...record.run, status: result.status,
      history: [...record.run.history, result.status], results: [...record.run.results, result]});
    this.transaction(() => {
      this.db.prepare('INSERT INTO raven_result(run_id, version, payload) VALUES (?, ?, ?)')
        .run(result.runId, result.version, JSON.stringify(result));
      this.db.prepare('UPDATE raven_assignment SET run = ? WHERE run_id = ?').run(JSON.stringify(run), run.id);
    });
  }

  get(runId: string): ClientRecord | undefined {
    const row = this.db.prepare('SELECT assignment, run FROM raven_assignment WHERE run_id = ?').get(runId);
    return row ? this.record(row) : undefined;
  }

  list(): ClientRecord[] {
    return this.db.prepare('SELECT assignment, run FROM raven_assignment ORDER BY rowid').all().map(row => this.record(row));
  }

  pendingResults(): TaskResult[] {
    return this.db.prepare('SELECT payload FROM raven_result WHERE acknowledged = 0 ORDER BY rowid').all().map(row => this.result(row));
  }

  acknowledge(result: TaskResult): void {
    const saved = this.db.prepare('SELECT payload FROM raven_result WHERE run_id = ? AND version = ?').get(result.runId, result.version);
    if (!saved || !isDeepStrictEqual(this.result(saved), result)) throw new Error('Result acknowledgment mismatch');
    this.db.prepare('UPDATE raven_result SET acknowledged = 1 WHERE run_id = ? AND version = ?').run(result.runId, result.version);
  }

  close(): void { if (this.db.isOpen) this.db.close(); }

  private record(input: unknown): ClientRecord {
    const row = rowSchema.parse(input);
    return {assignment: serverTaskSchema.parse(JSON.parse(row.assignment)),
      run: row.run === null ? null : taskRunSchema.parse(JSON.parse(row.run))};
  }

  private result(input: unknown): TaskResult {
    return taskResultSchema.parse(JSON.parse(resultRowSchema.parse(input).payload));
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { operation(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
