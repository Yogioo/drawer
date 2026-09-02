# Issue tracker: GitHub

这个 repo 的 issues 和 specs 存放在 GitHub Issues 中。仓库是 `Yogioo/drawer`，所有操作都使用 `gh` CLI。

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`。多行 body 使用 PowerShell here-string。
- **Read an issue**: `gh issue view <number> --comments`，同时检查 labels。
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`，按需增加 label 和 state filters。
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** 外部 PR 不作为 triage request surface。

## When a skill says "publish to the issue tracker"

创建一个 GitHub issue，并按 skill 要求应用 labels。

## When a skill says "fetch the relevant ticket"

运行 `gh issue view <number> --comments`。

## Dependencies

需要表达 issue 依赖时，优先使用 GitHub native issue dependencies；如果当前 GitHub 能力不可用，则在 issue body 中写明 `Blocked by: #<n>`。
