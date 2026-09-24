// openspec-hooks-poc — thin git wrapper (spawnSync; stdio captured by parent)
import { spawnSync } from "node:child_process";

export function git(args, { cwd, input, allowFail = false } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    const err = new Error(`git ${args.join(" ")} failed (exit ${r.status}): ${(r.stderr || "").trim()}`);
    err.stderr = r.stderr;
    throw err;
  }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function repoRoot(cwd) {
  return git(["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
}

/** True when the repo has no commits yet (unborn HEAD — bootstrap case). */
export function isBootstrap(cwd) {
  return !git(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd, allowFail: true }).ok;
}

/** Staged (index vs HEAD) entries. Note: filenames with \t or \n are not supported (PoC). */
export function stagedEntries(cwd) {
  const out = git(["diff", "--cached", "--name-status", "--diff-filter=ACDMRT"], { cwd, allowFail: true }).stdout;
  const entries = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0].trim()[0];
    if (code === "R" || code === "C") {
      entries.push({ status: code, from: parts[1], path: parts[2] });
    } else {
      entries.push({ status: code, path: parts[1] });
    }
  }
  return entries;
}

/** All index paths (includes files staged for addition). */
export function lsFiles(cwd) {
  return git(["ls-files"], { cwd }).stdout.split("\n").filter(Boolean);
}

/** Content of a file in the index (staged state). "" when absent. */
export function indexContent(cwd, path) {
  return git(["show", `:${path}`], { cwd, allowFail: true }).stdout;
}

/** Content of a file at HEAD. "" when absent (new file / unborn HEAD). */
export function headContent(cwd, path) {
  return git(["show", `HEAD:${path}`], { cwd, allowFail: true }).stdout;
}

/** Epoch seconds of the last commit touching a path; null when never committed. */
export function lastCommitEpoch(cwd, path) {
  const r = git(["log", "-1", "--format=%ct", "--", path], { cwd, allowFail: true }).stdout.trim();
  return r ? Number(r) : null;
}

/**
 * Retroactively reconstruct "checkbox checked" events for one tasks.md:
 * [{ sha, checked: [normText...], artifacts: [paths outside openspec/] }]
 */
export function taskCheckEvents(cwd, tasksPath) {
  const shas = git(["log", "--format=%H", "--follow", "--", tasksPath], { cwd, allowFail: true })
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const events = [];
  for (const sha of shas) {
    const diff = git(["show", "--format=", "--unified=0", sha, "--", tasksPath], { cwd, allowFail: true }).stdout;
    const removed = []; // {norm, done}
    const added = []; // {norm, done}
    for (const line of diff.split("\n")) {
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      const m = line.match(/^([-+])(\s*)-\s+\[([ xX])\]\s+(.*)$/);
      if (!m) continue;
      const entry = { norm: normalize(m[4]), done: m[3].toLowerCase() === "x" };
      if (m[1] === "-") removed.push(entry);
      else added.push(entry);
    }
    const removedByNorm = new Map();
    for (const r of removed) if (!removedByNorm.has(r.norm)) removedByNorm.set(r.norm, r);

    const checked = [];
    for (const a of added) {
      if (!a.done) continue;
      const r = removedByNorm.get(a.norm);
      if (!r || !r.done) checked.push(a.norm); // flip or newly-added-checked
    }
    if (checked.length === 0) continue;

    const files = git(["show", "--name-only", "--format=", sha], { cwd, allowFail: true })
      .stdout.split("\n")
      .filter(Boolean);
    const artifacts = files.filter((f) => !f.startsWith("openspec/"));
    events.push({ sha, checked, artifacts });
  }
  return events;
}

function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}
