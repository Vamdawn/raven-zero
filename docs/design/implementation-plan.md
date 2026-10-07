# 首版实施任务图

2026-10-07 完成独立交付工作区的边界决策与最小真实原型，再按可运行的行为切片拆分实现。主任务为 [Issue #2](https://github.com/Vamdawn/raven-zero/issues/2)；2026-10-08 已开始实现 #1 的内部隔离模块；其余业务切片按下表推进。

依据：[首版规格](v1-spec.md)、[技术栈](technology-stack.md)、[ADR 0020](../adr/0020-protected-delivery-workspace.md)和[交付隔离契约](delivery-workspace-isolation.md)。原型固定来源为 [`edbd170`](https://github.com/Vamdawn/raven-zero/tree/edbd170208dc19f306bcf8bbbcf0d461596a9021/prototypes/delivery_isolation)，不合并 Python/HTML 到生产代码。

2026-10-08 用户调整范围：初版只做 macOS 本机运行和验收，Linux 客户端、原生交互及部署验证移到后续。已有 Linux 实验结果保留，不能据此承诺 Linux 支持。

| 任务 | 可验收的切片 | 阻塞依赖 |
| --- | --- | --- |
| [#1](https://github.com/Vamdawn/raven-zero/issues/1) | 正式外层写入边界、生产成果发布、macOS Codex 与停止确认验收 | 无；内部模块及 macOS 验收见隔离记录 |
| [#3](https://github.com/Vamdawn/raven-zero/issues/3) | 核心契约和模拟 Agent：本地报告任务从初始化到本版检查与结果 | 无 |
| [#4](https://github.com/Vamdawn/raven-zero/issues/4) | 本地代码任务：Git 分支交付与提交身份恢复 | #3 |
| [#5](https://github.com/Vamdawn/raven-zero/issues/5) | MySQL 服务端：认证、任务领取、归属与幂等上报 | #3 |
| [#6](https://github.com/Vamdawn/raven-zero/issues/6) | SQLite 客户端：两类任务的 HTTP 端到端执行、补报与恢复 | #4、#5 |
| [#7](https://github.com/Vamdawn/raven-zero/issues/7) | 工作流依赖、文件产物、并发与失败传播 | #6 |
| [#8](https://github.com/Vamdawn/raven-zero/issues/8) | 真实 Codex：原生交互及受保护成果端到端验收 | #1、#6 |
| [#9](https://github.com/Vamdawn/raven-zero/issues/9) | 独立 CLI、嵌入示例与 macOS 发布验收 | #7、#8 |

```mermaid
flowchart LR
  C["#3 本地报告与核心契约"] --> G["#4 本地 Git 交付"]
  C --> S["#5 MySQL 与 HTTP 服务端"]
  G --> L["#6 SQLite 客户端端到端"]
  S --> L
  L --> W["#7 工作流与产物"]
  L --> A["#8 真实 Codex 接入"]
  B["#1 正式隔离验收"] --> A
  W --> R["#9 CLI、嵌入与发布"]
  A --> R
```

执行顺序为：完成 **#1** 的 macOS 内部隔离模块和真实验收，再以 **#3** 的模拟 Agent 加真实文件完成本地报告任务。#3 本身没有技术阻塞依赖；后续 #8 使用已验收的隔离接口验证完整客户端，不能将模拟 Agent 当作真实 Agent 写入保证。

每个 Issue 写明行为、完成条件及阻塞关系；GitHub 原生子任务与依赖关系用于追踪，本文保留可读任务图。实现逐切片运行相关检查，真实 MySQL、SQLite、Git 和 Codex 不互相代替验收。初版复用个人 `CODEX_HOME`，迁移专用 Home 不加入首版实现图；自动测试仍使用隔离状态根。
