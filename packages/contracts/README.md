# 核心 JSON 契约

Issue #3 的最小 Task、Task Run、Workflow 与结果契约。Zod 4 是唯一来源，TypeScript 类型从 schema 推导；对象拒绝未知字段，JSON Schema 使用 draft 2020-12 导出，不可表达类型时报错。

工作流只定义任务及依赖，不在本包执行调度。初始化文件的 `source` 是本地输入文件；HTTP 下载属于后续客户端切片。
