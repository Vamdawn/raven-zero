# Issue tracker: GitHub

本仓库的任务和规格记录为 GitHub Issues，使用 gh CLI 操作。
在仓库目录内执行命令，由 Git 远端确定目标仓库 Vamdawn/raven-zero。

## 操作约定

- 创建：gh issue create --title "..." --body-file <path>
- 读取：gh issue view <number> --comments；同时检查标签。
- 列出：gh issue list --state open --json number,title,body,labels,comments
  按需要添加 --label 和 --state 筛选。
- 评论：gh issue comment <number> --body-file <path>
- 添加标签：gh issue edit <number> --add-label "..."
- 移除标签：gh issue edit <number> --remove-label "..."
- 关闭：gh issue close <number> --comment "..."

多行正文先写入临时文件，再通过 --body-file 传递。

子任务优先使用 GitHub 原生 sub-issues；不可用时，在子任务正文顶部
写入 Part of #<parent>，并在父任务正文中添加任务列表。

## Pull requests as a triage surface

**PRs as a request surface: no.**

## 技能指令的含义

- “publish to the issue tracker”：创建 GitHub Issue。
- “fetch the relevant ticket”：执行 gh issue view <number> --comments。
