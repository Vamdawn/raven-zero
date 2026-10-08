import {z} from 'zod';

export const jsonValueSchema = z.json();
const durationSchema = z.number().int().positive().max(2_147_483_647);
const commandSchema = z.strictObject({
  executable: z.string().min(1), args: z.array(z.string()),
  timeoutMs: durationSchema,
});
const checkSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind: z.literal('file'), path: z.string().min(1)}),
  z.strictObject({kind: z.literal('command'), command: commandSchema}),
]);
export const taskSchema = z.strictObject({
  id: z.string().min(1),
  agent: z.strictObject({name: z.string().min(1), prompt: z.string().min(1)}),
  initialization: z.array(z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('file'), source: z.string().min(1), destination: z.string().min(1)}),
    z.strictObject({kind: z.literal('command'), command: commandSchema}),
  ])),
  delivery: z.strictObject({component: z.string().min(1), parameters: z.record(z.string(), jsonValueSchema)}).optional(),
  checks: z.strictObject({before: z.array(checkSchema), after: z.array(checkSchema)}),
  artifacts: z.array(z.string().min(1)),
  timeoutMs: durationSchema.optional(),
});
export const workflowSchema = z.strictObject({
  id: z.string().min(1),
  tasks: z.array(z.strictObject({task: taskSchema, dependsOn: z.array(z.string().min(1))})).min(1),
});

const runStatusSchema = z.enum([
  'created', 'initializing', 'working', 'waiting_for_input', 'completion_candidate',
  'stop_requested', 'stop_confirmed', 'publishing', 'published', 'checking_before',
  'delivering', 'checking_after', 'saving_result', 'succeeded', 'failed',
  'cancelled', 'expired', 'pending_verification',
]);
export const sessionSchema = z.strictObject({id: z.string().min(1), workspace: z.string().min(1)});
export const agentObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({status: z.literal('working')}),
  z.strictObject({status: z.literal('waiting_for_input'), reason: z.string().min(1)}),
  z.strictObject({status: z.literal('completion_candidate'), output: jsonValueSchema}),
]);
export const commandResultSchema = z.strictObject({
  status: z.enum(['exited', 'timed_out', 'cancelled', 'pending_verification']),
  exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(),
});
const checkResultSchema = z.strictObject({
  stage: z.enum(['before', 'after']), check: checkSchema, passed: z.boolean(),
  command: commandResultSchema.optional(), reason: z.string().optional(),
});
export const publicationSchema = z.strictObject({
  runId: z.string().min(1), sessionId: z.string().min(1), version: z.number().int().positive(),
  directory: z.string().min(1),
  entries: z.array(z.discriminatedUnion('kind', [
    z.strictObject({kind: z.literal('directory'), path: z.string().min(1)}),
    z.strictObject({kind: z.literal('file'), path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(), executable: z.boolean()}),
  ])),
});
export const fileArtifactSchema = z.strictObject({
  path: z.string().min(1), file: z.string().min(1), version: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative(),
});
export const taskResultSchema = z.strictObject({
  runId: z.string().min(1), taskId: z.string().min(1), version: z.number().int().positive(),
  status: z.enum(['succeeded', 'failed', 'cancelled', 'expired']), output: jsonValueSchema,
  checks: z.array(checkResultSchema), artifacts: z.array(fileArtifactSchema),
  delivery: jsonValueSchema.optional(), reason: z.string().optional(),
});
export const taskRunSchema = z.strictObject({
  id: z.string().min(1), task: taskSchema, root: z.string().min(1), workspace: z.string().min(1),
  isolation: z.enum(['simulated', 'pending_verification']),
  version: z.number().int().positive(), status: runStatusSchema,
  history: z.array(runStatusSchema), startedAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().nonnegative().optional(), session: sessionSchema.optional(),
  stopReason: z.enum(['completion', 'cancelled', 'expired', 'failure']).optional(),
  reason: z.string().optional(), output: jsonValueSchema,
  publications: z.array(publicationSchema), checks: z.array(checkResultSchema),
  results: z.array(taskResultSchema), delivery: jsonValueSchema.optional(),
});

export type Task = z.infer<typeof taskSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type TaskRun = z.infer<typeof taskRunSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type AgentSession = z.infer<typeof sessionSchema>;
export type AgentObservation = z.infer<typeof agentObservationSchema>;
export type Command = z.infer<typeof commandSchema>;
export type CommandResult = z.infer<typeof commandResultSchema>;
export type CheckResult = z.infer<typeof checkResultSchema>;
export type Publication = z.infer<typeof publicationSchema>;
export type FileArtifact = z.infer<typeof fileArtifactSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type JsonValue = z.infer<typeof jsonValueSchema>;

/** JSON-only definitions; Zod's default throws for unrepresentable types. */
export function contractJsonSchemas(): Record<'task' | 'workflow' | 'taskRun' | 'taskResult', z.core.JSONSchema.JSONSchema> {
  const options = {target: 'draft-2020-12'} as const;
  return {
    task: z.toJSONSchema(taskSchema, options), workflow: z.toJSONSchema(workflowSchema, options),
    taskRun: z.toJSONSchema(taskRunSchema, options), taskResult: z.toJSONSchema(taskResultSchema, options),
  };
}
