# PROTOTYPE：交付工作区与外层写入限制

问题：独立目录副本是否足以隔离 Agent 的晚到写入？如果框架从任务启动起保护交付目录和执行记录，能否保留原生交互与显式恢复？

结论：副本本身不够。macOS Seatbelt 外层限制下，真实 Codex 0.155.1 原生问答、审批、普通命令、晚到 CLI 请求、脱离服务端的后台进程与同会话重启恢复通过最小实验。Linux 容器中的真实文件写入实验通过；**没有验证 Linux Codex 原生路径或生产隔离实现**。

## 运行

在仓库根目录运行：

```sh
python3 prototypes/delivery_isolation/probe.py control
python3 prototypes/delivery_isolation/probe.py macos
python3 prototypes/delivery_isolation/probe.py linux
python3 prototypes/delivery_isolation/codex_probe.py --evidence prototypes/delivery_isolation/evidence/codex-final
python3 prototypes/delivery_isolation/codex_probe.py --personal-home --evidence prototypes/delivery_isolation/evidence/codex-personal
python3 prototypes/delivery_isolation/edge_probe.py
```

macOS 探针需要本机 Python、Git 与 sandbox-exec。Linux 实验使用现有 Docker 与 `node:24.15.0-bookworm-slim`，不安装系统服务。真实 Codex 探针使用已有文件认证缓存，仅将 `auth.json` 暂存到权限 0700 的测试 Home；退出删除缓存及测试 Home，不复制个人配置或整体链接个人目录。模型为本机已验证的 `gpt-6-astra`。临时凭证不写日志、不提交。

双击 `index.html` 可操作同一边界的纯状态模型，包含自由操作与八个场景；页面是说明模型，不代替真实实验。

2026-10-08 起初版验证仅针对 macOS；Linux 命令和证据保留为历史探索。个人 Home 探针每轮仅创建一个准确记录身份的会话，最终通过协议归档；`thread/start` 会新增该临时目录的信任条目，退出仅清理自己新增且内容符合预期的条目，不恢复覆盖整个个人配置。归档记录仍保留在个人 Home，未核验 App 的视觉分组消失。

## 已保存的证据

- `evidence/control.json`：九种攻击均成功，目录副本和记录被修改。
- `evidence/macos.json`：绝对路径、相对路径、符号链接、硬链接、文件替换、删除、权限修改、受控根目录改名和记录写入均返回 EPERM；原工作区已打开的句柄仍可写；副本不变。
- `evidence/linux.json`：对应容器内访问返回 EROFS / EXDEV；原工作区句柄继续写；交付挂载与记录不变。控制端为 macOS，写入者为 Linux 容器进程。
- 上述两个文件实验实际执行副本中的检查命令、向本地 Git bare remote 推送 v1，然后恢复并发布 v2；远端 v1 提交仍保持原身份和内容。
- `evidence/codex-final/`：最终真实 Codex 完整探针；原生 CLI 回答 Blue、批准启动夹具一次、批准晚到写入一次（仍被外层拒绝），确认服务端退出后释放后台进程；后台九种访问被拒绝。重启服务端恢复同一 thread ID、同一原工作区，生成 v2 而 v1 不变。该 thread ID 在个人数据库中不存在。
- `evidence/codex/`：第一次探索失败记录。嵌套 Seatbelt 让正常命令报 `sandbox_apply: Operation not permitted`，重启后请求额外审批并超时；不能作为成功验收。最终探针普通工作和恢复使用目标版本的 `externalSandbox`，审批夹具仍由原生 CLI 处理。
- `evidence/codex-personal/`：复用本机个人配置，问答、普通命令、原生审批、晚到写入隔离及同身份恢复通过；待答问题和待批命令中断后不写文件，观察连接重连保持同身份。准确测试身份已归档，个人配置字节保持不变。
- `evidence/codex-personal-exploration/`：首轮因个人配置被 `thread/start` 自动添加信任条目而断言失败，已归档该准确身份；定位后清掉自己新增条目，修正收尾再验证。保留失败证据。
- `evidence/codex-personal/lifecycle*.json`：真实前台命令在 `interrupted` 事件后仍存活，释放夹具后实际写文件；回合中断不能证明取消完成。模拟本地超期时，框架对准确夹具 PID 发 SIGTERM 并确认消失后，释放不再写文件。仅验证单个夹具，未实现通用进程监督器。单独重跑使用上一命令打印的自有 RUNTIME：`python3 prototypes/delivery_isolation/lifecycle_probe.py <RUNTIME>`，只取消归档并恢复其中记录的自有会话，最后再次归档。
- `evidence/macos-edges.json`：确定性链接替换让旧 freeze 导出外部链接；描述符相对读取及 O_NOFOLLOW 拒绝文件与目录替换。普通文件复制打断硬链接并保留执行位，版本清单识别篡改，SIGKILL 留下的 staging 不被视为已发布。这里只实现普通文件，内部链接与断电持久性仍未验证。
- 同一边界夹具证明更高可变祖先改名能够绕过旧规则；补全受控祖先链后被拒绝。沙箱外 Unix socket 执行服务可代写保护目录；明确禁止该 socket 的规则阻断此夹具，但不等于全部 IPC/MCP/特权入口已封闭。

## 边界

这是受控夹具，不是安全审计或生产文件复制器。所有任务写入者必须位于同一外层限制内；未验证宿主外部代理、MCP、特权工具或 IPC 转交执行。这些入口未受约束时不能报告已隔离。macOS 示例还保护受控根目录免于改名；真实目录祖先的保护必须由生产实现处理。没有测试宿主私人目录的改名。

复制不是整个活动目录的原子时间点快照；本版检查针对复制后实际保存的内容。copytree 的先检查再复制不能用于对抗并发链接替换，生产发布必须安全枚举、复制与核验，并将未完整发布的版本排除在检查之外。仅保留安全的内部相对链接，拒绝外部输出链接；可执行位保留，副本不与源共享硬链接。

外层策略不会因原生批准或 Codex 改变会话权限而解除。实验的 deny 规则只保护指定成果和记录，不是完整的生产权限配置；个人 Home、其他任务和宿主外部访问需按正式权限策略验收。

成功交付不意味着全部后台进程已停止。取消、超期与再次恢复仍需核对真实执行状态；不能将写入隔离当作停止确认。服务端有一次必须 SIGKILL 才确认退出，探针已等待退出并收回自身夹具进程；容器均删除。未核验 App UI 分组、跨进程持久恢复协议、崩溃发布、任意仓库链接结构或完整检查与交付失败组合。

一次性 Python/HTML 不合入生产；主线只保留设计决定，实施任务继续验证上述剩余条件。

## 下一轮 macOS 验证（2026-10-08）

```sh
python3 prototypes/delivery_isolation/ipc_probe.py
python3 prototypes/delivery_isolation/supervision_probe.py
python3 prototypes/delivery_isolation/publication_probe.py
python3 prototypes/delivery_isolation/codex_probe.py --personal-home --strict-boundary --controlled-egress --evidence prototypes/delivery_isolation/evidence/codex-broker
```

真实探针使用本机已有 localhost HTTP 代理，经只接受 `CONNECT chatgpt.com:443` 的临时出口转发；需要现有 HTTPS_PROXY 为无凭证的 localhost HTTP 代理，本轮本机符合。夹具服务仅绑定 localhost，不记录 HTTP/TLS 内容或凭证。只允许专用 Unix socket 与这个受控出口端口，其他网络与未允许 Mach 服务由默认拒绝策略约束。策略语法核对 [Codex 0.155.1 源码](https://github.com/openai/codex/tree/rust-v0.155.1/codex-rs/sandboxing/src)。这是受控兼容性夹具，未锁定正式网络组件或用户配置。

- `evidence/codex-broker/`：严格策略下真实原生问答、普通命令、审批、晚到写入拒绝、重启恢复通过。复用失败探针创建的准确会话，最终归档；本轮只新增一个会话、零 managed worktree，个人配置保持原样。
- `evidence/strict-ipc.json`：对照能调用外部服务，默认拒绝夹具阻断 Unix/IPv4/IPv6 外部服务与未允许的 Mach 服务查询；专用 socket 仍可用。出口拒绝本地目标、伪装域名及普通 HTTP 请求，且任务不能直接连接另一 localhost 服务或绕过出口连接公网。
- `evidence/codex-strict/`、`evidence/codex-strict-final/` 和 `strict-exploration.json`：初次未允许 socket 文件创建导致启动失败；单独阻断所有 localhost 又阻断本机推理代理。负向 IP 匹配组合初次意外放行 IPv4，已用明确拒绝规则及仅允许出口端口修正并实测。不能引用这些失败探索为原生验证成功。
- `evidence/supervision.json`：协作登记的子进程脱离父进程组且忽略 TERM；发 KILL 并核对不可运行后，释放夹具不再写文件。完整性未知时模型选择 pending_verification。登记由夹具配合完成，尚未证明任意 Agent 子进程的完整覆盖、PID 重用及重启后代际识别。
- `evidence/publication.json`：内部文件、目录与链式链接保留；拒绝绝对、逃逸、悬空、循环以及目录别名加 `..` 的逃逸链接。独立文件 inode、Git pointer 排除及旧版本保留通过。实际在文件复制、树复制、清单写入、目录发布和记录保存五处 SIGKILL；发布前三处排除 staging，发布后按已捕获且核验的同一版本恢复。清单篡改进入待核对。

文件发布夹具只验证进程崩溃，尚未完成目录 fsync 与断电持久性，也未把这些机制整合为生产发布器。允许的 Mach 系统服务、第三方 MCP/插件、个人 Home 中的全部权限组合及任意进程覆盖继续留在 #1 正式验收；初版 Linux 仍排除。本轮只验证固定模型目标网络，Git 或用户自定义网络目标需要正式受控出口策略，不静默放宽为任意 localhost 服务。


## 内部隔离模块验收（2026-10-08）

本轮将已验证机制实现为主线 `packages/codex-adapter`，本分支只保存一次性桥接、探针和 primary source。完整调度客户端仍由 #3–#8 实现。实际实现版本和证据固定提交由 #1 关联。

```sh
# 在主线实现 checkout 安装并构建，按模块 README 的版本与 GUI 条件运行。
pnpm install --frozen-lockfile
pnpm test
# 然后在本原型分支运行；修改文件顶部 ADAPTER 到主线编译入口。
python3 prototypes/delivery_isolation/adapter_acceptance.py
# 使用上一步打印的准确自有 RUNTIME，验证未知停止范围时不发布。
python3 prototypes/delivery_isolation/adapter_unknown_stop.py <RUNTIME>
```

探针顶部 WORK/THREAD 是本轮已创建且准确归档的专用身份，不自动选择个人会话。换机器需提供自己预先创建且拥有的身份和工作区；未创建新 managed worktree，也未新增会话身份。不将临时 private SQLite 或认证数据提交到分支。

`adapter_bridge.mjs` 调用真实 TypeScript 包，探针自身不实现发布和停止监督。`evidence/production-adapter/result.json` 与四代协议/原生终端证据记录：原生问答、直接原生 CLI 普通命令、原生审批、待答不发布、未登记 setsid 子进程及打开源句柄、成果/记录/hardlink 拒绝、全范围停止后发布、晚到 CLI 输入阻断、重连阻断、同身份与工作区恢复、v2 保留 v1、同版恢复、活动命令取消与调用方超期接口。个人配置保持不变，准确测试身份最终归档；App 视觉分组未验证。

`evidence/production-adapter/automated.json` 记录严格编译、13 项真实本机自动化检查、CommonJS dynamic import、最终源码指纹。自动化检查包括控制进程/代理 SIGKILL 后 launchd 保留模型端口，IPv6/其他 loopback/UDP 同端口拒绝，bootout 后停止证明丢失恢复，未知范围保留模型代理，以及发布器/复制器 SIGKILL。当前 snapshot 保留探索失败，`exploration/notes.json` 解释 rapid paste 未提交与错误空 environments 禁用工具的修正。

`coalition_exploration.py` 保存发现内核资源范围的原始试验；它只对准确自有夹具 PID 发送信号，不能替代生产代际监督。`launch_socket_exploration.c` 保存 SDK 描述符激活探针；生产的端口保留/释放完整测试位于主线模块。启动权限与 audit-token 的完整证明使用生产 native helper 及正式测试。

软件持久性实现 fsync/F_FULLFSYNC 和原子记录/发布；本轮实际故障测试为 SIGKILL，未进行物理断电、整机重启或存储设备失效实验。未开放的 MCP/插件/特权 broker 或其他网络目标不纳入当前兼容范围。

`unknown-stop.json` 与 observer5 记录真实正常回合结束后损坏持久 admission 的负向试验：finish 为 pending_verification、不创建 v5、保留原工作区和代理监听；修复准确旧记录后 cancel 确认，v1/v2 保持不变。
