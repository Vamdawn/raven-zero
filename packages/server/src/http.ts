import {timingSafeEqual} from 'node:crypto';
import type {FastifyPluginAsync, FastifyRequest} from 'fastify';
import swagger from '@fastify/swagger';
import {createJsonSchemaTransform, createJsonSchemaTransformObject, serializerCompiler, validatorCompiler} from 'fastify-type-provider-zod';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {claimResponseSchema, claimSchema, clientCapabilitiesSchema, clientSchema, clientTokenSchema,
  errorSchema, heartbeatSchema, progressSchema, registerClientSchema, resultReceiptSchema, serverIdSchema,
  serverResultSchema, serverTaskSchema, submitTaskSchema} from '@raven-zero/contracts';
import {ServerError, TaskServer, tokenHash} from './service.js';

export interface RavenHttpOptions {readonly server: TaskServer; readonly managementToken: string;}

/** Both export paths reject unrepresentable types instead of silently widening them. */
export function createOpenApiTransforms(schemaRegistry = z.registry<{id?: string}>()): {
  transform: ReturnType<typeof createJsonSchemaTransform>;
  transformObject: ReturnType<typeof createJsonSchemaTransformObject>;
} {
  const zodToJsonConfig = {target: 'draft-2020-12', unrepresentable: 'throw'} as const;
  return {transform: createJsonSchemaTransform({schemaRegistry, zodToJsonConfig}),
    transformObject: createJsonSchemaTransformObject({schemaRegistry, zodToJsonConfig})};
}

function bearer(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ') || authorization.length < 8) {
    throw new ServerError('unauthorized', 'Bearer token required');
  }
  return authorization.slice(7);
}
const EMPTY_SCHEMA = z.strictObject({});
const ERRORS = {400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema, 500: errorSchema};
const MANAGEMENT_SECURITY = [{managementToken: []}];
const CLIENT_SECURITY = [{clientToken: []}];

/** Encapsulated plugin; changes only its own routes and never closes host storage. */
export const ravenRoutes: FastifyPluginAsync<RavenHttpOptions> = async (instance, options) => {
  if (options.managementToken.length < 32) throw new Error('Management token must contain at least 32 characters');
  const server = options.server;
  const adminHash = Buffer.from(tokenHash(options.managementToken), 'hex');
  const management = async (request: FastifyRequest): Promise<void> => {
    if (!timingSafeEqual(adminHash, Buffer.from(tokenHash(bearer(request)), 'hex'))) {
      throw new ServerError('unauthorized', 'Unauthorized management token');
    }
  };
  const client = async (request: FastifyRequest): Promise<void> => {
    if (timingSafeEqual(adminHash, Buffer.from(tokenHash(bearer(request)), 'hex'))) {
      throw new ServerError('unauthorized', 'Client token required');
    }
  };
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServerError) {
      const status = {unauthorized: 401, not_found: 404, conflict: 409, invalid: 400}[error.code];
      return reply.code(status).send({code: error.code, message: error.message});
    }
    if (error instanceof z.ZodError || (error instanceof Error &&
      (('validation' in error && error.validation) || ('statusCode' in error && error.statusCode === 400)))) {
      return reply.code(400).send({code: 'invalid', message: 'Invalid request'});
    }
    instance.log.error(error);
    return reply.code(500).send({code: 'internal', message: 'Internal server error'});
  });
  await instance.register(swagger, {openapi: {openapi: '3.1.0', info: {title: 'Raven Zero', version: '1.0.0'},
    components: {securitySchemes: {managementToken: {type: 'http', scheme: 'bearer'}, clientToken: {type: 'http', scheme: 'bearer'}}}},
    ...createOpenApiTransforms()});
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const params = z.strictObject({taskId: serverIdSchema});
  app.post('/tasks', {onRequest: management, schema: {body: submitTaskSchema, querystring: EMPTY_SCHEMA,
    response: {200: serverTaskSchema, ...ERRORS}, security: MANAGEMENT_SECURITY}}, async request => server.submit(request.body));
  app.get('/tasks/:taskId', {onRequest: management, schema: {params, querystring: EMPTY_SCHEMA,
    response: {200: serverTaskSchema, ...ERRORS}, security: MANAGEMENT_SECURITY}}, async request => server.get(request.params.taskId));
  app.post('/tasks/:taskId/cancel', {onRequest: management, schema: {params, body: EMPTY_SCHEMA, querystring: EMPTY_SCHEMA,
    response: {200: serverTaskSchema, ...ERRORS}, security: MANAGEMENT_SECURITY}}, async request => server.cancel(request.params.taskId));
  app.post('/clients', {onRequest: management, schema: {body: registerClientSchema, querystring: EMPTY_SCHEMA,
    response: {200: clientTokenSchema, ...ERRORS}, security: MANAGEMENT_SECURITY}}, async request => server.registerClient(request.body));
  app.post('/clients/:clientId/revoke', {onRequest: management, schema: {params: z.strictObject({clientId: serverIdSchema}),
    body: EMPTY_SCHEMA, querystring: EMPTY_SCHEMA, response: {200: clientSchema, ...ERRORS}, security: MANAGEMENT_SECURITY}},
  async request => server.revokeClient(request.params.clientId));
  app.post('/heartbeat', {onRequest: client, schema: {body: clientCapabilitiesSchema, querystring: EMPTY_SCHEMA,
    response: {200: heartbeatSchema, ...ERRORS}, security: CLIENT_SECURITY}},
  async request => server.heartbeat(bearer(request), request.body));
  const waiters = new Set<AbortController>();
  instance.addHook('preClose', async () => { for (const controller of waiters) controller.abort(); });
  app.post('/claim', {onRequest: client, schema: {body: claimSchema, querystring: EMPTY_SCHEMA,
    response: {200: claimResponseSchema, ...ERRORS}, security: CLIENT_SECURITY}}, async (request, reply) => {
    const controller = new AbortController();
    waiters.add(controller);
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(); };
    reply.raw.once('close', disconnect);
    try { return {assignment: await server.claim(bearer(request), request.body.waitMs, controller.signal)}; }
    catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') return {assignment: null};
      throw error;
    }
    finally { waiters.delete(controller); reply.raw.off('close', disconnect); }
  });
  app.post('/runs/:runId/progress', {onRequest: client, schema: {params: z.strictObject({runId: z.uuid()}),
    body: progressSchema, querystring: EMPTY_SCHEMA, response: {200: serverTaskSchema, ...ERRORS}, security: CLIENT_SECURITY}},
  async request => server.progress(bearer(request), request.params.runId, request.body));
  app.post('/results', {onRequest: client, schema: {body: serverResultSchema, querystring: EMPTY_SCHEMA,
    response: {200: resultReceiptSchema, ...ERRORS}, security: CLIENT_SECURITY}},
  async request => server.reportResult(bearer(request), request.body));
  app.get('/openapi.json', {onRequest: management, schema: {querystring: EMPTY_SCHEMA, hide: true}}, async () => instance.swagger());
};
