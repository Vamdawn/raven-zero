# 单任务服务端

Issue #5：Node.js 24、MySQL 8.4、Fastify 5 的单实例服务端。任务、客户端能力与名额、执行归属、进度、取消请求及结果保存在 MySQL；不调用 Agent、不执行交付。工作流推进与文件流式传输由后续切片实现。

## 嵌入与资源所有权

```ts
import {createMysqlStore, TaskServer, ravenRoutes} from '@raven-zero/server';

const store = createMysqlStore({database: 'example', user: 'raven', password: '...'});
await store.checkCompatibility(); // 只读，未显式迁移时失败
const server = new TaskServer(store);
await hostFastify.register(ravenRoutes, {
  prefix: '/raven/v1', server, managementToken: configuredManagementToken,
});
// 宿主也可直接调用 server.submit / get / cancel / registerClient 等核心能力。
// 这些管理方法是受信任的嵌入边界；HTTP 入口另行验证管理令牌。
// 宿主关闭 HTTP 后，按自己的生命周期 await store.close()。
```

`ServerStore` 是可替换的存储接口；其领取、更新及结果接收必须原子执行。核心与 HTTP 插件不关闭传入的存储。默认 `MysqlStore` 只拥有自己创建的连接池，`close()` 可重复调用。`createServerApp(config, managementToken)` 是独立组装入口，拥有连接池；失败启动或 `app.close()` 会释放它。

## 显式迁移与独立启动

部署者先建立数据库并授予 Raven 所需的 DDL/DML 权限，然后设置：

```sh
export RAVEN_MYSQL_DATABASE=example
export RAVEN_MYSQL_USER=raven
export RAVEN_MYSQL_PASSWORD='...'
export RAVEN_MYSQL_HOST=127.0.0.1
export RAVEN_MANAGEMENT_TOKEN='独立的至少32字符管理令牌'
pnpm build
pnpm --filter @raven-zero/server migrate
pnpm --filter @raven-zero/server start
```

可设置 `RAVEN_MYSQL_PORT`，或使用 `RAVEN_MYSQL_SOCKET` 连接 Unix socket；HTTP 默认 `127.0.0.1:3000`，由 `RAVEN_HOST` / `RAVEN_PORT` 调整。跨机器 HTTP 由部署者提供 HTTPS 入口。SIGINT/SIGTERM 关闭长轮询、HTTP 和自有池。

嵌入迁移调用 `migrateMysql(config)` 或 `store.migrate()`。启动只检查 MySQL 8.4 和完整、准确的迁移版本集合，不建表、不运行迁移。迁移仅拥有 `raven_client`、`raven_task`、`raven_result`、`raven_migration` 与 `raven_migration_lock`，不管理宿主其他表。MySQL DDL 不能整体回滚；初版创建使用 `IF NOT EXISTS`，中断后保留已创建表并重跑显式迁移。迁移期间停止接入业务；不要手工改动 Raven 表结构或迁移记录。

## HTTP 协议

默认独立入口前缀为 `/raven/v1`。所有 API 使用 JSON、`Authorization: Bearer <token>`。对象拒绝未知字段，包括嵌套字段和 query 参数。错误包含 `code` / `message`：400 非法请求、401 身份或归属错误、404 不存在、409 冲突、500 内部失败。

| 方法及路径 | 身份 | 请求 / 响应 |
| --- | --- | --- |
| POST `/clients` | 管理 | `{id, capabilities: {agents, deliveryComponents, slots}}` → `{client, token}` |
| POST `/clients/:clientId/revoke` | 管理 | `{}` → 客户端记录 |
| POST `/tasks` | 管理 | Task → ServerTask，重复任务 ID 返回冲突 |
| GET `/tasks/:taskId` | 管理 | 返回定义、执行 ID、归属、进度、取消请求、终态及结果 |
| POST `/tasks/:taskId/cancel` | 管理 | `{}` → ServerTask |
| POST `/claim` | 客户端 | `{waitMs: 0..30000}` → `{assignment: ServerTask \| null}` |
| POST `/heartbeat` | 客户端 | `{agents, deliveryComponents, slots}` → `{client, runs}`，包含已有执行和取消请求 |
| POST `/runs/:runId/progress` | 客户端 | `{status, reason?}` → ServerTask |
| POST `/results` | 客户端 | TaskResult → `{task, duplicate}` |
| GET `/openapi.json` | 管理 | OpenAPI 3.1；两条 schema 桥接均显式拒绝不可表达类型 |

客户端令牌在注册时仅返回一次，数据库只存 SHA-256 哈希；每个客户端独立撤销，撤销不释放已有执行或把执行转派。客户端重新启动后使用同一令牌，通过心跳找回准确 runId。管理令牌不能用于客户端 API，客户端令牌不能管理任务。任务及客户端 ID 限定为 1–128 个 ASCII 字母、数字、点、下划线或短横线；能力名最长 128 字符，名额为 0–1024。

## 调度、结果与取消

主动领取本身证明在线。领取事务锁定客户端、统计该客户端的所有 assigned 执行，然后按能力匹配并锁定一个 queued 任务。人工等待、pending_verification、取消待确认和失联的 assigned 执行均继续占名额。名额下调不撤销既有执行；不会超额分配新任务。任务失联没有自动转派、超时释放或重新启动。并发领取只产生一个执行归属；领取响应丢失后，通过心跳核对归属，不把新领取当作重放原响应。

任务状态与客户端执行阶段分开：`queued → assigned → succeeded / failed / cancelled / expired`。进度记录客户端阶段，不会仅凭 `stop_confirmed`、`published` 或 `checking_after` 完成任务。停止请求与真实停止由客户端区分，服务端信任已认证的原客户端结果上报，不验证本机进程证明。

每个任务只有一个 runId 和一个终态结果，本切片不提供重试或继续下一版的调度入口。同一 `(runId, version)` 和相同内容的结果可重报；对象键顺序不影响去重。不同内容、不同任务身份或终态之后的新版本返回冲突。结果去重记录与终态在同一事务提交，响应丢失或服务端重启后补报不重复完成或释放名额。

待领取任务取消后立即成为 cancelled。已领取任务只标记 `cancellationRequested`，仍占名额并保留原归属；原客户端通过心跳收到请求，只有 cancelled / expired 停止结果才能完成该取消。终态之后的取消请求返回已有终态。

文件产物传输尚未建立：需要文件产物的任务即使报告 succeeded，也返回冲突并保留 assigned 状态及名额，不提前完成。此处不把客户端本地文件路径当作服务端已收到的文件；后续切片将建立文件接收与完成条件。

## 验证

`pnpm test` 会启动独立、socket-only 的真实 MySQL 8.4，使用临时目录和临时数据库；不连接个人运行中的数据库。默认二进制为 `/opt/homebrew/opt/mysql@8.4/bin/mysqld`，可用 `RAVEN_MYSQLD` 指定；缺失或版本不是 8.4 会失败，不以 SQLite 或跳过测试替代验收。

```sh
pnpm doctor
pnpm test:mysql-smoke
pnpm exec tsc -b packages/server
node --test --test-concurrency=1 --test-timeout=60000 packages/server/dist/test/*.test.js
```

先通过预检和公开存储 API 的连接／查询／关闭冒烟，再推进业务测试；失败分别带 `[environment]` / `[mysql-smoke]` 诊断。
初始化失败的故障注入测试核对临时目录清理。完整提交检查的顺序及定向连接钩子规则见[验证入口](../../docs/agents/validation.md)。

测试覆盖迁移、重启、能力/名额匹配、竞争、归属、重报与取消、HTTP 认证/严格契约/OpenAPI、长轮询及资源关闭。测试实例在确认退出后删除自身临时目录；不触及宿主表。结果 JSON 保留 Unicode、NULL 和精确数字字符串；DATETIME(3) 与连接时区统一 UTC，驱动返回日期字符串，COUNT 等大整数按字符串读取后以 BigInt 比较。本包不保存 DECIMAL 金额或任意 BIGINT 业务字段。

2026-10-09 在 macOS/arm64、Node.js 24.15.0、MySQL 8.4.11 上验证。另以 1,000 个真实任务核对 EXPLAIN：能力匹配领取使用 `idx_task_claim`，预估扫描 10 行、无 filesort；名额统计在该数据分布下也选择 `idx_task_claim`，预估扫描 1 行（唯一 assigned 执行）。任务 ID 查询走主键、runId 查询走 `uk_task_run`。这只证明该夹具的索引选择，不代表更大规模或更多能力组合的性能验收。
