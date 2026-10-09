import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import {serializerCompiler, validatorCompiler} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {createOpenApiTransforms} from '@raven-zero/server';

test('路由及注册组件的桥接都拒绝不能忠实表达的 schema', async () => {
  for (const kind of ['route', 'component']) {
    const app = Fastify();
    try {
      const registry = z.registry<{id?: string}>();
      if (kind === 'component') registry.add(z.custom<string>(), {id: 'Unrepresentable'});
      await app.register(swagger, {openapi: {openapi: '3.1.0', info: {title: 'test', version: '1'}},
        ...createOpenApiTransforms(registry)});
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.post('/test', {schema: {body: kind === 'route' ? z.custom<string>() : z.string()}}, async () => 'ok');
      await app.ready();
      assert.throws(() => app.swagger(), /cannot be represented/i);
    } finally { await app.close(); }
  }
});

test('响应序列化拒绝嵌套未知字段与错误类型', async () => {
  const app = Fastify();
  try {
    app.setSerializerCompiler(serializerCompiler);
    const response = z.strictObject({value: z.strictObject({text: z.string()})});
    app.get('/extra', {schema: {response: {200: response}}}, async () => ({value: {text: 'ok', extra: true}}));
    app.get('/wrong', {schema: {response: {200: response}}}, async () => ({value: {text: 1}}));
    assert.equal((await app.inject('/extra')).statusCode, 500);
    assert.equal((await app.inject('/wrong')).statusCode, 500);
  } finally { await app.close(); }
});
