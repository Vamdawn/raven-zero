import {randomUUID} from 'node:crypto';
import type {AgentObservation, AgentSession, Task} from '@raven-zero/contracts';
import type {AgentAdapter} from './dependencies.js';

export interface SimulatedWork {
  readonly task: Task;
  readonly session: AgentSession;
  readonly version: number;
  readonly signal: AbortSignal;
}

interface SimulatedSession {
  readonly task: Task;
  readonly workspace: string;
  stopped: boolean;
  active: number;
}

/** Cooperative in-process fixture only; does not confine real processes. */
export class SimulatedAgent implements AgentAdapter {
  readonly name = 'simulated';
  readonly isolation = 'simulated';
  private readonly sessions = new Map<string, SimulatedSession>();

  constructor(private readonly work: (context: SimulatedWork) => Promise<AgentObservation>) {}

  async start(task: Task, workspace: string): Promise<AgentSession> {
    const id = randomUUID();
    this.sessions.set(id, {task, workspace, stopped: false, active: 0});
    return {id, workspace};
  }

  async observe(session: AgentSession, version: number, signal: AbortSignal): Promise<AgentObservation> {
    const owned = this.owned(session);
    if (owned.stopped) throw new Error('Simulated session input is closed');
    owned.active++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error('Simulated observation was cancelled; work still requires stop verification');
        error.name = 'AbortError';
        reject(error);
      };
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
      // The session owns late completion/rejection even after abort wins. Its
      // active count prevents an unfinished callback from proving a full stop.
      Promise.resolve().then(() => this.work({task: structuredClone(owned.task), session: {...session}, version, signal})).then(
        observation => { owned.active--; signal.removeEventListener('abort', abort); resolve(observation); },
        error => { owned.active--; signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }

  async requestStop(session: AgentSession): Promise<void> { this.owned(session).stopped = true; }
  async confirmStop(session: AgentSession): Promise<boolean> {
    const owned = this.owned(session);
    return owned.stopped && owned.active === 0;
  }
  async verify(session: AgentSession): Promise<boolean> {
    const owned = this.sessions.get(session.id);
    return owned?.workspace === session.workspace && owned.stopped && owned.active === 0;
  }
  async resume(session: AgentSession): Promise<void> { this.owned(session).stopped = false; }

  private owned(session: AgentSession): SimulatedSession {
    const owned = this.sessions.get(session.id);
    if (!owned || owned.workspace !== session.workspace) throw new Error('Unknown simulated session/workspace');
    return owned;
  }
}
