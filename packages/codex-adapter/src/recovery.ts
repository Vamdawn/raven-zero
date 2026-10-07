import {join} from 'node:path';
import {recoverScope, stopScope} from './mac_scope.js';
import type {StopResult} from './mac_scope.js';

/** Restart cleanup for a framework-owned execution-N directory. Stop Agent
 * first; retain launchd's model port if Agent admission/stop is uncertain.
 * Missing or invalid records never become a successful cancellation.
 */
export async function stopExecution(execution: string): Promise<StopResult> {
  try {
    const agent = await stopScope(await recoverScope(join(execution, 'scope')));
    if (agent.status !== 'confirmed') return agent;
    const relay = await stopScope(await recoverScope(join(execution, 'model')));
    return relay.status === 'confirmed' ? agent : relay;
  } catch (error) {
    return {status: 'pending_verification', escalated: false,
      reason: error instanceof Error ? error.message : String(error)};
  }
}
