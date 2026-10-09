# SQLite 与 HTTP 客户端

Issue #6 的可嵌入接单入口，复用 `LocalTaskRunner` 完成初始化、Agent 工作、成果发布、检查和可选 Git 交付。用户调用 `start()` 后接单；不安装 daemon。默认一个名额，可通过 `slots` 配置多个，人工等待和待核对的执行均占名额。

## 嵌入与控制

```ts
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ClientManager, HttpTaskServer, SqliteClientStore} from '@raven-zero/client';
import {NodeFileExecution, SimulatedAgent} from '@raven-zero/local-runner';

// 父目录由宿主准备；这是 Raven 自己的数据库，不是 Codex 的会话数据库。
const store = new SqliteClientStore('/absolute/raven/client.sqlite');
const manager = new ClientManager({
  server: new HttpTaskServer('http://127.0.0.1:3000/raven/v1', configuredClientToken),
  store,
  root: '/absolute/raven/runs',
  files: new NodeFileExecution(),
  agent: new SimulatedAgent(async ({session}) => {
    await writeFile(join(session.workspace, 'report.txt'), '模拟报告');
    return {status: 'completion_candidate', output: {summary: '已生成报告'}};
  }),
});
const running = manager.start(); // 宿主必须持有并处理这个 Promise。
// manager.snapshot() 返回本地执行、准确会话、人工等待原因及未解决的通信错误。
manager.stopAccepting();        // 不接新任务，已有工作、人工等待和补报仍继续。
await running;                 // 等待本地工作完成且服务端确认全部结果。
store.close();
```

客户端令牌来自服务端注册入口，使用同一令牌重启；管理令牌不传给客户端。宿主信任配置的服务端，任务可以包含本地初始化命令。本机允许 HTTP，跨机器使用 HTTPS。`ClientTaskServer` 和 `ClientStore` 可由宿主替换；核心不依赖 Fastify、MySQL 或 SQLite 驱动类型。

`stop()` 请求停止已有运行，及时中止 HTTP 长轮询与等待，返回实际记录；未确认停止的执行为 `pending_verification`，已保存的未上报结果仍保留。它不保证结果已上报。`stopAccepting()` 与 `await running` 则继续等待；等待本地回答或停止核对时可能长期不退出，原因保存在执行记录中。`cancel(runId)` 取消指定执行，也可重新核对此前未确认的取消／超期；超期意图不会变成成功或重新开工。

本地执行、观察及期限独立于 HTTP，网络请求挂起时已有任务仍推进并保存结果。`pollMs` 默认 1000ms，范围 1–30000ms，用于心跳、领取和本地观察间隔；人工等待的期限不受较长间隔拖延。不自动回答或批准问题；宿主使用记录中的准确会话，通过 Agent 自身入口处理交互。

本地存储失败停止接单和观察循环，并拒绝 `start()` 的 Promise；其他执行的持久记录保留，不把存储失败当成断网重试。立即停止也涵盖正在准备工作区的执行，准备返回后落实取消，不会在重新开启时漏启动 Agent。

宿主关闭顺序是先停止／等待管理程序，再关闭自有存储及 Agent 资源。同一数据库只由一个活动接单管理程序管理；不支持多个管理程序共享同一个执行所有者。文件和 Agent 依赖由宿主持有，本模块不删除目录、归档会话或关闭宿主依赖。

## 持久化与补报

`SqliteClientStore(path)` 打开显式指定的 Raven 数据库，并启动编号 SQL 迁移；缺号或未来版本拒绝启动。使用参数化 SQL、WAL 和 `synchronous=FULL`。迁移以及结果／终态保存使用短同步事务，事务内没有 HTTP、文件、Git 或 Agent 等待。存储接口不向核心暴露 SQLite 连接；`close()` 可重复调用。

`raven_assignment` 保存服务端归属和整个本地执行快照：工作区、准确会话、版本、阶段、检查与交付证据。领取响应丢失后通过心跳找回同一 `runId`，领取落盘后才准备工作区。`raven_result` 以 `(run_id, version)` 为键保存不可变结果及确认状态。结果和本地终态在同一事务保存，之后才能上报；最终阶段确认丢失也不能再次执行。HTTP 回执须匹配执行、任务、客户端归属、终态和完整结果，确认丢失时补报相同结果。

离线完成后才收到服务端取消时，当前版本终态及本代 `stop_confirmed` 记录须完整保留。客户端收到取消后先通过进度接口明确确认已经停止，再补报原成功／失败结果；确认丢失可重启重报，不改写结果，也不重新启动 Agent。此前普通收尾的停止进度不能代替取消后的确认。

使用客户端时，SQLite 是执行记录和结果的持久来源，`FileExecution.saveRun/saveResult` 由管理程序接到存储接口；不依赖另一份 `run.json` 作为恢复来源。成果和 Git 私有元数据仍保存于本地执行根，SQLite 不替代文件或远端状态核验。

## 显式恢复

重开管理程序自动补报已保存结果；其余已有执行先标记待核对，保留原阶段，不自动重跑 Agent。

- `recover(runId, 'continue')` 核对原工作区、完整停止证据、准确会话与旧版成果后继续同版工作。完整发布但记录丢失时找回本版；Git 交付恢复复用原提交，并核对远端后决定是否推送。
- `recover(runId, 'retry')` 通过原会话和工作区的核验后生成下一版本，重新开展 Agent 工作与检查；保留旧版成果及记录。
- staging、内容篡改、原会话／目录归属丢失或未经核验的边界保持待核对，不进入交付。初始化或检查中途无法证明外部效果时，也不会自动重放；显式重试仍必须满足核验要求。
- 已有取消／超期意图使用 `cancel(runId)` 核对停止，不能通过恢复重新打开 Agent 输入。

已经保存结果的执行不通过当前单任务服务端重试；该协议只有一个终态结果，后续调度切片建立重试协议后才能提交新的终态版本。没有本地执行快照的领取记录仍保留，缺少准备／会话证据时不能猜测初始化已经完成。

默认 `NodeFileExecution` 与 `SimulatedAgent` 只有受控模拟隔离。管理程序和 SQLite 可重建，但这两个模拟依赖跨进程丢失归属后会拒绝恢复；不能用目录相同或数据库快照代替实际会话／执行范围证据。真实 Codex 和持久 admission 接入由 #8 验收。本包不触及个人 Codex 数据库，也不宣称真实 Agent 隔离或物理断电验收。

文件流式传输由 #7 实现。当前报告闭环验证真实本地报告、格式检查及 HTTP 结构化结果；声明文件产物的成功结果保留本地产物与补报，服务端仍为 assigned，通信状态显示原因，不能提前完成任务。

## 验证

```sh
pnpm exec tsc -b packages/server
node --test --test-concurrency=1 --test-timeout=60000 packages/client/dist/test/*.test.js packages/server/dist/test/client.test.js packages/local-runner/dist/test/recovery.test.js
pnpm check
```

HTTP 用例放在服务端测试包内，复用其私有 socket-only MySQL 夹具；业务只通过客户端／执行器公开入口验证。真实临时 SQLite、文件、命令和 bare remote 覆盖两类任务、断网、确认丢失、等待／期限／取消以及八项交付故障矩阵。SQLite 另由新子进程通过公开包入口读回补报。测试不创建真实 Codex 会话或 managed worktree。范围与证据见[验收记录](../../docs/research/client-http-sqlite.md)。
