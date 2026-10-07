# macOS Codex 工作阶段边界验收

2026-10-08，Issue #1 的内部隔离模块位于 `packages/codex-adapter`。本记录覆盖已实现的进程监督、安全发布与原生交互组合；完整客户端的调度、执行记录、检查、Git 和上报仍按实施任务图推进。

## 结论与范围

已验证 macOS 26.6.1 arm64、非 root GUI 用户、Codex CLI 0.155.1、Node.js 24.15.0、pnpm 11.0.9、Python 3.12、真实模型 gpt-6-astra。精确依赖记录于 pnpm-lock.yaml；ws 8.22.0、Zod 4.6.5、TypeScript 7.0.2。启动拒绝未验收系统或 Codex 版本。

个人 CODEX_HOME 复用认证、配置和准确会话，Codex 元数据数据库放在独立执行根。首次创建任务身份、Raven SQLite 执行记录和调度由调用方负责。实测复用旧的准确测试身份，未创建新会话、managed worktree 或永久 LaunchAgent；个人配置字节保持不变。App 视觉分组、Linux、其他网络目标和第三方工具未列入兼容承诺。

## 进程覆盖与代际

进程组不能覆盖 setsid 脱离的后台命令。macOS kqueue NOTE_TRACK 在本机返回 EOPNOTSUPP，不能当成已工作的监督机制。

临时 GUI launchd 作业建立独立 resource coalition；可信 native launcher 先完整刷盘 admission，再执行 sandbox-exec 和 Codex。fork/exec 后代继承资源范围，不需要 Agent 协作登记。launcher 退出、子进程重新挂到 launchd、setsid、持有源文件句柄或忽略 TERM，都不会使该进程脱离资源计数。

停止反复查询 coalition 的 started/exited 计数，枚举其成员并通过 audit-token 的 PID/version 发送信号；宽限后用 KILL。全部计数相等后先持久记录 empty，再移除精确作业并保存 stopped；两种记录均原子发布。控制进程在 bootout 后、stopped 写入前崩溃，恢复仍能核对 empty，避免已回收的内核计数使恢复无从确认。PID 枚举期间重新核对 unique ID/version，内核拒绝过期 audit token；测试实际得到 ESRCH。邻接作业保持存活，伪造另一合法 coalition 的输入无法绕过持久 admission 核对。

记录包含 boot UUID、精确 launchd target、coalition 和规范目录，重启清理使用同一记录。Apple 源码的 coalition ID 按启动期间递增；跨系统启动不复用同一 boot 身份。原生 launcher 通过有效的 explicit-coalition spawn 属性执行启动自检，必须返回 EPERM；root、权限或 ABI 不符拒绝准入。未确认范围不降级到 kill(pid) 或几个已知夹具 PID。

依据为 Apple 的公开源码，使用到的接口属于私有 ABI，公开源码不等于稳定支持承诺：

- [XNU coalition 生命周期、继承和资源计数](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/coalition.c)。
- [显式 coalition spawn 的权限检查](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exec.c)。
- [proc_info 的 generation/audit-token 检查](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c)、[私有结构定义](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_info_private.h)。

以上用于解释本机实测机制；未声称当前 XNU 源码与本机私有二进制逐字相同。native helper 校验结构大小与返回长度，平台按实测版本固定。

## 原生交互与入口控制

观察连接持续在线；问答、审批由准确会话的原生 CLI 处理，waiting 不自动回答、不关闭界面、不发布。同步切断输入后，核对最新回合，再停止整个 Agent 资源范围。断开的观察连接、失败回合、未完成原生输入或未知结果阻止发布。归档仅用于准确测试身份收尾，正常调用方保留会话。

Seatbelt 默认拒绝；任务子进程继承外层，原生批准不能解除。允许必要的系统服务、准确私有 Unix 端点及固定 TCP4 模型出口。外部 Unix/IPv4/IPv6 执行服务、未知 Mach 服务、UDP、其他 loopback 地址均受拒绝策略约束。个人可执行数据、其他 rollout、配置、自动化和记录保护由实际拒绝测试核对；同一会话原生恢复配置强制关闭 MCP、插件、hooks、apps、浏览器、computer-use、自动化和多 Agent。远程环境不接入。

普通工作请求使用生成协议的 externalSandbox，解决内外 Seatbelt 嵌套 EPERM。显式只读审批仍保持原生处理。原生网关锁定身份、cwd、工作区根和功能配置，不接受替代历史/path 或其他任务身份。

[Codex 0.155.1 Seatbelt 源码](https://github.com/openai/codex/tree/rust-v0.155.1/codex-rs/sandboxing/src)提供必要系统服务基线；实际允许列表见模块源码。此范围不包括任意个人插件、宿主特权 broker 或自定义网络目标；这些入口没有获得执行许可。

## 模型代理的崩溃边界

单纯让控制进程持有 TCP listener 不够：控制进程崩溃释放端口，存活 Agent 的出口许可可能指向后续占用该端口的外部服务。

实现使用临时 launchd socket activation，监听 descriptor 由 launchd 持有。可信 native broker 校验 IPv4 loopback、传递 descriptor 给 Node，再发布 ready。控制进程或工作进程被 SIGKILL 后，其他服务绑定该端口得到 EADDRINUSE；移除精确作业后才可重新绑定。独占 admission 防止 socket 再次激活时启动另一代理工作进程。Agent 停止未知时保留监听作业，重启 stopExecution 固定先停止 Agent、后停止代理。

Seatbelt 的 `remote ip` 包含 TCP/UDP 及 IPv4/IPv6，单独保留一个 IPv4 TCP listener 不足以保护其他协议。实测改为 `remote tcp4 localhost:<port>`：必要出口成功；IPv6、127.0.0.2 和同端口 UDP 返回 EPERM。数字主机地址的策略语法返回错误，不能把未生效规则当成隔离。

代理仅接受 CONNECT chatgpt.com:443，不转发任意 HTTP、其他目标或调用者 Host。可选上游限定无凭证的 localhost HTTP 代理；模型 TLS 内容不记录。其他 Agent 网络目标不开放，客户端 Git 交付属于后续受控阶段。

依据：[本机 macOS SDK launch.h 的 launch_activate_socket](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/launch.h)、[Node 24 已绑定 descriptor 的 listen 接口](https://nodejs.org/docs/latest-v24.x/api/net.html#serverlistenhandle-backlog-callback)。本机 SDK 与真实 EADDRINUSE 实验是采用该机制的直接证据。

## 成果发布与持久恢复

确认 Agent 停止后，原生 copier 以目录 descriptor/openat/O_NOFOLLOW 读取；独立文件 inode、执行位和安全内部相对链接保留，.git 排除。绝对、逃逸、悬空、循环、目录别名加 .. 的逃逸链接以及特殊文件拒绝；包括 __proto__ 的合法文件名通过清单数组与 own-property 校验保留。

每版随机 staging，清单包含准确 run/thread/generation、文件 SHA-256、目录和链接。文件执行 fsync/F_FULLFSYNC，递归目录同步，清单刷盘后独占 rename 发布；父目录同步后再次完整刷盘清单。恢复核对保存内容、身份和链接，再重复持久屏障；未完成 staging 排除，发布后丢失回执复用同一版，不重跑 Agent，篡改拒绝。

实际 SIGKILL 涵盖发布器与原生复制器整个资源范围，验证残留 staging 不进入检查、重试用新 staging、旧版保持不变、发布后同版核对及篡改检测。此前原型还保存了复制、树、清单、发布、记录五处崩溃实验。

持久性实现依赖 macOS fsync、F_FULLFSYNC 和文件系统正确兑现同步语义。未进行物理断电、整机重启、损坏磁盘或不遵守 flush 的存储设备实验；不能把 SIGKILL 结果描述为物理断电实测。文件系统/API 错误保留现场并返回待核对。

## 验收证据

`pnpm test`：13 项检查通过，覆盖未登记 orphan、过期 PID generation、其他作业不受影响、准入权限、原生网关竞争、控制进程/代理 SIGKILL 端口保留、bootout 后停止回执丢失与恢复清理顺序、发布与链接、发布崩溃以及 Home/网络保护。TypeScript 严格编译通过，ESM 入口与 CommonJS dynamic import 可消费。

真实 Codex 最终构建通过原生问答、直接原生 CLI 普通命令、原生审批、待答不发布、持有源文件句柄的未登记 setsid 后台进程、成果/记录/hardlink 写入拒绝、完整范围停止后发布、晚到 CLI 输入及重连阻断、同身份/工作区恢复、v2 保留 v1、同版恢复、活动命令取消和调用方期限停止。正常回合后故意损坏 admission 的真实负向验收返回 pending_verification、不发布 v5，保留工作区和模型监听；修复准确旧记录后取消确认，v1/v2 保持不变。失败探索也保存，不以失败试验替代通过结果。[原型固定提交 7bc9e44：一次性探针、最终协议、终端、13 项检查与失败探索](https://github.com/Vamdawn/raven-zero/tree/7bc9e443c020981f6213ef948cf3c6b6e4e1ecb4/prototypes/delivery_isolation)。最终构建及源码指纹记录在 evidence/production-adapter/，真实负向验收见 unknown-stop.json。

后续完整客户端把 publication 与停止证明写入 Raven 执行记录后才释放名额、开始检查；调度取消/期限、产物版本归属在 #3/#6/#7 验收，Git 元数据与可信交付在 #4 验收，真实 HTTP 全链路在 #8 验收。它们继续依赖本模块的安全入口，不重新放宽 Agent 权限。
