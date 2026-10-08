# Codex 原生交互与自动收尾隔离验证

2026-10-07 对本机 Codex CLI 0.155.1 运行真实原型。结论：**原生 CLI 交互路径可行，首版自动收尾写入隔离尚未通过。** 保持原生 CLI 的已确认产品方向；在建立新的隔离边界前，不能将回合完成或进程退出等同于安全开始检查、交付。

## 验证环境与原始来源

- macOS 26.6.1 arm64，Node.js 24.15.0，Python 3.12，Codex CLI 0.155.1。
- 使用本机已有 Codex 登录，新建临时工作区、专用 Unix socket 和探针会话；未连接已有 Desktop 会话或修改全局配置。
- 真实推理模型为 `gpt-6-astra`。配置默认的 `gpt-6.1-sol` 与另一次尝试的 `gpt-5.4` 均被账户服务拒绝；可列出的模型不等于已验证可调用。
- `approvalPolicy=on-request`、`approvalsReviewer=user`；问答场景使用 Plan 模式，审批场景使用只读沙箱，其余使用 workspace-write。
- 两个 JSON-RPC 观察连接保持在线；原生 CLI 根据明确 thread ID 连接同一端点。探针仅通过原生终端按键处理夹具请求，观察连接没有代答。

一次性代码与证据保存在 [原型分支](https://github.com/Vamdawn/raven-zero/tree/codex/prototype-codex-native-isolation/prototypes/codex_native)，固定提交为 [`5fdc2d44`](https://github.com/Vamdawn/raven-zero/tree/5fdc2d44c1495949f2c9fe2f4d858807c5c683b0/prototypes/codex_native)。主分支仅保存验证结论，不引入生产适配器或原型代码。

原型目录包含运行说明、五个场景的协议摘录与结果、关键生成协议类型、CLI 包装器退出确认代码摘录，以及单文件 HTML 回放。提交的证据只保留相关事件并规范化个人路径；完整原始日志保留在本机临时目录。

## 已验证行为

| 场景 | 实际观察 | 结论 |
| --- | --- | --- |
| 已有问答附着 | 先收到阻塞的 `item/tool/requestUserInput`，无 CLI 时仍等待；随后原生 CLI 显示问题，选择 Blue，回合成功完成 | 通过 |
| 已有审批附着 | 只读沙箱中的临时文件写入先产生 `item/commandExecution/requestApproval`；原生 CLI 只批准一次后，文件内容为 `approved` | 通过 |
| 多连接观察 | 两个连接收到同一 thread、turn、request ID 的请求、解决通知与完成事件 | 通过；没有验证同时回答竞争 |
| 原生 CLI 断开 | `sleep 12; printf continued > disconnect-marker.txt` 已开始执行时，附着并断开 CLI；之后文件产生，两个观察连接收到成功完成 | 通过；没有验证全部订阅连接断开 |
| 回合完成后继续写入 | 收到成功的 `turn/completed` 后，从同一 CLI 发起新回合，成功写入 `after-completion-marker.txt=late` | 完成事件不是写入隔离 |
| 归档 | `thread/archive` 返回后已不在 loaded list；直接 resume 报 archived，取消归档后 resume 成功且 `canAcceptDirectInput=true` | 能卸载并阻止直接恢复；不是永久隔离 |
| 关闭专用服务端 | 确认 app-server 退出后，原生 CLI 显示断线并尝试重连；新的目标文件未产生 | 阻止该端点上的 CLI 新请求，不能据此证明所有后台写入停止 |
| 脱离会话的后台进程 | 真实任务用 `start_new_session=True` 启动子进程；回合结束时目标文件不存在；确认 app-server 退出后释放夹具，仍产生 `late background write` | 关闭服务端也不足以建立完整隔离 |

五个最终探针均成功运行并保留结果。隔离场景的成功运行是成功重现反例，不表示产品隔离验收通过。没有用模拟 Agent 结果替代真实验证。

## 后台写入反例

1. 任务运行 `python3 launch_background.py`，启动脱离原进程组的 `linger.py`。
2. 子进程写入 ready 标记，等待 `release-background.txt`，最多等待 45 秒。
3. Agent 完成回合；此时晚到的输出文件还不存在。
4. 探针向专用服务端进程组发停止信号，并等待 app-server 的 native 进程退出。Codex 的 Node 包装器转发信号后等待 native child 的 exit，证据中保留对应代码。
5. 探针才写入释放文件，随后观察到 `after-server-exit-background.txt=late background write`。子进程写完退出。

这是受控临时目录中的实际文件变化，证明进程组退出不覆盖已经脱离该进程组的写入者。全部本次探针进程与夹具子进程已退出，失败现场与证据目录保留。

## 对实现的约束

后续隔离契约与验收条件记录为 [Issue #1](https://github.com/Vamdawn/raven-zero/issues/1)，原型分支与固定提交已在该任务中关联。

继续使用 [ADR 0018](../adr/0018-codex-app-server-binding.md) 的 app-server 与准确会话的原生 CLI 附着方案。本次结果不支持把以下事实单独作为交付阶段入口：

- Agent 最后一条消息或 `turn/completed`。
- 原生 CLI 关闭。
- 会话归档或停止请求已发出。
- 专用 app-server 的进程或进程组退出。

实现前需要决定如何隔离任务子进程与工作区写入，再验证待答请求、已打开文件、后台进程和重连边界。候选包括任务级进程与文件系统隔离；如果选择切换到独立交付工作区，则涉及当前规格中工作区与交付边界的调整，需要重新确认。**本次只记录阻碍，没有代替用户选择或修改已确认体验。**

后续用户授权按独立交付工作区方案推进。[ADR 0020](../adr/0020-protected-delivery-workspace.md)与[隔离契约](delivery-workspace-isolation.md)记录新的工作区边界及第二轮真实验证；上述反例仍有效，新方案保护交付成果，不声称原任务工作区上的后台写入已经停止。原生 CLI 交互方向保持不变，完整正式验收仍由 Issue #1 跟踪。

## 本版本的接入差异

- 请求 `ThreadStartParams.sandbox` 的值为 `workspace-write` / `read-only`，响应 SandboxPolicy 的 discriminator 为 `workspaceWrite` / `readOnly`。以本机生成协议为准。
- `app-server proxy --sock` 连接本次 `--listen unix://PATH` 端点时，服务端报 WebSocket HTTP 握手错误。直接在 Unix socket 上建立 WebSocket，以及原生 CLI `--remote unix://PATH` 均可用。
- 新 thread 首次 `turn/start` 前，第二连接的 `thread/resume` 曾返回 `no rollout found`；最终探针先开启回合，再订阅观察。
- 一个待答场景中，SIGTERM 后服务端未在 15 秒内退出；不能把信号发送当成停止确认。最终探针在超时后明确终止自己创建的专用进程组，并等待退出。

官方 [app-server 文档](https://learn.chatgpt.com/docs/app-server)用于核对协议与连接方式，实际行为由本次目标版本验证。原型的最小 WebSocket 实现不能直接作为生产传输库。

未验证 Linux、Codex App UI、零观察连接、所有模型与权限配置、任意后台进程的回收，以及 Raven Zero 的完整检查和交付生命周期。HTML 回放通过了 JavaScript 语法检查；内置浏览器安全策略拒绝 `file://`，未做页面视觉验收。

## 测试对个人 Codex App 状态的影响

用户反馈测试期间 App 出现大量工作区，干扰正常使用。随后只读核对创建日志与个人 `state_5.sqlite`：19 个可从探针日志证明归属的 thread ID 中，17 个仍在个人数据库内，16 个未归档，关联 17 个不同临时工作目录。没有对应的新注册项目；本次受管理的 Git worktree 只有一个。临时工作区分组和持久会话残留不能等同于 Git worktree 数量。

探针用默认用户状态目录启动 app-server，所有已记录的 `thread/start` 响应均为 `ephemeral=false`。停止进程的 `finally` 没有归档会话。子进程还继承了 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop`，数据库内这些会话的 `source=vscode`、`originator=Codex Desktop`。即使通信端点与任务目录独立，会话历史仍进入了个人 Codex 状态。这是原型的隔离遗漏；原生交互通过的结论仍成立，但不能声称测试不影响个人 App。

反馈命令为 `python3 /tmp/raven-codex-pollution-audit.py`：仅根据探针创建日志中的 ID 查询个人数据库，发现未归档记录时退出码为 1。本次结果为 16 条，未为复现新增个人会话。直接检查 Codex App UI 被工具安全策略拒绝，工作区展示方式未做界面核验；数据库中的污染记录与来源已核实。

建议分开处理现有残留与后续隔离：

- 现有残留：以创建日志中的 ID 和对应临时 cwd 双重确认归属，先保留证据，再通过会话归档能力处理已确认的测试记录；清理后重新核对个人未归档记录与 App 分组。不能按模糊目录名删除所有用户会话，也不直接改写运行中 App 的数据库或状态 JSON。本次分析没有执行归档或删除。
- 后续测试：app-server 和原生 CLI 必须使用同一个专用 Codex 状态根，并保持个人 App 的状态根不变；启动后校验服务端返回的 `codexHome`，不能静默回退到个人目录。登录与所需配置在专用环境初始化，不整体链接个人 `.codex`。本轮未执行这种隔离环境的新实验，真实问答与审批需在那里重跑。
- 客户端阶段决定（2026-10-07 用户确认）：初版复用个人 `CODEX_HOME`，后续再使用客户端专用且持久的 Codex 状态根。初版各任务仍使用独立工作区与准确会话身份，但任务会话可能进入个人 Codex App 历史；不能宣称个人 App 状态已隔离。测试使用专用状态根的建议仍保留，避免重复污染个人状态。
- `ephemeral=true` 可作为纯协议探针的补充，但不能未经验证地用于需要重启恢复和原生 `resume <ID>` 的任务。仅改变 SQLite 目录、会话标题或 `clientInfo` 不足以完整隔离状态。
- 测试验收增加个人状态不受影响的条件：连续运行与异常退出后，个人数据库新增测试会话为零，App 新增测试工作区分组为零；证据独立保留，专用测试状态有明确保留与清理生命周期。

官方 [环境变量文档](https://learn.chatgpt.com/docs/config-file/environment-variables)将 `CODEX_HOME` 定义为配置、认证、日志与会话等状态的根；`CODEX_SQLITE_HOME` 仅控制 SQLite 状态位置。[认证文档](https://learn.chatgpt.com/docs/auth)说明凭证可能位于该状态根或系统凭证存储，独立状态环境的登录需要单独设计。上述方案不改变此前暴露的后台写入隔离问题：个人 App 状态隔离与任务工作区写入隔离是两个不同要求。
