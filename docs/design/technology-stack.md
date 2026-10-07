# Raven Zero 技术选型

本轮基于已确认的 [v1 规格](v1-spec.md) 锁定技术框架，Q36–Q52 的选择均已由用户确认。以下是后续实现依据；按用户要求，暂不开始实现。具体依赖补丁版本在实现启动时固定，工具选定不代表真实兼容性已验收。

## 完整技术栈

| 能力 | 已锁定方案 | 适用边界 |
| --- | --- | --- |
| 语言与运行时 | TypeScript、Node.js 24 | 本机 24.15.0 是当前事实核对版本；初版验收 macOS 客户端与本机单实例服务端，Linux 验证留待后续 |
| 核心模块 | 普通 TypeScript 接口、显式依赖传入、显式状态转换 | 核心不绑定应用框架、HTTP、数据库驱动或 Agent 协议类型 |
| HTTP | Fastify、JSON HTTP API、长轮询、OpenAPI 3.1 | 入口可注册到已有 Fastify 实例；文件使用独立流式 HTTP 接口 |
| 契约 | Zod 4 为唯一来源，推导 TypeScript 类型、导出 JSON Schema | 限制为可忠实导出的 JSON 数据定义，对象拒绝未知字段 |
| HTTP 契约桥接 | fastify-type-provider-zod、@fastify/swagger | 复用契约；不可表达的 schema 导出时报错 |
| 服务端状态存储 | MySQL 8.4 LTS、Kysely、mysql2 | 自有连接池与独立 raven_ 表及迁移记录；显式迁移 |
| 客户端执行记录 | SQLite、node:sqlite、参数化 SQL、编号 SQL 迁移 | 接受当前驱动 RC 状态；启动时迁移，短查询与短事务 |
| 文件产物 | 本地文件系统、流式 HTTP 传输 | 文件内容与数据库中的状态、元数据分开 |
| Codex 接入 | app-server、薄 JSON-RPC 适配层、按版本生成的 TypeScript 协议类型 | 首次验证 0.155.1，原生 CLI 附着专用会话；支持范围依据真实验收 |
| 本地命令与 Git | child_process.spawn、系统 Git | 输出、退出、超时与停止确认共用执行入口；使用现有 Git 凭证 |
| CLI 与日志 | Commander、Pino | 独立入口组装；核心只接收可替换日志接口 |
| 工程与发布 | pnpm workspace、TypeScript project references、tsc -b、ESM JS 与 .d.ts | 明确公开导出，CommonJS 消费单独验证 |
| 测试 | node:test、node:assert/strict，编译后运行 | 模拟 Agent 加真实文件、MySQL、SQLite 与本地 Git；真实 Codex 单独验收 |
| 版本锁定 | 精确工具与依赖版本、pnpm lockfile、CI 冻结安装 | 发布模块声明已验证依赖范围；Codex 按真实验收版本记录兼容范围 |

## 已确定的前提

- TypeScript 与 Node.js 24；2026-10-08 用户将初版平台范围调整为 macOS 本机运行和验收，服务端仍为单实例。Linux 客户端及服务端部署为后续验证方向，不作为初版已验证支持范围。
- 服务端使用 MySQL，客户端使用 SQLite；文件产物存储与状态数据库分开，存储实现能够被集成方替换。该数据库调整见 [ADR 0012](../adr/0012-server-mysql-client-sqlite.md)。
- 客户端主动发起 HTTP 长轮询，通过 HTTP 上报结果与产物。
- 框架模块可以嵌入其他项目；独立程序复用这些模块。
- 首个真实 Agent 为 Codex，原生 CLI 负责本地交互；接入行为仍需按目标版本验证。
- 调度、离线恢复与原生交互设计保持有效；交付的工作区边界随后由 [ADR 0020](../adr/0020-protected-delivery-workspace.md)调整为受保护的独立交付工作区，采用已确认的显式阶段与执行接口实现。

## 选型过程

1. 确定核心模块对 HTTP、数据库与应用框架的依赖边界。
2. 选择 HTTP 实现和任务、工作流及通信契约的定义与校验工具。
3. 在上述边界下分别选择服务端 MySQL 与客户端 SQLite 的驱动、查询和迁移方式。
4. 选择 Codex 协议接入工具、进程与 Git 执行、CLI 和日志工具。
5. 确定多包组织、模块发布格式、构建、测试及版本锁定方式。
6. 汇总全部已确认选择；实现阶段遵循用户后续指示。

## 已核对的事实

- [Fastify 插件](https://fastify.dev/docs/latest/Reference/Plugins/)可以注册到已有 Fastify 实例；插件封装不等于核心业务必须依赖 Fastify。
- [Zod 4 的 JSON Schema 导出](https://zod.dev/json-schema)存在不可表达类型与转换；选择 Zod 为协议来源时必须限定到能够忠实表示的 JSON 数据子集。
- [Ajv 的 TypeScript 支持](https://ajv.js.org/guide/typescript.html)可以提供校验后的类型收窄，但 JSON Schema 与 TypeScript 类型的一致性仍需明确生成或推导路径。
- 本机 Node.js 24.15.0 的 [node:sqlite](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)为 release candidate，DatabaseSync 的数据库操作同步执行；选择内置驱动不意味着数据库查询不会阻塞事件循环。
- [mysql2](https://sidorares.github.io/node-mysql2/docs)提供连接池、参数化查询与 Promise 接口，不依赖 native bindings；[Kysely 的 MySQL 方言](https://kysely-org.github.io/kysely-apidoc/classes/MysqlDialect.html)接入 mysql2 连接池，查询构建及数据库结果类型限制在存储实现模块内。

## 第一轮已确认：Q36–Q38

- 核心模块使用普通 TypeScript 接口和显式依赖传入，不绑定统一应用框架或依赖注入容器。HTTP、数据库驱动和 Agent 协议类型限制在对应实现模块内，集成方可直接调用核心能力。见 [ADR 0010](../adr/0010-framework-independent-core.md)。
- 默认 HTTP 实现使用 Fastify，允许将路由插件注册到已有 Fastify 实例；独立服务端组装同一入口。HTTP 框架不拥有调度与执行规则，也不成为集成方直接调用核心模块的前提。
- 任务、工作流及通信契约以 Zod 4 为唯一来源，推导 TypeScript 类型、执行运行时校验并导出 JSON Schema。公开协议仅使用可忠实导出的 JSON 数据定义，对象拒绝未知字段；不使用 transform、不可导出的自定义约束或静默降级，业务检查在核心模块执行。见 [ADR 0011](../adr/0011-zod-contract-source.md)。

## 第二轮已确认：Q39 的数据库调整、Q40–Q41

- Q39 将数据库前提改为服务端 MySQL、客户端 SQLite；具体工具随后由 Q39a、Q39b 确认，不沿用此前两端 SQLite 的组合推荐。
- Q40 使用显式 TypeScript 状态转换，明确合法状态、事件与转换条件并持久保存进度；外部副作用由执行模块处理。见 [ADR 0013](../adr/0013-explicit-state-transitions.md)。
- Q41 使用普通 JSON HTTP API 与 OpenAPI 3.1 描述，数据定义从 Zod 契约导出，客户端提供类型化调用封装，文件使用独立流式 HTTP 接口。见 [ADR 0014](../adr/0014-json-http-openapi.md)。

## 第三轮已确认：Q39a、Q39b、Q42

- 服务端使用 Kysely 与 mysql2，查询、事务和迁移工具限制在 MySQL 存储模块内。连接池及数据库结果类型不暴露到核心模块，数据库值显式映射为核心契约需要的数据。
- 客户端使用 node:sqlite、参数化 SQL 和编号 SQL 迁移，接受当前 Node.js 24.15.0 内置驱动的 RC 状态。客户端记录模型独立于服务端，采用短查询和短事务，事务内不等待网络、Git 或 Agent；后续依据实测决定是否隔离数据库操作。见 [ADR 0015](../adr/0015-separate-database-access-tools.md)。
- 框架维护自己的表与迁移记录；服务端通过显式命令或宿主调用迁移，启动时只检查版本兼容性；客户端启动时迁移自己的本地数据库。MySQL DDL 的隐式提交限制不能由迁移工具消除。见 [ADR 0016](../adr/0016-explicit-server-local-client-migrations.md)。

## 第四轮已确认：Q43–Q45

- 使用 pnpm workspace 管理多包，通过 TypeScript project references 与 `tsc -b` 按依赖顺序编译，不引入 Turborepo、Nx 或额外打包器。
- 发布单一 ESM JavaScript 与 `.d.ts`，明确包的公开导出，使用 Node 模块解析与带 `.js` 的相对导入。不发布必须由消费者直接执行的 TypeScript 源入口；CommonJS 宿主消费方式单独验证。见 [ADR 0017](../adr/0017-multi-package-esm-build.md)。
- 使用 `node:test` 与 `node:assert/strict`，先编译后测试实际 JavaScript 输出；类型检查由 TypeScript 编译独立完成。核心通过显式注入替换外部 Agent，MySQL、SQLite、文件和 Git 按既定验收要求使用真实本地资源验证。

## 第五轮已确认：Q46–Q49

- Codex 使用 app-server、薄 JSON-RPC 适配层和按目标版本生成的 TypeScript 协议类型，使用框架管理的专用本地端点供准确会话的原生 CLI 附着。以本机 0.155.1 作为首次验证版本；审批路由、多连接观察、界面断开及写入隔离仍需真实验证。见 [ADR 0018](../adr/0018-codex-app-server-binding.md)。
- Fastify 使用社区插件 fastify-type-provider-zod 与官方插件 @fastify/swagger，复用同一 Zod 定义完成类型推导、校验、响应序列化和 OpenAPI 3.1 生成；路由与注册组件的 schema 导出均明确配置不可表达类型时报错，避免默认静默放宽。
- CLI 使用 Commander，独立入口默认使用 Pino 结构化日志；核心接收日志接口，集成方可以提供自己的实现。
- 本地命令使用 Node child_process.spawn，Git 交付通过同一执行入口调用系统 Git；输出、退出、超时与停止确认统一处理，发送停止信号不等于确认进程已退出。

## 第六轮已确认：Q50–Q52

- MySQL 8.4 LTS 为首版数据库兼容与验收基线；其他系列通过测试后再纳入支持范围。
- 默认 MySQL 存储模块创建并拥有自己的连接池，使用指定数据库中的独立 raven_ 表及迁移记录；提供关闭入口，由组装方管理生命周期。核心服务不关闭宿主传入的存储对象；集成方可以通过既定存储接口提供自己的实现。见 [ADR 0019](../adr/0019-storage-resource-ownership.md)。
- 技术规格锁定框架与兼容版本线，实现启动时选择满足兼容要求的正式依赖与工具版本并精确固定，提交 pnpm lockfile，CI 使用冻结安装。发布模块的依赖范围单独验证，不能依赖仓库锁文件约束消费者的安装；Codex 兼容范围按真实验收版本记录。

## 实现前及发布前的验证边界

- 首先使用 Codex 0.155.1 验证准确会话附着、已有待答问题的原生处理、多连接观察、CLI 断开后的持续执行及自动收尾后的写入隔离。工作阶段结束事件或停止请求响应不独立证明隔离成立；未通过时记录阻碍并重新讨论，不静默替换为框架审批界面。
- 在真实 MySQL 8.4 验证迁移、事务、执行归属、结果去重和服务端重启；使用真实 SQLite 验证客户端阶段记录、断网补报与恢复。数据库提交、文件保存与外部 Git 操作之间的恢复仍由框架记录及核验机制保证。
- 在 HTTP 桥接中同时配置路由和注册组件的不可表达类型时报错；验证非法输入、未知字段、响应校验与导出 schema 的约束一致。插件与依赖的 peer 范围、Zod 导出目标和 OpenAPI 3.1 的组合在固定版本时核对。
- 在发布后的包入口验证 ESM 导入、类型声明及 MySQL、SQLite 和 HTTP 模块可以按职责独立消费；验证 CommonJS 消费方式、关闭服务不会误关闭宿主资源，以及迁移只管理框架自己的表。
- 初版在 macOS 验证子进程与停止确认、CLI 使用及本地 Git 交付；通过真实临时仓库与 bare remote 核对提交、推送和恢复证据。Linux 平台验证移到后续，不阻塞初版发布。

本轮仅进行了官方文档与本机只读事实核对、设计文档及 ADR 更新。未安装项目依赖、生成代码或协议绑定，也未运行上述兼容性与端到端验收。技术术语属于实现选择，不加入领域术语表。
