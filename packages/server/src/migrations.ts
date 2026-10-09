import {sql} from 'kysely';
import type {Kysely} from 'kysely';
import type {Migration} from 'kysely/migration';

// IF NOT EXISTS lets an interrupted MySQL DDL migration resume; DDL is not transactional.
export const migrations: Record<string, Migration> = {
  '001_single_task': {
    async up(db: Kysely<unknown>): Promise<void> {
      await sql`CREATE TABLE IF NOT EXISTS raven_client (
        id VARCHAR(128) COLLATE utf8mb4_0900_bin PRIMARY KEY,
        token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        capabilities JSON NOT NULL, slots SMALLINT UNSIGNED NOT NULL,
        is_revoked TINYINT UNSIGNED NOT NULL DEFAULT 0,
        heartbeat_time DATETIME(3) NOT NULL,
        create_time DATETIME(3) NOT NULL, update_time DATETIME(3) NOT NULL,
        UNIQUE KEY uk_client_token (token_hash), CHECK (is_revoked IN (0, 1)), CHECK (slots <= 1024)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS raven_task (
        id VARCHAR(128) COLLATE utf8mb4_0900_bin PRIMARY KEY,
        run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        definition JSON NOT NULL, agent_name VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL,
        delivery_component VARCHAR(128) COLLATE utf8mb4_0900_bin NULL,
        status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        client_id VARCHAR(128) COLLATE utf8mb4_0900_bin NULL,
        is_cancellation_requested TINYINT UNSIGNED NOT NULL DEFAULT 0,
        progress JSON NULL, result JSON NULL,
        create_time DATETIME(3) NOT NULL, update_time DATETIME(3) NOT NULL,
        UNIQUE KEY uk_task_run (run_id),
        KEY idx_task_claim (status, agent_name, create_time, run_id),
        KEY idx_task_owner (client_id, status),
        FOREIGN KEY (client_id) REFERENCES raven_client(id),
        CHECK (is_cancellation_requested IN (0, 1)),
        CHECK (status IN ('queued', 'assigned', 'succeeded', 'failed', 'cancelled', 'expired')),
        CHECK (status <> 'assigned' OR client_id IS NOT NULL)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`.execute(db);
      await sql`CREATE TABLE IF NOT EXISTS raven_result (
        run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        version INT UNSIGNED NOT NULL, payload JSON NOT NULL,
        create_time DATETIME(3) NOT NULL, update_time DATETIME(3) NOT NULL,
        PRIMARY KEY (run_id, version), FOREIGN KEY (run_id) REFERENCES raven_task(run_id),
        CHECK (version > 0)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`.execute(db);
    },
  },
};
