# PROTOTYPE：Codex 原生交互与收尾隔离

这是一次性兼容性探针，不是 Raven Zero 的生产适配器。

回答的问题：框架用 app-server 创建的专用 Agent 工作会话，能否由原生 CLI 接手本地交互，以及工作阶段结束后能否可靠隔离后续写入？

2026-10-07，macOS 26.6.1 arm64，Codex CLI 0.155.1，Node.js 24.15.0，Python 3.12。真实执行使用 `gpt-6-astra`；本机配置默认的 `gpt-6.1-sol` 被 ChatGPT 账户服务拒绝，`gpt-5.4` 也被拒绝。`model/list` 只是候选目录，实际成功回合才证明本次访问成立。

## 结论

| 验证 | 结果 |
| --- | --- |
| 根据明确会话 ID 附着已有工作 | 通过 |
| 附着前产生的问答由原生 CLI 处理 | 通过；先等待，再经终端按键回答 |
| 附着前产生的审批由原生 CLI 处理 | 通过；只批准一次临时文件写入 |
| 两个连接观察同一请求、结果 | 通过；两个连接均未代答 |
| CLI 在命令运行中断开，工作继续 | 通过；之后产生 `continued` 文件 |
| `turn/completed` 阻止后续写入 | 不成立；原生 CLI 再次输入成功写入 `late` |
| 归档形成不可重新打开的隔离 | 不成立；直接恢复被拒，但取消归档后可接受输入 |
| 关闭专用 app-server 阻止 CLI 新请求 | 本次通过；CLI 显示断线并重连，目标文件未产生 |
| 关闭 app-server 停止所有后台写入 | 不成立；脱离会话的子进程在服务端退出后写入文件 |

**结论：原生交互路径可行；首版自动收尾隔离尚未通过。** 不得将回合结束、归档或 app-server 进程退出单独当作安全检查和交付的入口。

## 运行

需要 `codex`、Python 3.12 和已有可用的 Codex 登录。无需安装项目依赖。每次运行使用新的 `raven-PROTOTYPE-*` 临时目录和独立 Unix socket。不会连接现有 Desktop 会话，也不会修改全局配置；新建探针会话使用 Codex 默认会话存储。

在仓库根目录运行任一场景：

```bash
python3 prototypes/codex_native/probe.py question --model gpt-6-astra
python3 prototypes/codex_native/probe.py approval --model gpt-6-astra
python3 prototypes/codex_native/probe.py disconnect --model gpt-6-astra
python3 prototypes/codex_native/probe.py isolation --model gpt-6-astra
python3 prototypes/codex_native/probe.py background --model gpt-6-astra
```

每次打印 `EVIDENCE=...` 和 `SAVED=...`。运行异常退出码为 1；场景成功执行并不代表隔离通过，应检查结果字段。完整本地 JSONL 保留协议数据，不适合原样公开；提交的 `evidence/` 是仅保留相关事件、规范化个人路径后的证据摘录。

`approval` 场景通过真实原生 TUI 按一次 Enter，只允许指定临时文件写入；没有启用框架自动审批或会话级许可。`question` 场景在 Plan 模式产生问题，再按 Enter 选取夹具选项；不证明 Default 模式会主动产生同样问题。

`background` 场景由真实 Codex 执行启动脚本。子进程通过 `start_new_session=True` 脱离原进程组，等待释放文件；确认 app-server 退出后才释放，随后发现写入。它在释放后立即退出，未释放也在 45 秒后退出，不触碰临时目录之外的文件。

双击 [replay.html](replay.html) 可回放结论对应的状态变化。它是基于实测结果的内存演示，不运行 Codex，也不能替代真实探针。

HTML 回放已完成 JavaScript 语法检查；内置浏览器安全策略拒绝打开 `file://`，未做页面视觉验收。

## 精确版本差异

- 协议来自本机 `codex app-server generate-ts --experimental` 与 `generate-json-schema --experimental`，生成命令和关键原始类型摘要见 `protocol/`。
- `ThreadStartParams.sandbox` 使用 `workspace-write` / `read-only`；响应中的 SandboxPolicy 使用 `workspaceWrite` / `readOnly`，不能混用。
- 本次 `app-server proxy --sock` 向 `--listen unix://PATH` 端点发送数据时，服务端报 HTTP/WebSocket 握手错误。探针改为直接使用 Unix socket 上的 WebSocket；原生 CLI `--remote unix://PATH` 可以连接。
- 在新会话首次 `turn/start` 前，第二连接调用 `thread/resume` 曾返回 `no rollout found`。探针先开启回合，再订阅观察；不能将刚取得 thread ID 当作已落盘可附着。
- 原生 CLI 的更新提示使用进程内 `check_for_update_on_startup=false` 关闭；没有升级目标版本。

Python 中的 WebSocket 实现仅满足本次本地探针的数据帧，不能当作生产传输库。没有生成生产工程、适配器或数据库代码，也没有为原型增加单元测试。

## 后续决策

保持已确认的原生 CLI 交互路径。实现前需要确定如何限制任务子进程的写入能力，并验证待答请求、已打开文件、后台进程和重连的停止边界。候选是任务级进程与文件系统隔离，或改变交付阶段的工作区设计；后者会改变当前规格中的边界，应由用户确认，不能静默采用。

本次没有验证 Linux、Codex App UI、任意任务的业务完成要求，也没有证明所有可能子进程均可被回收。

官方参考：[app-server](https://learn.chatgpt.com/docs/app-server)。文档说明协议与原生连接能力；上表的行为结论来自本次真实运行，而非文档推断。
