# Raven Zero

编排、调度和执行 AI 工作任务的框架。当前已实现 macOS Codex 工作阶段隔离模块，完整客户端与服务端按[实施计划](docs/design/implementation-plan.md)推进。

```sh
pnpm install --frozen-lockfile
pnpm test
```

[模块接口与环境要求](packages/codex-adapter/README.md) · [隔离契约](docs/design/delivery-workspace-isolation.md) · [验收及限制](docs/research/macos-process-boundary.md)
