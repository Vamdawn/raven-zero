import {z} from 'zod';
import {taskSchema, taskResultSchema, taskRunSchema} from './task.js';

export const serverIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
export const clientCapabilitiesSchema = z.strictObject({
  agents: z.array(z.string().min(1).max(128)).max(128),
  deliveryComponents: z.array(z.string().min(1).max(128)).max(128),
  slots: z.number().int().min(0).max(1024),
});
export const registerClientSchema = z.strictObject({id: serverIdSchema, capabilities: clientCapabilitiesSchema});
export const clientSchema = registerClientSchema.extend({
  revoked: z.boolean(), heartbeatAt: z.iso.datetime(),
});
export const clientTokenSchema = z.strictObject({client: clientSchema, token: z.string().min(32)});
export const submitTaskSchema = taskSchema.extend({
  id: serverIdSchema,
  agent: taskSchema.shape.agent.extend({name: z.string().min(1).max(128)}),
  delivery: taskSchema.shape.delivery.unwrap().extend({component: z.string().min(1).max(128)}).optional(),
});
export const progressSchema = z.strictObject({
  status: taskRunSchema.shape.status.exclude(['succeeded', 'failed', 'cancelled', 'expired']),
  reason: z.string().max(4096).optional(),
});
export const serverResultSchema = taskResultSchema.extend({
  runId: z.uuid(), taskId: serverIdSchema, version: z.number().int().positive().max(4_294_967_295),
});
export const serverTaskSchema = z.strictObject({
  task: submitTaskSchema, runId: z.uuid(),
  status: z.enum(['queued', 'assigned', 'succeeded', 'failed', 'cancelled', 'expired']),
  clientId: serverIdSchema.nullable(), cancellationRequested: z.boolean(),
  progress: progressSchema.nullable(), result: serverResultSchema.nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export const heartbeatSchema = z.strictObject({client: clientSchema, runs: z.array(serverTaskSchema)});
export const claimSchema = z.strictObject({waitMs: z.number().int().min(0).max(30_000)});
export const claimResponseSchema = z.strictObject({assignment: serverTaskSchema.nullable()});
export const resultReceiptSchema = z.strictObject({task: serverTaskSchema, duplicate: z.boolean()});
export const errorSchema = z.strictObject({code: z.string(), message: z.string()});

export type ClientCapabilities = z.infer<typeof clientCapabilitiesSchema>;
export type RegisterClient = z.infer<typeof registerClientSchema>;
export type ServerClient = z.infer<typeof clientSchema>;
export type ServerTask = z.infer<typeof serverTaskSchema>;
export type Progress = z.infer<typeof progressSchema>;
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type ResultReceipt = z.infer<typeof resultReceiptSchema>;
