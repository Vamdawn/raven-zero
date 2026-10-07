# Codex 本地交互接入调查

## 产品约束

Agent 执行中的问答与本地权限审批由客户端处理，优先使用对应 Agent 自身的交互界面。首版已确认允许 Codex 原生终端界面，Codex App 接入另行验证。

## 已建立的官方能力

- [app-server 文档](https://learn.chatgpt.com/docs/app-server)提供双向审批协议、线程订阅，以及 Codex 原生终端通过 `--remote` 连接 app-server 的方式。
- 本机 Codex `0.155.1` 帮助包含 `app-server proxy --sock` 和 `resume <SESSION_ID> --remote`。
- 官方源码索引显示，多订阅连接处理待答请求以及原生终端附着已有任务具有技术基础；索引混入 `main` 版本，尚不能作为本机精确版本的行为保证。

## 尚未建立的能力

尚未找到公开契约，保证已有 Codex App 会展示外部框架启动的任务，并处理这些任务的待答请求。[官方远程连接文档](https://learn.chatgpt.com/docs/remote-connections)描述 App 管理的连接流程，不能据此推定任意外部框架可接入 App 内部服务。

前期只读检查发现默认 CLI shared daemon 的 control socket 当时不存在，不能假定它与当前 Desktop App 使用同一个服务。该轮调查没有启动真实任务、连接私密会话或读取认证数据。

## 2026-10-07 真实原型验证

Codex CLI 0.155.1 的准确会话附着、附着前产生的问答与审批、两个连接观察，以及 CLI 断开后的继续执行已通过真实探针验证。自动收尾隔离尚未通过：回合完成后仍能继续输入并写入，关闭专用 app-server 后脱离会话的子进程仍能写入。完整证据与边界见 [验证记录](codex-native-validation.md)。

## 后续验证要求

- 按[交付隔离契约](delivery-workspace-isolation.md)实现并验证受保护的独立交付工作区，不把回合完成、归档或进程退出单独作为交付入口；macOS 最小验证不替代 Linux 原生路径及正式权限组合验收。
- 只有实际建立 App 接入路径并验证后，才将 Codex App 原生界面列为支持能力。
