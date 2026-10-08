import assert from 'node:assert/strict';
import {test} from 'node:test';
import {taskSchema, workflowSchema, contractJsonSchemas} from '@raven-zero/contracts';

test('报告任务 JSON 拒绝非法输入和嵌套未知字段，公开 schema 可导出', () => {
  const task = {
    id: 'report', agent: {name: 'simulated', prompt: '生成报告'},
    initialization: [], checks: {before: [{kind: 'file', path: 'report.txt'}], after: []},
    artifacts: ['report.txt'],
  };
  assert.deepEqual(taskSchema.parse(JSON.parse(JSON.stringify(task))), task);
  for (const input of [null, {...task, extra: true}, {...task, timeoutMs: -1}, {...task, timeoutMs: 2_147_483_648},
    {...task, agent: {...task.agent, extra: true}},
    {...task, checks: {before: [{kind: 'file', path: 'report.txt', extra: true}], after: []}}]) {
    assert.equal(taskSchema.safeParse(input).success, false);
  }
  assert.deepEqual(workflowSchema.parse({id: 'workflow', tasks: [{task, dependsOn: []}]}).tasks[0]?.task, task);
  const schemas = contractJsonSchemas();
  assert.equal(schemas.task.additionalProperties, false);
  assert.equal(schemas.task.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.doesNotThrow(() => JSON.stringify(schemas));
});
