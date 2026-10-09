# Codex 工作阶段隔离模块

Issue #1 的内部模块：原生 CLI 附着准确身份，结束工作阶段后停止全部任务进程，再发布独立成果版本。调用方负责任务执行实例、SQLite 阶段记录、调度期限、检查、Git 交付和上报；这些切片见 #3–#8。

## 运行与验证

已验收环境为 macOS 26.6.1 arm64、非 root 的已登录 GUI 用户、Codex CLI 0.155.1、Node.js 24.15.0。需要已有 Codex 登录、Command Line Tools 与系统 sandbox-exec/launchctl。其他 macOS 版本、架构和 Linux 在启动时拒绝执行；本模块依赖版本固定的 Apple 私有 ABI，不能按通用 Node 模块宣称跨平台支持。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm --filter @raven-zero/codex-adapter generate:protocol
```

`pnpm test` 编译原生帮助程序、TypeScript 与测试，运行实际 JavaScript。协议来自目标 Codex 的 `app-server generate-ts --experimental`；脚本保留实际请求类型的依赖闭包，仅将相对导入改为 `.js`。生成文件保持上游命名。

## 生命周期

```ts
import {CodexSession, stopExecution, recoverPublication} from '@raven-zero/codex-adapter';

const session = await CodexSession.open({
  run, generation, work, root, home, codex, model, thread,
});
// 调用方先保存准确身份、目录、代际和两个 scope；不得借用个人日常会话。
// 任务身份创建属于调用方的预备阶段，本模块不会创建或选择新身份。
// 原生 CLI：codex resume <session.thread> --remote unix://<session.nativeEndpoint>
await session.startTurn({input: [{type: 'text', text: prompt, text_elements: []}]});
const result = await session.finish();
// waiting：原生问答、审批或工作仍在进行，保留原生入口和执行名额。
// pending_verification：关闭输入、保留现场，不运行检查或交付。
// published：调用方保存 publication，再在其 directory 开始本版检查。
```

`finish()` 只在观察到正常回合完成、没有待答请求或原生输入竞争时收尾。关闭所有原生连接、核对最新回合、确认整个 Agent 内核进程范围停止，再复制、校验、刷盘和独占发布 `delivery/vN`。原生 CLI 的正常工作使用外层 Seatbelt；默认 workspace-write 映射为协议 `externalSandbox`，避免两层 Seatbelt 嵌套失败。显式只读审批仍通过原生 CLI 处理。

`cancel()` 同时用于用户取消和调用方期限到达。返回 `confirmed` 才能报告停止；发送 TERM/KILL、回合 interrupted、归档或 app-server 退出均不足以独立确认。未知范围返回 `pending_verification`，保存现场和执行名额。取消不发布新版本。

显式恢复要求先核对旧代际的停止，再传入相同 `thread`、`work` 和 `root`，递增 `generation`。旧成果版本保留；新版本重新检查。不能拿新建会话代替身份恢复。

控制进程崩溃后，对已保存的 `execution-N` 调用 `stopExecution(execution)`。它读取原生启动器的持久 admission，先停止 Agent，再移除模型代理作业；Agent 记录缺失、代际不符或停止无法确认时保留代理端口。调用方用执行记录中的 `run/thread/generation` 调用 `recoverPublication(delivery, identity)` 核对已保存版本；丢失发布回执可以补回，staging 不进入恢复和检查。

## 权限与资源所有权

任务工作区、状态根、可信适配器及运行时安装必须分开；root 不能位于个人 Home 或任务工作区。模块拒绝 Agent 工作区包含自身原生程序或 Node 运行时的布局。Agent 可写任务工作区、专用临时目录、专用 Codex SQLite 状态及准确会话 rollout；个人配置、shell snapshot、可执行别名、插件和其他会话不获写权限。个人 CODEX_HOME 的认证与配置继续复用，Codex 自身 SQLite 元数据使用 root/codex-state，避免给个人自动化和队列数据库写权限。这不是 Raven 客户端的执行记录数据库。

Seatbelt 默认拒绝本地通信与网络，只允许准确的私有 Unix 端点、已列明的 Apple 系统服务和一个 TCP/IPv4 模型出口。代理仅转发 `CONNECT chatgpt.com:443`；支持可选的无凭证 localhost HTTP 上游，不转发调用者 Host 或其他 HTTP 请求。监听描述符由临时 launchd 作业持有，控制进程或代理工作进程崩溃不会释放其许可端口。Agent 全部停止后才移除代理作业。

MCP、插件、hooks、apps、浏览器、computer-use、自动化与多 Agent 入口关闭，原生恢复请求不能解锁；其他 Unix、IPv4/IPv6、UDP、Mach 及网络目标默认拒绝。远程环境不纳入此模块的执行路径。Git 交付由后续受控客户端阶段执行；Agent 不获得任意网络目标或宿主特权代理许可。

launchd 作业按任务临时 bootstrap，结束后精确 bootout；不写入 LaunchAgents，不建立常驻 Raven 服务或 managed worktree。调用方不得把 `modelScope` 单独提前停止，否则仍存活 Agent 的端口许可可能指向后来占用该端口的服务。重启使用 `stopExecution()` 的固定顺序。

## 持久性及限制

原生启动记录、停止证明与成果清单使用 fsync/F_FULLFSYNC；目录元数据同步后再次执行文件的完整刷盘屏障。文件复制使用描述符相对读取和 O_NOFOLLOW，普通文件使用独立 inode、保留执行位、排除 .git；安全内部相对链接保留，绝对、逃逸、悬空、循环、非 UTF-8 及特殊文件拒绝。Agent 停止是发布前提，本模块不承诺活动目录的原子快照。

自动化 SIGKILL 回归覆盖控制进程、代理，以及发布器在 staged／published 两个握手阶段的中断，验证未完成目录排除、同版恢复与篡改拒绝；这两个阶段均在复制完成后，复制器仍在执行时的中断另行验收。阶段定义和恢复矩阵见[验证文档](../../docs/agents/validation.md)。已实现软件刷盘顺序，未进行物理断电、整机重启或磁盘故障实验。文件系统拒绝完整刷盘时不会报告发布成功。

本次复用一个准确、已归档的测试身份和既有 worktree，个人配置核对不变。Codex App 视觉分组未验收；正式任务复用个人 Home 仍可能进入个人历史。更多平台、代理目标或外部工具须单独验证。[机制与证据](../../docs/research/macos-process-boundary.md)。
