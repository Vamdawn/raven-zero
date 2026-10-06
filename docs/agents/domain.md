# Domain Docs

本仓库采用 single-context 布局：

- 根目录 GLOSSARY.md：领域术语。
- docs/adr/：架构决策记录。

## 探索代码前

阅读根目录 GLOSSARY.md，以及 docs/adr/ 中与当前任务相关的决策。

这些文件不存在时直接继续，不提示缺失，也不预先创建空文件。
domain-modeling 技能会在术语或决策明确后按需创建。

## 使用领域术语

在任务标题、重构建议、假设和测试名称中，使用 GLOSSARY.md 定义的术语。

需要的概念尚未收录时，先判断是否引入了项目不使用的说法；
确有术语缺口时，记录给 domain-modeling 处理。

## 决策冲突

建议与现有 ADR 冲突时，明确指出对应 ADR，并说明重新讨论的理由。
