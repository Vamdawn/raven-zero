# Raven Zero

编排、调度和执行 AI 工作任务的框架。当前已实现 macOS Codex 工作阶段隔离模块，以及使用模拟 Agent 的本地报告任务。完整客户端与服务端按[实施计划](docs/design/implementation-plan.md)推进。

```sh
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm test
```

[模块接口与环境要求](packages/codex-adapter/README.md) · [隔离契约](docs/design/delivery-workspace-isolation.md) · [验收及限制](docs/research/macos-process-boundary.md)

[核心 JSON 契约](packages/contracts/README.md) · [本地报告任务与嵌入示例](packages/local-runner/README.md)：本地执行使用明确标记的模拟隔离，真实 Codex 接入由后续切片验收。

[提交检查与真实验证收尾](docs/agents/validation.md)：`pnpm check` 执行差异检查、严格构建、模块行为测试与工具测试。钩子安装保留已有 pre-commit；完整检查使用已验收的本机 macOS 环境。
