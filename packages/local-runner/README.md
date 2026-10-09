# 本地报告与代码任务执行

Issue #3 / #4 的可嵌入切片：JSON 校验、独立任务工作区、模拟 Agent、成果版本、命令/文件检查、本地结果保存与可选 Git 分支交付。无需启动服务端。

本包的默认文件执行与 Agent 适配器仅提供 **simulated** 隔离，用于受控夹具。独立目录和版本复制不保护任意真实进程；真实 Codex 的外层写入边界由独立适配器建立并在后续切片接入。边界未建立、停止未知、发布不完整或内容核验失败时，保留 `pending_verification`，不运行检查或交付。

任务的命令使用可执行文件与参数数组，不隐式启动 shell。任务未选择交付组件时不调用 Git。

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

执行记录和成果版本由宿主管理生命周期，本包不自动删除失败现场。显式恢复须核对原会话身份、原工作区与既有版本，下一版重新检查；检查失败不会自动重跑 Agent。SQLite 保存与客户端重建见[客户端](../../packages/client/README.md)。

`LocalTaskRunner.restore(record, options)` 只加载记录，不重放外部效果。显式 `recover()`
核对原会话及工作区后继续同版工作或已发布成果；发布确认丢失时通过文件执行的
`recoverPublication` 核对真实清单与内容，不接纳 staging。初始化／检查中途无法证明
效果时保持待核对，显式 `resume()` 仍须核验旧版才能开始下一版。
HTTP 客户端可通过 `RunnerOptions.runId` 传入服务端的 UUID，目录准备前校验。

## Git 分支交付

代码任务与报告任务使用同一执行入口。注册 `new GitBranchDelivery(files)`，任务声明：

```ts
delivery: {
  component: 'git-branch',
  parameters: {remote: '/absolute/repository.git', baseRef: 'refs/heads/main'},
}
```

`remote` 可使用 Git 远端 URL 或绝对本地路径；`baseRef` 为分支、完整引用或提交 ID，
不接受 refspec 映射或修订表达式。参数拒绝未知字段。Git 组件在任务初始化步骤和
Agent 启动前获取基准并检出到 `work/`；其他初始化步骤可以继续准备任务输入。

客户端私有元数据在 `root/<run-id>/git/`，与 `work/` 和成果内容分开。
从空模板初始化并获取对象，不复制源配置、hooks、alternates 或 `.git` 指针；
工作区不含指向私有元数据的 `.git`。本地 Git 工作禁用系统／全局配置和 hooks，
按成果清单直接写入文件对象及执行位，不调用 clean/smudge filter。
网络命令与作者身份读取使用客户端已有 Git 配置和凭证；不调用平台 API。
由 `FileExecution.command` 管理所有 Git 进程、输出、期限和停止确认，
每条命令期限 30 秒，并受任务总期限及取消信号约束。
该入口的可选环境参数用于清除 Git 目录、索引和配置注入变量；替代实现必须兑现环境覆盖。

稳定远端分支为 `raven/<run-id>`；私有 `refs/raven/versions/N` 保存每版提交，
下一版沿用最近已有提交的版本为父提交，远端为该提交链祖先时允许正常快进。
交付证据包含 `remote`、`branch`、`commit`、
`version`、`noChanges` 和 `status`，提交身份在推送前保存。
无改动复用父提交，不创建空提交，仍检查并交付分支；是否接受由任务完成检查决定。
前置检查失败不提交或推送，后置检查失败保留推送证据。远端冲突保存失败结果，不强推。
推送后查询远端确认准确提交；查询或停止无法确认时保留待核对。
Git 对象和引用启用 [fsync](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsync)，
未进行物理断电验收。

交付中断后，调用 `recoverDelivery()` 核对目录、原会话、已发布内容及本版前置检查，
再 `execute()` 继续同版交付。提交后尚未保存记录时，从私有版本引用找回原提交；
推送确认丢失时先核对远端，不重复提交或推送。已有提交记录与引用不一致时保留待核对。
如果执行器已丢失，可将保存的 `run.json` 交给
`LocalTaskRunner.restoreDelivery(record, options)`，它先核对同样的边界，再返回可继续的执行器。
该入口恢复 `delivering` 或从交付阶段进入的 `pending_verification`，以及刚进入
`checking_after`、尚无后置检查记录的情况；最后一种情况先重新核对交付，再执行后置检查。
不重跑 Agent、初始化或已通过的本版检查。`resume()` 则明确继续 Agent 工作，
生成新成果版本并重新检查。

默认模拟依赖只能核对当前进程中登记的原目录和会话；进程重启后缺少归属证据会保持
待核对。SQLite 和管理程序重建已由客户端接入；跨进程 Agent／目录 admission 及真实 Codex 全链路由后续切片接入，
本包未开放未验收的真实 Git 写入边界。

## 验证

```sh
pnpm exec tsc -b
node --test packages/contracts/dist/test/*.test.js packages/local-runner/dist/test/*.test.js
pnpm check
```

验证使用真实临时文件、Node 命令和 Git bare remote，不创建真实 Codex 会话、managed worktree 或数据库。
