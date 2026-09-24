---
name: openspec-hooks
description: 提交契约（commit contract）for repos enforcing OpenSpec workflow via openspec-hooks git hooks. Use when committing/pushing in such a repo, when creating or archiving an openspec/changes/* change, or when a pre-commit/commit-msg hook blocks with rule ids like [A1]/[B1]/[A6]. Covers Change-Id trailer, evidence-backed task checks, specs/ write protection, and the archive gate.
---

# openspec-hooks 提交契约

本仓库用 `openspec-hooks` 的 git hooks 强制 OpenSpec 工作流。写代码/提交前记住这份契约，
hook 报错时按 `↳ hint` 修正后重新提交——**禁止用 `--no-verify` 绕过**（会失去完成度审计）。

## 五个硬规则

1. **每个 commit 必带 trailer**：`Change-Id: <change-name>`（该 change 目录须存在）；
   与任何 change 无关的提交用 `Change-Id: none`（如纯杂务）。
2. **勾任务必带产物**：把 `- [ ]` 翻成 `- [x]` 的提交里必须有 `openspec/` 之外的文件变更
   （代码、文档、配置都算）。没产物就别勾；做完了就同提交带上产物。
3. **specs/ 只随归档变更**：`openspec/specs/**` 的修改只能出现在归档提交里
   （与 `changes/archive/YYYY-MM-DD-<name>/` 移动同一次提交）。想改行为 → 先写 delta。
4. **归档先做完**：移入 `changes/archive/` 前 tasks.md 必须 100% 勾完（或删掉不再做的任务
   并同步 proposal.md 的 Scope）。
5. **提交信息规范**：Conventional Commits（`feat:` / `fix:` / `docs:` …）。

## 被拦截时的正确动作

| 规则 | 含义 | 动作 |
|---|---|---|
| A1 | 直接改了 specs/ | 停手 → `/opsx:propose` 建 change 写 delta → 实施 → `/opsx:archive` |
| A3/A4 | change 缺 proposal/tasks 或 delta 格式坏 | 补齐文件；delta 段落必须是 `## ADDED\|MODIFIED\|REMOVED Requirements` + `### Requirement:` + `#### Scenario:` |
| A5 | tasks.md 语法坏 | 只用 `- [ ] <编号> <文本>` / `- [x] …` 两种形态，编号不重复 |
| A6 | 缺 Change-Id / 引用不存在 | message 末尾补 `Change-Id: <change-name>`；确无关用 `Change-Id: none` |
| B1 | 勾了任务但零产物 | 补上产物一起提交，或把勾选撤回 |
| B2 | 100% 勾完还在写代码 | scope creep → 更新 proposal.md 的 `## Scope` 并补任务，或另开 change |
| B3 | 批量勾选 / 零迭代完成 | 按逻辑单元拆提交，propose 与 apply 分开 |
| B4 | 归档时任务没做完 | 做完再归档（带产物勾选） |

## 推荐提交节奏

```
① propose   openspec/changes/<name>/{proposal,tasks}.md + specs/ delta   → 一个 commit
② apply     每个逻辑单元：代码 + 对应任务勾选                              → 多个 commit
③ archive   moves 到 changes/archive/YYYY-MM-DD-<name>/ + 合并 specs/     → 一个 commit
```

批量小改动可以合并提交，但勾选的任务数 >5 会触发 B3 警告。

## 查看进度

```bash
npx openspec-hooks status     # 每个 active change 的勾选率 + 下一步建议
```

被 pre-push 警告 [B8]（证据率偏低）时：说明历史上有"无产物勾选"——回溯补证据或回滚那些勾选，
并确保后续勾选与产物同提交。
