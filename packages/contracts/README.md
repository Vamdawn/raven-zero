# 核心 JSON 契约

Issue #3 / #4 / #5 的 Task、Task Run、Workflow、结果、Git 参数／证据及服务端通信契约。Zod 4 是唯一来源，TypeScript 类型从 schema 推导；对象拒绝未知字段，JSON Schema 使用 draft 2020-12 导出，不可表达类型时报错。

工作流只定义任务及依赖，不在本包执行调度。初始化文件的 `source` 是本地输入文件；HTTP 下载属于后续客户端切片。

服务端契约扩展同一 Task / TaskResult 定义，限定可持久化的 ID、能力与版本范围；ServerTask 记录领取状态、归属、取消请求和客户端进度，与本地 TaskRun 的工作区及执行阶段记录分开。
