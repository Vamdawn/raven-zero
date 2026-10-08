import type {AgentObservation, AgentSession, Command, CommandResult, FileArtifact,
  JsonValue, Publication, Task, TaskResult, TaskRun} from '@raven-zero/contracts';

export interface AgentAdapter {
  readonly name: string;
  readonly isolation: 'simulated' | 'pending_verification';
  start(task: Task, workspace: string): Promise<AgentSession>;
  observe(session: AgentSession, version: number, signal: AbortSignal): Promise<AgentObservation>;
  /** Closes input; acknowledgment alone is not a stop confirmation. */
  requestStop(session: AgentSession): Promise<void>;
  confirmStop(session: AgentSession): Promise<boolean>;
  /** Verifies the exact retained identity and workspace before resuming. */
  verify(session: AgentSession): Promise<boolean>;
  resume(session: AgentSession): Promise<void>;
}

export interface RunWorkspace {
  readonly root: string;
  readonly workspace: string;
}

export interface PublicationRequest extends RunWorkspace {
  readonly runId: string;
  readonly sessionId: string;
  readonly version: number;
}

export interface FileExecution {
  readonly isolation: 'simulated' | 'pending_verification';
  prepare(root: string, runId: string): Promise<RunWorkspace>;
  /** Checks retained directory identity and outstanding file/command work. */
  verifyWorkspace(workspace: RunWorkspace): Promise<boolean>;
  copyInput(source: string, workspace: string, destination: string): Promise<void>;
  command(command: Command, workspace: string, signal: AbortSignal): Promise<CommandResult>;
  fileExists(workspace: string, path: string): Promise<boolean>;
  publish(request: PublicationRequest): Promise<Publication>;
  verify(publication: Publication): Promise<boolean>;
  artifact(publication: Publication, path: string): Promise<FileArtifact>;
  saveRun(run: TaskRun): Promise<void>;
  saveResult(root: string, result: TaskResult): Promise<void>;
}

export interface DeliveryComponent {
  readonly name: string;
  /** Runs only after a verified publication and successful before checks. */
  deliver(publication: Publication, parameters: Readonly<Record<string, JsonValue>>,
    signal: AbortSignal): Promise<unknown>;
}

export interface RunnerOptions {
  readonly root: string;
  readonly agent: AgentAdapter;
  readonly files: FileExecution;
  readonly delivery?: DeliveryComponent;
}
