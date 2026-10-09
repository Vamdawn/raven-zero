# 提交检查与真实验证

## 提交检查

在仓库根目录执行 `pnpm hooks:install`，为当前 checkout 安装 Git pre-commit 入口；重复安装保持原样。检查策略在版本管理中的 `.githooks/pre-commit` 和 `scripts/check.mjs`，旧钩子原样保存在 Git 公共目录的 `hooks/pre-commit.raven-previous`，先执行它，再做 Raven 检查，确保格式化等改动也经过验证。已有自定义 `core.hooksPath` 或冲突备份时，安装失败并保留原文件；按现有钩子管理方式在最后串联 `node scripts/check.mjs --staged`。

手动检查用 `pnpm check`；具体检查命令以根 package.json 为准。完整测试按文件串行运行，避免真实 Git 子进程与 launchd 夹具并行竞争启动窗口；断言和测试期限保持有效。提交时先暂存完整改动：钩子在检查前后拒绝未暂存的已跟踪改动及未忽略的新文件，并确认待提交树在检查期间未变化，使测试读取的内容与提交内容一致。失败会阻止提交。只暂存其中一部分时，先把其他改动移出工作树，完成提交后恢复。

完整检查依赖模块 README 中已验收的 macOS/arm64 版本、Node.js 24、Command Line Tools 和非 root GUI 用户。它运行本机临时 launchd/Seatbelt 行为测试，不调用真实模型、不创建 Codex 会话或 managed worktree。当前入口是本机提交检查；仓库没有云端 CI，通用 hosted runner 不作为本模块完整验收环境。

本机系统 Git 可能被未确认的 Xcode 许可阻挡；脚本使用 Command Line Tools 的 Git，钩子只在自身进程树设置 DEVELOPER_DIR，不修改全局配置。

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
