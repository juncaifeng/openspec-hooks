# openspec-hooks

把 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 工作流的**文档约定**变成**物理约束**的 git hooks —— 核心是**任务完成度的证据链**（勾选率 / 证据率 / 节奏 / 收口），让"完成度"从自我声明变成可审计的数字。

零依赖（Node ≥ 18 + git），不调 LLM、不联网，pre-commit 全部检查 <100ms。

## 安装（任意 OpenSpec 项目）

```bash
npm i -D openspec-hooks
npx openspec-hooks install        # 复制自包含 .openspec-hooks/ bundle + 设置 core.hooksPath + 部署 SKILL.md
npx openspec-hooks uninstall      # 卸载（含已部署的 skills）
```

**install 同时会部署一份 `SKILL.md` 提交契约**（教给 AI agent：`Change-Id` trailer、证据勾选、
specs/ 写保护、归档门禁、被拦时的正确动作），让 agent 在动手前就知道规则，而不是撞了报错再学：

| 选项 | skill 落点 |
|---|---|
| （默认） | 项目级：已存在的 `.agents/skills` / `.claude/skills` / `.codex/skills` **全部**装一份；都不存在则创建 `.agents/skills` |
| `--skills-global` | 用户级：已存在的 `~/agents/skills` / `~/.agents/skills` / `~/.claude/skills`；都不存在则创建 `~/agents/skills` |
| `--skills-dir <dir>` | 精确指定任意目录 |
| `--no-skills` | 不装 skill（只挂 hooks） |

| Hook | 职责 | 失败效果 |
|---|---|---|
| `pre-commit` | 不变量 + 完成度增量信号（只看**暂存区**） | error → 阻断提交 |
| `commit-msg` | `Change-Id` 外键 + scope creep 检测 | error → 阻断提交 |
| `pre-push` | 证据率回溯、僵尸 change（累计指标） | warn 为主（可 strict） |
| `post-commit` | 进度面板（勾选率 + 下一步提示） | 永不阻断 |

逃生舱：`git commit --no-verify`、`OPENSPEC_SKIP_HOOKS=1`；严格模式：`OPENSPEC_HOOKS_STRICT=1`（warn 全升 error）。linter 自身崩溃一律 fail-open。

## 规则目录

### A 类 — 机械不变量（误报 ≈ 0）

| ID | Hook | 触发条件 | 级别 |
|---|---|---|---|
| A1 | pre-commit | 改 `openspec/specs/**` 却没有归档动作 —— specs 只能随 **archive** 合并 delta 演进（防止被拦的编辑搭 propose 提交便车）；仓库引导（unborn HEAD）首次创建豁免 | error |
| A2 | pre-commit | 归档目录名 ≠ `YYYY-MM-DD-<change-name>`（error）；归档提交混入 openspec/ 外文件（warn） | error/warn |
| A3 | pre-commit | change 缺 `proposal.md` / `tasks.md` | error |
| A4 | pre-commit | delta 格式坏（`## ADDED Requirements` 拼错会**静默丢需求**）、层级错、需求为空；change 无 delta（warn） | error/warn |
| A5 | pre-commit | tasks.md 勾选语法坏、任务编号重复 | error |
| A6 | commit-msg | 缺 `Change-Id: <change-name>` trailer（error）、引用不存在的 change（error）、非 Conventional Commits（warn）；`Change-Id: none` 豁免 | error/warn |
| A7 | pre-commit | change 目录名非 kebab-case | warn |

### B 类 — 任务完成度与证据链

| 维度 | 规则 |
|---|---|
| ① 勾选率 | post-commit 面板展示 |
| ② **证据率**（勾选提交是否伴随 openspec/ 外产物） | B1（增量）+ B8（历史回溯） |
| ③ 节奏（批量勾选 / 零迭代） | B3 |
| ④ 收口（归档门禁 / 僵尸 / Scope 同步） | B4 / B6 / B7 |

| ID | Hook | 触发条件 | 级别 |
|---|---|---|---|
| B1 | pre-commit | 勾了任务但本次提交**零产物** —— 完成度是声明出来的，不是做出来的 | warn（可配 error） |
| B2 | commit-msg | 代码照写但 tasks 已 100% 勾完 → scope creep（warn）；有未完成任务没同步勾选 → 提示（info） | warn/info |
| B3 | pre-commit | 单次勾选 > 5（批量）；change 创建即 100% 勾完（"零迭代完成"橡皮图章指纹） | warn |
| B4 | pre-commit | 归档时任务未全部勾选 / tasks 为空 / 缺 proposal | error |
| B5 | pre-commit | delta 的 ADDED/MODIFIED 需求在 tasks.md 找不到对应任务（任务行或**全文/分组标题**出现需求名即算覆盖） | warn |
| B6 | pre-commit | 任务 `[x]→[ ]` 回退但 proposal.md 的 Scope 未同步 | warn |
| B7 | pre-push | active change 超 7 天无提交（僵尸 change） | warn |
| B8 | pre-push | **证据率回溯**：git log 解析每个勾选事件，证据率 < 50% → "勾选与产物脱节" | warn |

**证据的定义**：把 `- [ ]` 翻成 `- [x]` 的那个提交里，存在任何 `openspec/` 之外的文件变更。

## 配置（`openspec-hooks.json`，仓库根目录）

```json
{
  "rules": { "B1": "error", "B3": "warn", "B5": "off" },
  "thresholds": { "batchCheck": 5, "staleDays": 7, "evidenceRate": 0.5 }
}
```

## 设计要点

1. **规则是纯函数** `check(ctx) → findings[]`，ctx 可注入 —— 29 个 fixture 单测毫秒级跑完
2. **只看暂存区**（`git diff --cached` + `git show :path`），提交的真相在索引里
3. **报错文案写给 AI 看**：每条 finding 带 `hint`（"先 /opsx:propose 再提交"），agent 读 stderr 自我纠正
4. **薄壳原则**：逻辑全在 CLI，hooks 与 CI 复用同一套规则
5. **fail-open**：node 不在 PATH、linter 崩溃 → 警告放行，永不锁死 git

## 局限

- 任务配对按规范化文本匹配（改描述 = 删旧加新）；生产建议稳定 task-id
- B8 遍历 tasks.md 全历史；大仓库可限定 push range
- B5 是关键词启发式，恒为 warn
- 文件名含 `\t` `\n` 不支持

## 开发

```bash
npm test    # 29 fixture 单测 + 9 真实 git 端到端场景
```

License: MIT
