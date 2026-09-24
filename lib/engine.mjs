// openspec-hooks-poc — context gathering + reporting
// Context builders are pure given injectable sources (git-backed in production,
// string maps in tests). Rules never do I/O.

import fs from "node:fs";
import path from "node:path";
import { parseTasks, parseDelta, taskTransitions } from "./parse.mjs";
import * as G from "./git.mjs";
import { runRules, DEFAULT_THRESHOLDS } from "./rules.mjs";

export const OPENSPEC = "openspec";
const isUnder = (p, prefix) => p === prefix || p.startsWith(prefix + "/");

// ---------------------------------------------------------------------------
// Context builders (pure)
// ---------------------------------------------------------------------------

export function createPreCommitCtx({ staged, lsFiles, indexContent, headContent, thresholds = {}, extraChangeIds = [], isBootstrap = false }) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const lsSet = new Set(lsFiles);

  const specsStagedPaths = staged.map((e) => e.path).filter((p) => isUnder(p, `${OPENSPEC}/specs`));
  const changesStagedPaths = staged
    .flatMap((e) => [e.path, e.from ?? ""])
    .filter((p) => isUnder(p, `${OPENSPEC}/changes`));
  const nonOpenspecStagedPaths = staged.map((e) => e.path).filter((p) => !isUnder(p, OPENSPEC));

  // archive entries being added by this commit
  const archiveDirs = new Set();
  for (const e of staged) {
    const m = e.path.match(/^openspec\/changes\/archive\/([^/]+)\//);
    if (m) archiveDirs.add(m[1]);
  }

  // active change names touched by this commit (skip the rename that IS an archive move)
  const activeNames = new Set(extraChangeIds);
  for (const e of staged) {
    const targets = e.status === "R" ? [e.from, e.path] : [e.path];
    for (const p of targets) {
      const m = (p ?? "").match(/^openspec\/changes\/([^/]+)\//);
      if (!m || m[1] === "archive") continue;
      const name = m[1];
      const prefix = `openspec/changes/${name}`;
      const movedToArchive =
        e.status === "R" && (e.path ?? "").startsWith("openspec/changes/archive/");
      if (movedToArchive) continue;
      const filesInIndex = lsFiles.filter((f) => isUnder(f, prefix));
      const allDeleted =
        filesInIndex.length === 0 &&
        staged.filter((s) => isUnder(s.path, prefix)).every((s) => s.status === "D");
      if (allDeleted) continue; // change directory removed entirely — nothing to check
      activeNames.add(name);
    }
  }

  const buildTasks = (tasksPath) => {
    const indexText = indexContent(tasksPath) ?? "";
    const headText = headContent(tasksPath) ?? "";
    const parsed = parseTasks(indexText);
    const headParsed = parseTasks(headText);
    return { path: tasksPath, indexText, headText, parsed, headParsed, transitions: taskTransitions(headParsed, parsed) };
  };

  const buildChange = (name, base) => {
    const prefix = `openspec/changes/${name}`;
    const tasksPath = `${base}/tasks.md`;
    const proposalPath = `${base}/proposal.md`;
    const tasks = buildTasks(tasksPath);
    const deltas = lsFiles
      .filter((f) => isUnder(f, `${base}/specs`) && f.endsWith(".md"))
      .map((d) => ({ path: d, parsed: parseDelta(indexContent(d) ?? "") }));
    return {
      name,
      dir: base,
      isNew: staged.some((e) => e.status === "A" && isUnder(e.path, prefix)),
      hasProposal: lsSet.has(proposalPath),
      hasTasks: lsSet.has(tasksPath),
      proposalStaged: staged.some((e) => e.path === proposalPath),
      tasksStaged: staged.some((e) => e.path === tasksPath),
      tasks,
      deltas,
    };
  };

  const changes = [...activeNames].sort().map((n) => buildChange(n, `openspec/changes/${n}`));
  const archive = [...archiveDirs].sort().map((d) => {
    const base = `openspec/changes/archive/${d}`;
    return { ...buildChange(d, base), dir: base };
  });

  return {
    kind: "pre-commit",
    isBootstrap,
    staged,
    specsStagedPaths,
    changesStagedPaths,
    nonOpenspecStagedPaths,
    changes,
    archive,
    thresholds: th,
  };
}

const CONVENTIONAL = /^(feat|fix|docs|refactor|test|chore|build|ci|perf|style|revert)(\([^)\n]+\))?!?: .+/;

export function parseCommitMessage(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const subject = lines[0] ?? "";
  const trailerMatches = [...String(text ?? "").matchAll(/^Change-Id:\s*(\S+)\s*$/gim)];
  const changeId = trailerMatches.length > 0 ? trailerMatches[trailerMatches.length - 1][1] : null;
  return {
    subject,
    text: String(text ?? ""),
    hasChangeId: changeId !== null,
    changeId,
    isMerge: /^Merge (branch|remote-tracking|pull request|tag)|^Merge:/i.test(subject),
    isRevert: /^Revert "/i.test(subject),
    conventional: CONVENTIONAL.test(subject),
  };
}

export function createCommitMsgCtx({ message, thresholds = {}, ...preCommitInput }) {
  const msg = typeof message === "string" ? parseCommitMessage(message) : message;
  let changeIdRef = null;
  if (msg.hasChangeId && msg.changeId !== "none") {
    const id = msg.changeId;
    const ls = preCommitInput.lsFiles ?? [];
    const active = ls.some((f) => isUnder(f, `openspec/changes/${id}`));
    const archived = ls.some((f) => {
      const m = f.match(/^openspec\/changes\/archive\/([^/]+)\//);
      return m ? m[1] === id || m[1].endsWith(`-${id}`) : false;
    });
    changeIdRef = active ? "active" : archived ? "archive" : null;
  }
  const extra = changeIdRef === "active" ? [msg.changeId] : [];
  const pre = createPreCommitCtx({ ...preCommitInput, thresholds, extraChangeIds: extra });
  return { ...pre, kind: "commit-msg", message: { ...msg, changeIdRef } };
}

export function createPrePushCtx({ activeChanges, hist, now = Math.floor(Date.now() / 1000), thresholds = {} }) {
  return {
    kind: "pre-push",
    activeChanges,
    hist,
    now,
    thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
  };
}

// ---------------------------------------------------------------------------
// Real gathering (git-backed)
// ---------------------------------------------------------------------------

export function loadConfig(root) {
  const p = path.join(root, "openspec-hooks.json");
  let config = { rules: {}, thresholds: {} };
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      config = { rules: raw.rules ?? {}, thresholds: raw.thresholds ?? {} };
    } catch {
      process.stderr.write(`[openspec-hooks] openspec-hooks.json 解析失败，按默认配置运行\n`);
    }
  }
  if (process.env.OPENSPEC_HOOKS_STRICT === "1") config.strict = true;
  return config;
}

function gitSources(cwd) {
  return {
    staged: G.stagedEntries(cwd),
    lsFiles: G.lsFiles(cwd),
    indexContent: (p) => G.indexContent(cwd, p),
    headContent: (p) => G.headContent(cwd, p),
    isBootstrap: G.isBootstrap(cwd),
  };
}

export function gatherPreCommit(cwd, config = {}) {
  return createPreCommitCtx({ ...gitSources(cwd), thresholds: config.thresholds });
}

export function gatherCommitMsg(cwd, msgPath, config = {}) {
  const text = fs.readFileSync(msgPath, "utf8");
  return createCommitMsgCtx({ message: text, ...gitSources(cwd), thresholds: config.thresholds });
}

export function gatherPrePush(cwd, config = {}, now = Math.floor(Date.now() / 1000)) {
  const ls = G.lsFiles(cwd);
  const names = new Set();
  for (const f of ls) {
    const m = f.match(/^openspec\/changes\/([^/]+)\//);
    if (m && m[1] !== "archive") names.add(m[1]);
  }
  const activeChanges = [...names].sort().map((name) => ({
    name,
    path: `openspec/changes/${name}`,
    tasksPath: `openspec/changes/${name}/tasks.md`,
  }));
  const hist = {
    lastCommitEpoch: (p) => G.lastCommitEpoch(cwd, p),
    taskCheckEvents: (p) => G.taskCheckEvents(cwd, p),
  };
  return createPrePushCtx({ activeChanges, hist, now, thresholds: config.thresholds });
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const ICON = { error: "✖", warn: "⚠", info: "ℹ" };

export function formatFindings(findings) {
  const out = [];
  for (const f of findings) {
    const loc = f.file ? ` ${f.file}${f.line ? ":" + f.line : ""} —` : "";
    out.push(`${ICON[f.severity]} [${f.id}] ${f.severity}${loc} ${f.message}`);
    if (f.hint) out.push(`        ↳ ${f.hint}`);
  }
  return out.join("\n");
}

export function summarize(findings) {
  const n = (s) => findings.filter((f) => f.severity === s).length;
  return { errors: n("error"), warns: n("warn"), infos: n("info") };
}

export function report(findings, { json = false, hook } = {}) {
  const { errors, warns, infos } = summarize(findings);
  if (json) {
    process.stdout.write(JSON.stringify({ hook, findings, summary: { errors, warns, infos } }, null, 2) + "\n");
  } else {
    const body = formatFindings(findings);
    if (body) process.stdout.write(body + "\n");
    const tail =
      errors > 0
        ? `[openspec-hooks] ${errors} error / ${warns} warning — ${hook} 被阻止（绕过：--no-verify，但会失去完成度审计）`
        : `[openspec-hooks] ${errors} error / ${warns} warning / ${infos} info — 通过`;
    process.stdout.write(tail + "\n");
  }
  return errors > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// B9 — post-commit progress panel (status command; never blocks)
// ---------------------------------------------------------------------------

export function statusPanel(cwd) {
  const changesDir = path.join(cwd, OPENSPEC, "changes");
  const names = fs.existsSync(changesDir)
    ? fs
        .readdirSync(changesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== "archive")
        .map((d) => d.name)
        .sort()
    : [];

  const lines = ["[openspec-hooks] 进度面板"];
  if (names.length === 0) {
    lines.push("  （没有 active change — 用 /opsx:propose <name> 开一个）");
  }
  for (const name of names) {
    const tasksPath = path.join(changesDir, name, "tasks.md");
    const text = fs.existsSync(tasksPath) ? fs.readFileSync(tasksPath, "utf8") : "";
    const { tasks } = parseTasks(text);
    const done = tasks.filter((t) => t.done).length;
    const total = tasks.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bar = "#".repeat(Math.round(pct / 10)) + "-".repeat(10 - Math.round(pct / 10));
    const epoch = G.lastCommitEpoch(cwd, `openspec/changes/${name}`);
    const days = epoch ? Math.floor((Date.now() / 1000 - epoch) / 86400) : null;
    const last = epoch ? `${days} 天前` : "未提交";
    let hint;
    if (total > 0 && done === total) hint = "全部完成 → 该 /opsx:archive 了";
    else if (total === 0) hint = "tasks.md 还没有任务 → /opsx:apply 细化";
    else hint = `剩余 ${total - done} 个任务 → /opsx:apply 继续`;
    lines.push(`  ● ${name.padEnd(28)} [${bar}] ${done}/${total}  最近提交 ${last}`);
    lines.push(`    ↳ ${hint}`);
  }
  return lines.join("\n") + "\n";
}
