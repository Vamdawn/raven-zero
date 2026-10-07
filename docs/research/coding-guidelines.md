# AI Coding 规则调研依据

调研日期：2026-10-07。范围是已确认的 [技术栈](../design/technology-stack.md)；本文记录来源、版本差异与适配理由，执行规则由 [TypeScript 规则](../agents/typescript.md)和 [MySQL 规则](../agents/mysql.md)维护。

## 一手来源与版本

- Google：[TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)，固定核对 [tsguide.html / e4d272eb151adfb5f382501265172a99c6a19671](https://github.com/google/styleguide/blob/e4d272eb151adfb5f382501265172a99c6a19671/tsguide.html)；章节包括 Naming、Imports、Type system、Exceptions、Formatting。
- 阿里巴巴：[p3c 官方仓库](https://github.com/alibaba/p3c/tree/6c59c8c36ecd8722c712d5685b8c3822c1c8b030) 的 [Java 开发手册（黄山版）PDF](https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf)，v1.7.1，2022-02-03；本次查询仓库 HEAD 为上述提交。第五章 MySQL 数据库，印刷页 32–36；版本历史见第 43 页。
- 对照：[同仓中文 GitBook](https://github.com/alibaba/p3c/tree/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/p3c-gitbook/MySQL数据库) 与 [官方英文 README / 9ba11055f980d74be520bccdc86b17fc255fc30d](https://github.com/alibaba/Alibaba-Java-Coding-Guidelines/blob/9ba11055f980d74be520bccdc86b17fc255fc30d/README.md)。二者内容较旧，不能替代黄山版 PDF；本文明确区分版本。
- MySQL：官方 [8.4 Reference Manual](https://dev.mysql.com/doc/refman/8.4/en/)。Kysely、mysql2 使用下文官方页面，并通过 find-docs 的 Context7 查询交叉核对；最终以一手页面为准，具体依赖版本仍在实现时固定。

## Google 规范的采用与适配

- 上游采用 ESM 导入导出、具名导出、`const`/`let`、明确访问修饰、类型推导、`unknown` 和运行时收窄，避免默认导出、`any` 及用断言代替检查。格式与命名可提炼为本仓统一规则。[Google 对应章节](https://google.github.io/styleguide/tsguide.html)
- 上游文件名使用 `snake_case`，类型名使用 `UpperCamelCase`，函数与变量使用 `lowerCamelCase`。第三方字段、协议及生成文件应维持其真实契约，不能仅为统一风格修改外部字段。[Google Naming](https://google.github.io/styleguide/tsguide.html#naming)
- 对象结构通常优先 interface，但本仓已经选择 Zod 为协议唯一来源：协议类型继续推导为 type，联合类型和映射类型同样需要 type；不能再手写平行 interface。[Google Type aliases](https://google.github.io/styleguide/tsguide.html#interfaces-vs-type-aliases)、[本仓技术栈](../design/technology-stack.md)
- 当前规范明确使用 `as` 断言；允许有安全依据的 `unknown` 双断言，并要求解释。把双断言绝对禁止，或推荐旧式尖括号断言，都不能冒称当前 Google 原文。[Google Type assertions](https://google.github.io/styleguide/tsguide.html#type-and-non-nullability-assertions)
- Node ESM 的 `.js` 相对导入、`node:` 内置模块前缀，以及 Codex 版本生成协议文件的隔离，是本仓环境适配；Google Closure 的 goog 环境规则不引入本仓。[本仓技术栈](../design/technology-stack.md)
- 上游提醒示例排版不构成强制格式条款；本仓的两空格缩进、公开返回类型注解和 Promise 生命周期要求是项目规则，不冒称上游强制要求。上游对 `#private` 的禁用也未直接引入 Node.js 24 环境。[Google Guide notes](https://google.github.io/styleguide/tsguide.html#guide-notes)、[Google Private identifiers](https://google.github.io/styleguide/tsguide.html#private-fields)

## 黄山版 MySQL 规则及版本差异

- 建表 §1–5：布尔列采用 `is_xxx`、`TINYINT UNSIGNED`、0/1；小写表列名、单数实体名、避开保留字；唯一和普通索引采用 `uk_`/`idx_`。Java POJO 的 is 前缀限制来自 JavaBean/MyBatis 映射，不适用于 TypeScript。[PDF 第 32 页](https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf)
- 建表 §6–9、ORM §7：精确小数使用 DECIMAL；字符串长度按用途选择；新版生命周期字段名为 `create_time`/`update_time`，更新时同时更新后者。旧 GitBook/英文版使用 `gmt_create`/`gmt_modified`，应标明为旧名。[PDF 第 32、36 页](https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf)
- 索引 §1、5–10：业务唯一性由唯一约束保护；关联类型一致；根据过滤、排序设计组合/覆盖索引；减少深 OFFSET，检查执行计划和隐式转换。SQL §1–5、12：理解 COUNT 与 NULL、空集合 SUM、分页边界，字符集采用 utf8mb4。[PDF 第 33–35 页](https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf)
- ORM §1、4、8–9：明确选择列、参数绑定、只更新目标字段、谨慎使用事务；MyBatis XML、Java DO/resultMap/HashMap 规则只保留其边界映射和防注入意图，不搬入 TypeScript。[PDF 第 35–36 页](https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf)

## MySQL 8.4 与当前工具链核对

| 主题 | 官方事实与本仓适配建议 |
| --- | --- |
| 主键命名 | MySQL 主键索引名恒为 `PRIMARY`；手册 `pk_` 命名不能作为 MySQL 可实现的要求。其他索引保留 `uk_`、`idx_`。[CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html) |
| 非空与唯一 | 主键列隐式 NOT NULL，唯一索引允许多个 NULL。必填字段和幂等唯一键应显式非空；确有“尚未产生”含义时保留 NULL，并测试组合唯一键的 NULL 语义，不填伪造零值。[CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html) |
| 字符集 | utf8mb4 覆盖完整 Unicode；连接和表字符集保持一致。标识符、令牌等精确匹配字段单独选择比较规则，避免默认不区分大小写的 collation 改变唯一性。[utf8mb4](https://dev.mysql.com/doc/refman/8.4/en/charset-unicode-utf8mb4.html)、[字符集与排序规则](https://dev.mysql.com/doc/refman/8.4/en/charset.html) |
| 前缀索引 | 唯一前缀索引只约束前缀；完整业务标识必须约束完整值。默认 16KB 页、DYNAMIC 格式上限为 3072 字节；191 字符来自旧 767 字节限制，不是所有 utf8mb4 索引的通用值。[CREATE TABLE](https://dev.mysql.com/doc/refman/8.4/en/create-table.html)、[InnoDB limits](https://dev.mysql.com/doc/refman/8.4/en/innodb-limits.html) |
| 时间 | DATETIME 无时区转换；TIMESTAMP 按会话时区转换 UTC，范围到 2038 年，均不保存原始时区名。PDF 中“记录时区信息用 timestamp”不能理解为保留原时区。建议 UTC、明确精度，测试连接与驱动转换。[日期时间](https://dev.mysql.com/doc/refman/8.4/en/datetime.html) |
| 数值 | mysql2 默认 DECIMAL 返回 string；`decimalNumbers: true` 转 number，可能损失精度。BIGINT 读取需固定 `supportBigNumbers`/`bigNumberStrings`，边界映射与 Kysely 类型匹配。转换 number 前检查安全范围。[mysql2](https://sidorares.github.io/node-mysql2/docs/documentation)、[连接配置](https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool)、[Kysely 数据类型](https://www.kysely.dev/docs/recipes/data-types) |
| 聚合与 NULL | COUNT(*) 统计行，COUNT(col) 忽略 NULL，COUNT(DISTINCT col1,col2) 排除任一表达式为 NULL 的组合；无匹配行时 COUNT 为 0，SUM 为 NULL。业务需要零值时显式 COALESCE；NULL 条件可用 IS NULL/IS NOT NULL，无须硬限定 ISNULL()。[聚合](https://dev.mysql.com/doc/refman/8.4/en/aggregate-functions.html)、[NULL](https://dev.mysql.com/doc/refman/8.4/en/working-with-null.html) |
| 参数 SQL | Kysely 的 sql 标签插值对普通值做参数绑定，和普通 JS 字符串插值不同；sql.raw/ref/id/table/lit 不接受未经验证的外部输入。动态标识符及排序方向使用允许列表。[Kysely Sql](https://kysely-org.github.io/kysely-apidoc/interfaces/Sql.html) |
| 事务与迁移 | 多数 DDL/TRUNCATE 隐式提交；迁移工具不能提供整次 DDL 统一回滚。短事务、统一访问顺序减少死锁；必要时重试完整且可安全重试的事务。Agent/Git/网络副作用不放入事务。[隐式提交](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)、[死锁](https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html)、[本仓技术栈](../design/technology-stack.md) |
| 并发写入 | 普通 SELECT 后 UPDATE 不自动保证读写之间的条件仍成立。框架状态推进可用包含预期状态/版本的条件 UPDATE，核对影响行数；若采用版本必须实际推进版本以识别成功。多记录不变量在同一事务配合锁定读处理，不能依赖先查再插保证唯一性。这是项目适配建议。[UPDATE](https://dev.mysql.com/doc/refman/8.4/en/update.html)、[锁定读](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html) |
| 外键 | InnoDB 支持外键，默认 RESTRICT/NO ACTION，引用类型符号及字符集需兼容；不是数据库“不支持外键”。手册的禁用适用于其分布式高并发取舍。本仓应逐关系说明数据库约束或应用事务如何保证引用完整性，级联删除另行评估。[外键约束](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html) |

## 保留为评估依据的上游约束

黄山版还规定统一逻辑删除、最多三个表 join、VARCHAR 长度不超过 5000、VARCHAR 索引必须设前缀，以及 IN 不超过 1000、500 万行/2GB 再考虑分片。这些是原手册规则，不是 MySQL 8.4 的普遍限制。本仓采用查询边界、容量与执行计划证据进行判断；显式清理按产品语义实现，不新增全表软删除或分片机制。[PDF 第 32–35 页](https://github.com/alibaba/p3c/blob/6c59c8c36ecd8722c712d5685b8c3822c1c8b030/Java开发手册(黄山版).pdf)、[MySQL 优化](https://dev.mysql.com/doc/refman/8.4/en/optimization.html)

建议验证覆盖业务唯一键冲突、并发状态转换、NULL 聚合、非 ASCII 文本、超出安全整数范围的值、时间往返、迁移失败与恢复。涉及调度或跨机器交付的幂等性测试来自本仓设计，而不是宣称两套上游编码手册已定义该领域行为。[本仓技术栈验证边界](../design/technology-stack.md#实现前及发布前的验证边界)

本次仅调研与文档沉淀；未安装项目依赖、实现数据库代码或执行上述兼容测试。
