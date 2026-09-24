// openspec-hooks-poc — rule catalog (pure functions over a context object)
// A-class: mechanical invariants   B-class: task-completion & evidence chain
// Every rule: { id, hook, severity, title, check(ctx) → findings[] }
// finding: { id, severity?, message, hint?, file?, line? }

import {
  parseTasks,
  parseDelta,
  parseProposalScope,
  taskTransitions,
  requirementCovered,
  requirementCoveredInText,
  KNOWN_SECTIONS,
} from "./parse.mjs";

export const DEFAULT_THRESHOLDS = {
  batchCheck: 5, // B3: max task checkboxes flipped in one commit
  staleDays: 7, // B7: active change untouched for N days
  evidenceRate: 0.5, // B8: min share of checks backed by artifacts
  scopeFileRatio: 3, // reserved (C3 scope-creep heuristic, roadmap)
};

const CHANGE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ARCHIVE_DIR_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;

/** Placeholder files (.gitkeep, .DS_Store, …) carry no spec content. */
const isPlaceholderPath = (p) => (p.split(/[\\/]/).pop() ?? p).startsWith(".");

const f = (id, message, extra = {}) => ({ id, message, ...extra });

// ---------------------------------------------------------------------------
// A-class — mechanical invariants (pre-commit)
// ---------------------------------------------------------------------------

const A1 = {
  id: "A1",
  hook: "pre-commit",
  severity: "error",
  title: "specs/ write-protect",
  check(ctx) {
    // specs/ may only change together with an archive (delta merge) — not merely
    // alongside any change, or a blocked edit can ride along a propose commit.
    const contentPaths = ctx.specsStagedPaths.filter((p) => !isPlaceholderPath(p));
    if (contentPaths.length > 0 && ctx.archive.length === 0) {
      if (ctx.isBootstrap) {
        // fresh repo: the very first commit legitimately creates specs/
        return [
          f("A1", `初始提交引导 specs/（${contentPaths.join(", ")}）— 豁免放行，此后 specs/ 只能随 archive 演进`, {
            severity: "info",
          }),
        ];
      }
      return [
        f("A1", `直接修改了 specs/（${contentPaths.join(", ")}）而没有归档动作 — specs/ 是 source of truth，只能随 archive 合并 delta 演进`, {
          hint: "先 /opsx:propose <change-name> 写 delta，实施完成后 /opsx:archive 归档合并（specs 变更只能出现在归档提交里）",
        }),
      ];
    }
    return [];
  },
};

const A2 = {
  id: "A2",
  hook: "pre-commit",
  severity: "error",
  title: "archive hygiene",
  check(ctx) {
    const out = [];
    for (const a of ctx.archive) {
      if (!ARCHIVE_DIR_RE.test(a.name)) {
        out.push(
          f("A2", `归档目录名 "${a.name}" 不符合 YYYY-MM-DD-<change-name> 规范`, {
            file: a.dir,
            hint: "归档应由 /opsx:archive 完成（自动加日期前缀）",
          })
        );
      }
    }
    if (ctx.archive.length > 0 && ctx.nonOpenspecStagedPaths.length > 0) {
      out.push(
        f("A2", `归档提交里混入了 ${ctx.nonOpenspecStagedPaths.length} 个 openspec/ 之外的文件 — 归档提交应保持纯净`, {
          severity: "warn",
          hint: "把实现代码和归档拆成两个提交，保证 archive 可独立审计/回滚",
        })
      );
    }
    return out;
  },
};

const A3 = {
  id: "A3",
  hook: "pre-commit",
  severity: "error",
  title: "change structure",
  check(ctx) {
    const out = [];
    for (const c of ctx.changes) {
      if (!c.hasProposal) {
        out.push(f("A3", `change "${c.name}" 缺少 proposal.md`, { file: `openspec/changes/${c.name}/` }));
      }
      if (!c.hasTasks) {
        out.push(f("A3", `change "${c.name}" 缺少 tasks.md`, { file: `openspec/changes/${c.name}/` }));
      }
    }
    return out;
  },
};

const A4 = {
  id: "A4",
  hook: "pre-commit",
  severity: "error",
  title: "delta spec schema",
  check(ctx) {
    const out = [];
    for (const c of [...ctx.changes, ...ctx.archive]) {
      const label = c.dir ?? `openspec/changes/${c.name}`;
      if (c.deltas.length === 0 && ctx.archive.indexOf(c) === -1) {
        out.push(
          f("A4", `change "${c.name}" 没有任何 delta specs（changes/<name>/specs/**）`, {
            severity: "warn",
            file: label,
            hint: "delta 是 archive 合并进 specs/ 的唯一来源",
          })
        );
      }
      for (const d of c.deltas) {
        for (const issue of d.parsed.issues) {
          out.push(
            f("A4", `${d.path}:${issue.line ? issue.line + " " : ""}${issue.message}`, {
              severity: issue.kind === "warn" ? "warn" : "error",
              file: d.path,
              line: issue.line || undefined,
              hint: "正确的段落是 '## ADDED|MODIFIED|REMOVED Requirements' + '### Requirement: <名>' + '#### Scenario: <名>'",
            })
          );
        }
      }
    }
    return out;
  },
};

const A5 = {
  id: "A5",
  hook: "pre-commit",
  severity: "error",
  title: "tasks.md syntax",
  check(ctx) {
    const out = [];
    for (const c of [...ctx.changes, ...ctx.archive]) {
      for (const issue of c.tasks.parsed.issues) {
        out.push(
          f("A5", `${c.tasks.path}:${issue.line} ${issue.message}`, {
            file: c.tasks.path,
            line: issue.line,
            hint: "任务勾选只接受 '- [ ] <编号> <描述>' / '- [x] ...' 两种形态",
          })
        );
      }
    }
    return out;
  },
};

const A7 = {
  id: "A7",
  hook: "pre-commit",
  severity: "warn",
  title: "change naming",
  check(ctx) {
    return ctx.changes
      .filter((c) => !CHANGE_NAME_RE.test(c.name))
      .map((c) =>
        f("A7", `change 目录名 "${c.name}" 不是 kebab-case`, {
          file: `openspec/changes/${c.name}`,
        })
      );
  },
};

// ---------------------------------------------------------------------------
// B-class — completion & evidence chain (pre-commit / commit-msg / pre-push)
// ---------------------------------------------------------------------------

const B1 = {
  id: "B1",
  hook: "pre-commit",
  severity: "warn",
  title: "check needs evidence",
  check(ctx) {
    const flipped = ctx.changes.flatMap((c) => c.tasks.transitions.checked.map((t) => ({ c, t })));
    if (flipped.length === 0) return [];
    if (ctx.nonOpenspecStagedPaths.length > 0) return [];
    const list = flipped.map(({ t }) => t.id ? `${t.id} ${t.text}` : t.text).join("; ");
    return [
      f("B1", `勾选了 ${flipped.length} 个任务（${list}）但本次提交没有任何 openspec/ 之外的产物变更 — 完成度是声明出来的，不是做出来的`, {
        hint: "要么补上产物（代码/文档），要么把勾选撤回；纯文档任务请让产物落在 docs/** 或任意非 openspec/ 路径",
      }),
    ];
  },
};

const B3 = {
  id: "B3",
  hook: "pre-commit",
  severity: "warn",
  title: "anti bulk-check / anti zero-iteration",
  check(ctx) {
    const out = [];
    const totalChecked = ctx.changes.reduce((n, c) => n + c.tasks.transitions.checked.length, 0);
    const th = ctx.thresholds;
    if (totalChecked > th.batchCheck) {
      out.push(
        f("B3", `单次提交勾选了 ${totalChecked} 个任务（阈值 ${th.batchCheck}）— 批量勾选会让完成度失去信号价值`, {
          hint: "按逻辑单元拆分提交；确需批量完成请在 commit body 里说明",
        })
      );
    }
    for (const c of ctx.changes) {
      const total = c.tasks.parsed.tasks.length;
      if (c.isNew && total > 0 && c.tasks.transitions.checked.length === total) {
        out.push(
          f("B3", `change "${c.name}" 创建的同一个提交里就 100% 勾完（${total}/${total}）— 典型的“零迭代完成”（橡皮图章）指纹`, {
            hint: "propose 和 apply 至少分两次提交，让 tasks.md 的演进留下痕迹",
          })
        );
      }
    }
    return out;
  },
};

const B4 = {
  id: "B4",
  hook: "pre-commit",
  severity: "error",
  title: "archive gate",
  check(ctx) {
    const out = [];
    for (const a of ctx.archive) {
      const tasks = a.tasks.parsed.tasks;
      const undone = tasks.filter((t) => !t.done);
      if (tasks.length > 0 && undone.length > 0) {
        out.push(
          f("B4", `归档 "${a.dir}" 时还有 ${undone.length}/${tasks.length} 个任务未勾选`, {
            file: a.tasks.path,
            hint: "做完再归档，或先回滚/删除不再做的任务并同步 proposal.md 的 Scope",
          })
        );
      }
      if (tasks.length === 0) {
        out.push(f("B4", `归档 "${a.dir}" 的 tasks.md 里没有任何任务`, { file: a.tasks.path }));
      }
      if (!a.hasProposal) {
        out.push(f("B4", `归档 "${a.dir}" 缺少 proposal.md`, { file: a.dir }));
      }
    }
    return out;
  },
};

const B5 = {
  id: "B5",
  hook: "pre-commit",
  severity: "warn",
  title: "requirement ↔ task coverage",
  check(ctx) {
    const out = [];
    for (const c of ctx.changes) {
      const reqs = [];
      for (const d of c.deltas) {
        for (const sec of ["ADDED", "MODIFIED"]) {
          for (const r of d.parsed.sections[sec] ?? []) reqs.push({ ...r, from: d.path });
        }
      }
      const tasks = c.tasks.parsed.tasks;
      for (const r of reqs) {
        const mapped =
          requirementCovered(r.name, tasks) || requirementCoveredInText(r.name, c.tasks.indexText);
        if (!mapped) {
          out.push(
            f("B5", `需求 "${r.name}"（${r.from}）在 tasks.md 里找不到对应任务 — 有需求没排工`, {
              file: c.tasks.path,
              hint: "给每条 ADDED/MODIFIED 需求至少排一个实现/验证任务（任务名或分组标题带上需求名即可消除此提示）",
            })
          );
        }
      }
    }
    return out;
  },
};

const B6 = {
  id: "B6",
  hook: "pre-commit",
  severity: "warn",
  title: "uncheck must sync Scope",
  check(ctx) {
    const out = [];
    for (const c of ctx.changes) {
      if (c.tasks.transitions.unchecked.length > 0 && !c.proposalStaged) {
        out.push(
          f("B6", `change "${c.name}" 有 ${c.tasks.transitions.unchecked.length} 个任务从 [x] 退回 [ ]（范围收缩/重开），但 proposal.md 的 Scope 没有同步修改`, {
            file: c.tasks.path,
            hint: "范围变化要落到 proposal.md 的 ## Scope，避免提案与任务清单脱节",
          })
        );
      }
    }
    return out;
  },
};

const A6 = {
  id: "A6",
  hook: "commit-msg",
  severity: "error",
  title: "Change-Id trailer",
  check(ctx) {
    const out = [];
    const msg = ctx.message;
    if (msg.isMerge || msg.isRevert) return out;

    if (!msg.hasChangeId) {
      out.push(
        f("A6", "commit message 缺少 Change-Id trailer — 提交与 change 之间没有外键，完成度无法审计", {
          hint: "末尾加一行 'Change-Id: <change-name>'（与变更无关时用 'Change-Id: none'）",
        })
      );
    } else if (msg.changeId === "none") {
      out.push(f("A6", "本次提交声明与任何 change 无关（Change-Id: none）", { severity: "info" }));
    } else if (msg.changeIdRef === null) {
      out.push(
        f("A6", `Change-Id: ${msg.changeId} 引用的 change 不存在（changes/ 与 changes/archive/ 里都找不到）`, {
          hint: "改成真实 change 名，或用 'Change-Id: none'",
        })
      );
    }

    if (!msg.conventional) {
      out.push(f("A6", `commit subject 不符合 Conventional Commits："${msg.subject}"`, { severity: "warn" }));
    }
    return out;
  },
};

const B2 = {
  id: "B2",
  hook: "commit-msg",
  severity: "warn",
  title: "code needs progress",
  check(ctx) {
    const out = [];
    const msg = ctx.message;
    if (!msg.hasChangeId || msg.changeId === "none" || msg.changeIdRef === null) return out;
    const c = ctx.changes.find((x) => x.name === msg.changeId);
    if (!c) return out;

    const codeStaged = ctx.nonOpenspecStagedPaths.length > 0;
    const tasks = c.tasks.parsed.tasks;
    const undone = tasks.filter((t) => !t.done);

    if (codeStaged && tasks.length > 0 && undone.length === 0 && c.tasks.transitions.checked.length === 0) {
      out.push(
        f("B2", `change "${c.name}" 的任务已 100% 勾完，但本次提交仍在产出代码 — 疑似 scope creep`, {
          hint: "更新 proposal.md 的 ## Scope 并补充任务，或拆成新 change",
        })
      );
    } else if (codeStaged && undone.length > 0 && !c.tasksStaged) {
      out.push(
        f("B2", `本次提交改了代码但没同步勾选进度（change "${c.name}" 还有 ${undone.length} 个任务未完成）`, {
          severity: "info",
          hint: "如果对应任务做完了，在 tasks.md 里勾上（勾选提交请带上产物）",
        })
      );
    }
    return out;
  },
};

const B7 = {
  id: "B7",
  hook: "pre-push",
  severity: "warn",
  title: "stale change",
  check(ctx) {
    const out = [];
    const th = ctx.thresholds;
    for (const c of ctx.activeChanges) {
      const epoch = ctx.hist.lastCommitEpoch(c.path);
      if (epoch == null) continue; // not yet committed — brand new
      const days = (ctx.now - epoch) / 86400;
      if (days > th.staleDays) {
        out.push(
          f("B7", `change "${c.name}" 已 ${Math.floor(days)} 天没有任何提交（阈值 ${th.staleDays} 天）— 僵尸 change 会污染上下文`, {
            hint: "推进它、关掉它（删除并说明），或在 proposal.md 标注阻塞原因",
          })
        );
      }
    }
    return out;
  },
};

const B8 = {
  id: "B8",
  hook: "pre-push",
  severity: "warn",
  title: "evidence rate",
  check(ctx) {
    const out = [];
    const th = ctx.thresholds;
    for (const c of ctx.activeChanges) {
      const events = ctx.hist.taskCheckEvents(c.tasksPath);
      const checks = events.flatMap((e) => e.checked.map((norm) => ({ norm, evidenced: e.artifacts.length > 0, sha: e.sha })));
      if (checks.length === 0) continue;
      const evidenced = checks.filter((x) => x.evidenced).length;
      const rate = evidenced / checks.length;
      const line = `change "${c.name}" 证据率 ${evidenced}/${checks.length} = ${Math.round(rate * 100)}%`;
      if (rate < th.evidenceRate) {
        out.push(
          f("B8", `${line}（阈值 ${Math.round(th.evidenceRate * 100)}%）— 勾选与产物脱节，完成度不可信`, {
            hint: "把勾选和产物放同一个提交；无证据的勾选请回滚",
          })
        );
      } else {
        out.push(f("B8", `${line}`, { severity: "info" }));
      }
    }
    return out;
  },
};

export const RULES = [A1, A2, A3, A4, A5, A7, B1, B3, B4, B5, B6, A6, B2, B7, B8];

export function runRules(hook, ctx, config = {}) {
  const overrides = config.rules ?? {};
  const findings = [];
  for (const rule of RULES) {
    if (rule.hook !== hook) continue;
    const level = overrides[rule.id] ?? rule.severity;
    if (level === "off") continue;
    for (const item of rule.check(ctx)) {
      let severity = item.severity ?? level;
      if (severity === "off") continue;
      if (config.strict && severity === "warn") severity = "error";
      findings.push({ ...item, severity });
    }
  }
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  return findings;
}

export { parseTasks, parseDelta, parseProposalScope, taskTransitions, KNOWN_SECTIONS };
