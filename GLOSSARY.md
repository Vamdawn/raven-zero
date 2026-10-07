# Raven Zero

Raven Zero 是用于编排、调度和执行 AI 工作任务的框架。服务端将任务交给客户端，客户端通过 Agent 完成具体工作并报告结果。

## Language

**服务端（Server）**：
编排与调度 AI 工作任务、接收客户端执行结果的一方。

**客户端（Client）**：
连接服务端与执行环境、调用 Agent 完成任务并报告结果的一方。
_Avoid_: Agent

**Agent**：
客户端连接的 AI 工作执行工具，例如 Codex 或 Claude Code。
_Avoid_: 客户端

**Agent 适配器（Agent Adapter）**：
客户端与一种 Agent 之间的对接组件。

**Agent 工作会话（Agent Work Session）**：
Agent 为一个任务开展工作的专用上下文，与用户日常使用的其他会话分开。

**任务（Task）**：
需要 Agent 完成、带有自身完成要求的工作。

**任务执行实例（Task Run）**：
一个任务的一次具体执行，具有独立的进度和成果。

**工作流（Workflow）**：
预先定义的一组任务及其依赖关系。

**任务工作区（Task Workspace）**：
供一个任务开展具体工作的独立目录。

**交付工作区（Delivery Workspace）**：
保存一个任务执行实例本版成果、供完成检查与交付使用的独立目录，与 Agent 继续工作的任务工作区分开。

**完成条件（Completion Criteria）**：
任务指定的、用于判断其是否完成的要求。

**交付组件（Delivery Component）**：
客户端用于执行任务指定交付动作的可选组件。

**交付物（Deliverable）**：
任务产生并提交的工作成果，例如已推送的 Git 分支、报告文件或结构化分析结果。

**文件产物（File Artifact）**：
任务产生并上报、可供后续任务下载使用的文件。
