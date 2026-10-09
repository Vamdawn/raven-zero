import type {ServerTask, TaskResult, TaskRun} from '@raven-zero/contracts';

export interface ClientRecord {
  readonly assignment: ServerTask;
  readonly run: TaskRun | null;
}

/** All writes are short, synchronous operations. Storage is caller-owned. */
export interface ClientStore {
  saveAssignment(input: unknown): void;
  saveRun(input: unknown): void;
  saveResult(input: unknown): void;
  get(runId: string): ClientRecord | undefined;
  list(): ClientRecord[];
  pendingResults(): TaskResult[];
  acknowledge(result: TaskResult): void;
}
