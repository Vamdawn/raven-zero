# 提交检查与真实验证

## 提交检查

在仓库根目录执行 `pnpm hooks:install`，为当前 checkout 安装 Git pre-commit 入口；重复安装保持原样。检查策略在版本管理中的 `.githooks/pre-commit` 和 `scripts/check.mjs`，旧钩子原样保存在 Git 公共目录的 `hooks/pre-commit.raven-previous`，先执行它，再做 Raven 检查，确保格式化等改动也经过验证。已有自定义 `core.hooksPath` 或冲突备份时，安装失败并保留原文件；按现有钩子管理方式在最后串联 `node scripts/check.mjs --staged`。

手动检查用 `pnpm check`；具体检查命令以根 package.json 为准。完整测试按文件串行运行，避免真实 Git 子进程与 launchd 夹具并行竞争启动窗口；断言和测试期限保持有效。提交时先暂存完整改动：钩子在检查前后拒绝未暂存的已跟踪改动及未忽略的新文件，并确认待提交树在检查期间未变化，使测试读取的内容与提交内容一致。失败会阻止提交。只暂存其中一部分时，先把其他改动移出工作树，完成提交后恢复。

完整构建强制重新编译所有 TypeScript 引用项目；定向红绿循环可用 `pnpm exec tsc -b <项目路径>` 增量编译。等待编译与测试进程结束后再修改其读取的源码，收尾以当前暂存树的完整检查为准。工具回归通过临时 TypeScript 项目保留旧产物与增量缓存、修改源码并恢复原时间戳，再运行公开 `pnpm test`，核对实际执行的新断言及导出值。

提交前双轴审查使用固定基线到完整暂存树的差异；记录基线提交、merge-base 和暂存树 ID，修复后更新暂存树并复核受影响项。审查收敛后再提交，提交钩子执行完整检查。审查读到的文件、验证的工作树和最终提交内容均须对应同一暂存树；部分暂存或审查期间树变化时重新核对范围。

开始实现前先运行 `pnpm doctor`，通过后运行 `pnpm test:mysql-smoke`，再推进业务测试切片。
前者只读核对 Node/pnpm、MySQL 8.4 可执行文件、macOS arm64 非 root GUI 用户、Command Line Tools 和 SDK；
它不安装软件、不启动服务，原生 ABI 的精确平台范围仍由模块运行时校验。
后者只编译服务端及其依赖，在私有 socket-only MySQL 上通过公开存储和核心 API 验证连接、查询、Unicode 往返及关闭。
MySQL 路径使用服务端 README 说明的 `RAVEN_MYSQLD`。`[environment]` 与 `[mysql-smoke]` 失败先处理，再开始业务实现。

`pnpm check` 顺序执行预检、MySQL 冒烟、`pnpm check:mysql-hooks`、完整业务测试及工具测试，任一步失败立即停止。
定向静态检查在服务端导入 mysql2 回调驱动的文件中拒绝字面量 `connection` 事件钩子，初始化查询走 Kysely 等待的 `onCreateConnection`；
它覆盖点号、字符串属性访问及常用监听别名，忽略注释和普通字符串，不替代通用 Promise 或动态表达式审查。
工具测试覆盖这条规则及提交检查顺序；服务端故障注入测试以替代 mysqld 可执行文件验证初始化失败时保留错误并清理自有目录。

完整检查依赖模块 README 中已验收的 macOS/arm64 版本、Node.js 24、Command Line Tools 和非 root GUI 用户。它运行本机临时 launchd/Seatbelt 行为测试，不调用真实模型、不创建 Codex 会话或 managed worktree。当前入口是本机提交检查；仓库没有云端 CI，通用 hosted runner 不作为本模块完整验收环境。

本机系统 Git 可能被未确认的 Xcode 许可阻挡；脚本使用 Command Line Tools 的 Git，钩子只在自身进程树设置 DEVELOPER_DIR，不修改全局配置。

## 恢复故障矩阵

修改 Git 交付、阶段记录或恢复入口时，沿用公开 `LocalTaskRunner` 执行／恢复入口，
以真实临时 Git 仓库和 bare remote 核对以下矩阵。可执行用例在
[Git 交付测试](../../packages/local-runner/test/git_branch.test.ts)中；每个故障点都测试执行前失败和执行成功后确认丢失。

| 故障点 | 执行前失败 | 执行成功后确认丢失 | 同版恢复要求 |
| --- | --- | --- | --- |
| Git 提交 | 私有版本引用仍指向父提交 | 版本引用已保留新提交，执行记录尚无证据 | 按发布内容提交或找回原提交，最终只有一个本版提交 |
| 交付证据保存 | 提交已存在，磁盘记录尚无证据 | 磁盘已有提交证据 | 复用原提交，核对证据与版本引用一致 |
| Git 推送 | 远端尚无本版提交 | 远端已有本版提交，记录仍为 committed | 核对远端后决定是否推送，成功的推送只执行一次 |
| 进入后置检查的阶段记录保存 | 远端已更新，磁盘仍为 delivering | 磁盘为 checking_after，尚无后置检查记录 | 核对交付并完成后置检查，保持本版身份 |

故障注入后同时阻断待核对记录写入，使恢复读取最后落盘的 `run.json`，而非当前内存快照。
断言故障确已发生、磁盘阶段正确、Agent 调用次数、版本／会话、提交／远端分支和成果内容；
随后显式继续下一版，核对父提交关系及旧版成果、结果记录保持不变。
另外保留已有的“旧版已推送、新版推送失败、再继续下一版”回归，覆盖跨版本组合。

当前矩阵重建执行器和交付组件，复用仍持有目录、会话归属证据的模拟依赖；
它不代表 SQLite 跨进程恢复、后置检查中途恢复或物理断电已经验收。
审查恢复改动时，逐项核对外部副作用、磁盘记录与内存阶段不一致的窗口，以及跨版本组合。

## 客户端组合故障

修改接单调度、错误传播、停止、结果确认或重启恢复时，沿用公开 `ClientManager` 与存储入口，按受影响的窗口核对以下组合。已有证据在[客户端 HTTP 测试](../../packages/server/test/client.test.ts)；复用现有回归，仅补充此次改动引入的缺口。

| 组合 | 验证与审查要求 |
| --- | --- |
| 一项持久化失败，另一项仍在等待 Agent 或命令 | 后台失败可由调用方观察；活动观察／命令收到停止信号，未确认停止保留待核对，故障传播不被另一项等待遮蔽 |
| 后台先失败，随后本地扫描或停止收尾再次失败 | 保留并传播首个故障；本地存储错误由本地失败边界处理，网络重试只承担通信操作 |
| 准备工作区期间立即停止，随后重新开启原管理程序 | 已领取的准备中执行落实停止请求；重开先核对持久阶段，未完成执行等待显式恢复，Agent 调用次数与持久状态一致 |
| 离线完成后收到取消，停止确认和结果回执相继丢失，再重开存储 | 取消后的本代停止确认与普通收尾进度分开；保留原不可变结果，通过补报取得幂等回执，执行不重放，名额只随确认终态释放一次 |

用明确的阶段握手制造窗口，并分别核对内存、持久记录、服务端状态及外部副作用。审查报告指向覆盖该窗口的公开入口用例，或说明仍缺失的证据。模拟依赖的归属保留和真实 Agent 的跨进程停止／恢复分开记录；这里的组合回归不替代真实 Codex 验收。

## 原生发布崩溃测试

[发布崩溃测试](../../packages/codex-adapter/test/publication_crash.test.ts)通过发布入口的 awaited checkpoint
在两个阶段握手：staged 表示副本、清单已刷盘而独占发布尚未执行；published 表示独占发布及最终刷盘已完成，而发布回执尚未返回。
测试夹具发出阶段确认后保持 Unix socket 打开，控制端收到完整确认后才通过准确 scope 发送 SIGKILL。
前者必须拒绝 staging 并允许重试同版，后者必须找回已发布的同版内容；两者都核对源目录后续变化不会改变成果。

握手等待有独立期限，失败附带准确 scope、stdout 和 stderr；停止未确认时保留现场。
轮询瞬时 staging、增大文件拖慢复制或只延长等待不能替代阶段确认。
该测试中断的是复制完成后的发布器；复制子进程仍在执行时的中断不在这两个阶段的验收范围内。
ready.json 的原子替换负责防止半成品读取，测试串行只负责降低资源竞争；串行通过不作为原子发布的证明。

## 真实 Codex 验证

真实验证另外执行，保留[验收记录](../research/macos-process-boundary.md)定义的平台与功能范围。初版继续复用个人 CODEX_HOME；纯协议探针可使用隔离测试状态根。需要个人 Home 兼容性时，复用执行记录已证明归属的准确身份及任务工作区。当前 checkout、已有工作区及准确身份优先复用。

1. 按执行记录准备注册 JSON，只填写本轮已证明归属的 thread 和目录。`database` 是本次要核对的 Codex 会话数据库；初版个人 Home 验证通常是个人 `state_5.sqlite`，不是 Raven 执行记录数据库。该身份必须已存在，cwd 必须匹配 `work`。

   ```json
   {
     "home": "/absolute/codex-home",
     "work": "/absolute/task-workspace",
     "root": "/absolute/protected-run-root",
     "database": "/absolute/codex-home/state_5.sqlite",
     "thread": "00000000-0000-4000-8000-000000000001"
   }
   ```

2. 先编译模块，再执行 `pnpm validation:begin config.json /absolute/protected-run-root/baseline.json`。基线只在受控 root 顶层独占创建，记录配置哈希、Git worktree 列表与已有 thread IDs；文件权限为 0600，失败重试复用同一基线。注册文件和证据可放在已忽略的 `.validation/`；基线所在 root 及工具安装始终在 Agent 写权限之外。配置只有这五个字段，路径使用绝对路径；工具会规范化并拒绝 Home/work/root 的危险重叠。

3. 启动/恢复时继续保存准确 `execution-N` 目录与 Agent/model scope。测试正常结束或失败后，用模块的 `cancel()` / `stopExecution()` 先确认整个 Agent 范围停止，再释放模型代理。确认后只归档该准确测试身份，通过已验证接口处理本轮新增的信任项，保留 admission、停止证明和协议证据。未知范围或请求失败保留现场及基线，继续准确身份的恢复核对。

4. 执行 `pnpm validation:check /absolute/protected-run-root/baseline.json`。统一核对入口只读检查：原 thread/cwd、准确身份已归档、配置哈希不变、Git worktree 列表不变，以及基线之后没有指向本轮 work/root 的新增身份。逐个 `execution-N` 核对 Agent/model 的 stopped 证明与持久 admission 一致，并确认准确 launchd 作业不存在。缺失记录、未归档身份、配置变化或作业未知返回 `pending_verification` 和非零退出码，保留文件、配置和数据库，不自动删除或覆盖。用户在其他目录的正常新会话不视为测试污染。

只有所有执行代际通过核对后，才可清理本轮临时 Codex 元数据数据库；先保留所需证据，再通过 App 的 worktree 归档能力处理准确附件。归档完成以 `list_artifacts` 的 archived_worktree 为准，queued 响应仍需核对结果。置顶保护解除后恢复原置顶位置。资源核对不代表 Codex App 视觉分组已验收，也不替代真实交互测试。

工具依据：[Git hooks](https://git-scm.com/docs/githooks)、[Node.js 24 只读 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)。
