# 本地报告任务执行

Issue #3 的可嵌入切片：JSON 校验、独立任务工作区、模拟 Agent、成果版本、命令/文件检查与本地结果保存。无需启动服务端。

本包的默认文件执行与 Agent 适配器仅提供 **simulated** 隔离，用于受控夹具。独立目录和版本复制不保护任意真实进程；真实 Codex 的外层写入边界由独立适配器建立并在后续切片接入。边界未建立、停止未知、发布不完整或内容核验失败时，保留 `pending_verification`，不运行检查或交付。

任务的命令使用可执行文件与参数数组，不隐式启动 shell。任务未选择交付组件时不调用 Git；本切片不实现 Git 交付。

## 嵌入入口

```ts
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {LocalTaskRunner, NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';

const runner = await LocalTaskRunner.create({
  id: 'report',
  agent: {name: 'simulated', prompt: '根据 input.txt 生成报告'},
  initialization: [{kind: 'file', source: '/absolute/input.txt', destination: 'input.txt'}],
  checks: {before: [{kind: 'file', path: 'report.txt'}], after: []},
  artifacts: ['report.txt'],
}, {
  root: '/absolute/task-runs',
  files: new NodeFileExecution(),
  agent: new SimulatedAgent(async ({session}) => {
    const input = await readFile(join(session.workspace, 'input.txt'), 'utf8');
    await writeFile(join(session.workspace, 'report.txt'), `报告：${input}`);
    return {status: 'completion_candidate', output: {summary: '已生成报告'}};
  }),
});

const run = await runner.execute();
// run.results 中保存结构化输出和带版本、哈希、大小与本地路径的文件产物。
```

包入口导出编译后的 ESM 和 `.d.ts`；行为测试也通过包名导入，不消费源文件。
输入为 `unknown`，JSON 校验与能力、相对路径检查在分配工作区之前执行；非法输入直接拒绝。
初始化文件来源是本地路径，不实现 HTTP 下载。命令的 `timeoutMs` 为必填正整数，
任务与命令期限均不超过 Node 单次计时器上限 2,147,483,647ms。

`advance()` 推进一次阶段并保存执行记录；`execute()` 自动推进到终态或
`working` / `waiting_for_input`，等待状态保留会话和原因，宿主通过 Agent 自身入口处理回答后继续调用。
这些调用不能并发；`cancel()` 可中断活动观察或命令，但返回 `stop_requested` 只表示请求，
继续 `advance()` / `execute()` 取得 `stop_confirmed` 后才保存取消结果。
若 `execute()` 正在自动推进，`cancel()` 等待它完成停止核对并返回实际终态。

可选任务 `timeoutMs` 从创建时计时，等待人工回答也计入；活动操作使用 AbortSignal
中断，宿主在返回等待后须根据 `deadlineAt` 再次推进，没有隐式后台调度器。
显式 `resume()` 核对目录身份、未结束命令、原会话和旧版本后，在原工作区发布下一版；
每次显式恢复重新开始本版期限。已保存结果不是恢复检查或交付时可覆盖的文件。

## 阶段与文件

```text
created → initializing → working ⇄ waiting_for_input
  → completion_candidate → stop_requested → stop_confirmed
  → publishing → published → checking_before → delivering → checking_after
  → saving_result → succeeded / failed

取消或超期 → stop_requested → stop_confirmed → saving_result → cancelled / expired
未知执行范围、身份、边界或成果 → pending_verification
```

每个执行实例保存于 `root/<run-id>/`：`work/` 用于 Agent，`delivery/vN/content/`
用于本版检查与产物，版本旁保存哈希清单；`results/vN.json` 独占创建，`run.json`
保存当前进度与历史结果。发布失败留下 `.partial` 现场，不作为有效成果。
成果使用独立文件副本，排除 `.git`，模拟实现拒绝所有链接和特殊文件。
本切片检查针对已捕获的文件树；改变成果内容的命令会使后续完整性核验进入待核对。

命令停止会终止本次创建的进程组，并等待关闭事件；组仍存在或 500ms 内未确认时，
返回待核对并保留范围。该能力只验证受控前台命令与同组子进程，不能确认任意脱离组的进程，
不能替代真实执行范围监督。模拟 Agent 的取消可停止等待观察，仍运行的回调继续由适配器跟踪，
直到结束前不会确认停止。传入依赖由宿主持有，本包不关闭宿主资源。

执行记录和成果版本由宿主管理生命周期，本包不自动删除失败现场。显式恢复须核对原会话身份、原工作区与既有版本，下一版重新检查；检查失败不会自动重跑 Agent。进程重启后的持久状态核对和 SQLite 属于后续切片。

## 验证

```sh
pnpm exec tsc -b
node --test packages/contracts/dist/test/*.test.js packages/local-runner/dist/test/*.test.js
pnpm check
```

验证使用真实临时文件和 Node 命令，不创建真实 Codex 会话、managed worktree 或数据库。
