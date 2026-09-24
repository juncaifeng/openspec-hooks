// openspec-hooks — end-to-end smoke test against REAL scratch git repos
// (wire hooks via core.hooksPath and via `openspec-hooks install`; assert
//  commits are blocked/allowed as designed). Run: node test/integration.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.dirname(here);
const hooksDir = path.join(pkgRoot, "githooks").replace(/\\/g, "/");

let pass = 0;
let fail = 0;

function sh(cwd, cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, ...opts });
}

function git(cwd, ...args) {
  const r = sh(cwd, "git", args);
  return r;
}

function makeRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openspec-hooks-${tag}-`));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "PoC");
  git(dir, "config", "user.email", "poc@test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", hooksDir);
  fs.writeFileSync(path.join(dir, "openspec-hooks.json"), JSON.stringify({ rules: { B1: "error" } }, null, 2));
  // baseline commit so later scenarios have a real HEAD
  fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
  git(dir, "add", "-A");
  const base = git(dir, "commit", "-q", "-m", "chore: init\n\nChange-Id: none");
  if (base.status !== 0) throw new Error(`baseline commit failed: ${base.stderr}`);
  return dir;
}

function write(dir, rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const tasksMd = (rows) =>
  ["# Tasks", "", ...rows.map(([id, text, done]) => `- [${done ? "x" : " "}] ${id} ${text}`)].join("\n");

const deltaMd = (req) =>
  [
    "# Delta for Demo",
    "",
    "## ADDED Requirements",
    "",
    `### Requirement: ${req}`,
    "",
    `The system MUST implement ${req}.`,
    "",
    "#### Scenario: happy path",
    "- GIVEN a user",
    "- WHEN it happens",
    "- THEN it works",
  ].join("\n");

function commitExpect(dir, msg, wantOk, label) {
  fs.writeFileSync(path.join(dir, ".git", "COMMIT_EDITMSG_TMP"), msg);
  const r = git(dir, "commit", "-q", "-F", path.join(dir, ".git", "COMMIT_EDITMSG_TMP"));
  const ok = r.status === 0;
  const verdict = ok === wantOk ? "✔" : "✖";
  if (ok === wantOk) pass++;
  else fail++;
  console.log(`${verdict} ${label}`);
  if (ok !== wantOk) {
    console.log(`    exit=${r.status}\n    stdout=${(r.stdout || "").trim()}\n    stderr=${(r.stderr || "").trim()}`);
  } else if ((r.stdout || "").trim()) {
    console.log(`    ${(r.stdout || "").trim().split("\n").slice(0, 3).join("\n    ")}`);
  }
}

// ---------------------------------------------------------------------------
// S1 — direct specs/ edit is blocked
// ---------------------------------------------------------------------------
{
  const dir = makeRepo("s1");
  write(dir, "openspec/specs/demo/spec.md", "# I edited the source of truth directly\n");
  git(dir, "add", "-A");
  commitExpect(dir, "feat: tweak spec\n\nChange-Id: none", false, "S1 direct specs/ edit → blocked (A1)");
}

// S2 — proper change: code + delta + one evidenced check → allowed
{
  const dir = makeRepo("s2");
  write(dir, "openspec/changes/do-thing/proposal.md", "# Proposal: Do thing\n\n## Scope\n- demo\n");
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]));
  write(dir, "openspec/changes/do-thing/specs/demo/spec.md", deltaMd("Do thing"));
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  commitExpect(dir, "feat: implement do-thing\n\nChange-Id: do-thing", true, "S2 code + delta + evidenced check → allowed");
}

// S3 — checkbox flip with zero artifacts → blocked (B1 promoted to error via config)
{
  const dir = makeRepo("s3");
  write(dir, "openspec/changes/do-thing/proposal.md", "# Proposal: Do thing\n\n## Scope\n- demo\n");
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]));
  write(dir, "openspec/changes/do-thing/specs/demo/spec.md", deltaMd("Do thing"));
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  commitExpect(dir, "feat: implement do-thing\n\nChange-Id: do-thing", true, "S3 setup commit");
  // now flip a checkbox with NO artifact change at all
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]));
  git(dir, "add", "-A");
  commitExpect(dir, "feat: finish do-thing\n\nChange-Id: do-thing", false, "S3 evidence-less check → blocked (B1)");
}

// S4 — archive with unchecked tasks → blocked (B4); clean archive → allowed
{
  const dir = makeRepo("s4");
  write(dir, "openspec/changes/do-thing/proposal.md", "# Proposal: Do thing\n\n## Scope\n- demo\n");
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]));
  write(dir, "openspec/changes/do-thing/specs/demo/spec.md", deltaMd("Do thing"));
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  commitExpect(dir, "feat: implement do-thing\n\nChange-Id: do-thing", true, "S4 setup commit");
  // archive too early (1.2 still unchecked) → blocked
  fs.mkdirSync(path.join(dir, "openspec", "changes", "archive"), { recursive: true });
  fs.renameSync(
    path.join(dir, "openspec", "changes", "do-thing"),
    path.join(dir, "openspec", "changes", "archive", "2026-04-20-do-thing")
  );
  git(dir, "add", "-A");
  commitExpect(dir, "chore: archive do-thing\n\nChange-Id: do-thing", false, "S4 premature archive → blocked (B4)");

  // undo the rename so the change stays active
  fs.renameSync(
    path.join(dir, "openspec", "changes", "archive", "2026-04-20-do-thing"),
    path.join(dir, "openspec", "changes", "do-thing")
  );
  git(dir, "add", "-A");

  // finish the remaining task WITH an artifact → allowed
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]));
  write(dir, "src/b.ts", "export const b = 2;\n");
  git(dir, "add", "-A");
  commitExpect(dir, "feat: ship it\n\nChange-Id: do-thing", true, "S4 finish task with artifact → allowed");

  // clean archive: move to archive/ + merge delta into specs/ in one commit → allowed
  fs.renameSync(
    path.join(dir, "openspec", "changes", "do-thing"),
    path.join(dir, "openspec", "changes", "archive", "2026-04-20-do-thing")
  );
  write(dir, "openspec/specs/demo/spec.md", deltaMd("Do thing"));
  git(dir, "add", "-A");
  commitExpect(dir, "chore: archive do-thing\n\nChange-Id: do-thing", true, "S4 clean archive + spec merge → allowed");
}

// S5 — openspec-hooks.json thresholds must actually reach the rules (regression:
// config thresholds were once silently ignored)
{
  const dir = makeRepo("s5");
  write(dir, "openspec/changes/do-thing/proposal.md", "# Proposal: Do thing\n\n## Scope\n- demo\n");
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true]]));
  write(dir, "openspec/changes/do-thing/specs/demo/spec.md", deltaMd("Do thing"));
  write(dir, "openspec-hooks.json", JSON.stringify({ rules: { B1: "error" }, thresholds: { batchCheck: 0 } }, null, 2));
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  const r = sh(dir, "node", [path.join(pkgRoot, "bin", "openspec-hooks.mjs"), "pre-commit", "--json"]);
  let ok = false;
  let detail = "";
  try {
    const parsed = JSON.parse(r.stdout);
    const ids = parsed.findings.map((f) => f.id);
    ok = ids.includes("B3"); // batchCheck: 0 → the single check must trip B3
    detail = `findings: [${ids.join(", ")}]`;
  } catch (e) {
    detail = `bad CLI output: ${(r.stdout || "").slice(0, 200)}`;
  }
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✔" : "✖"} S5 config thresholds reach rules (${detail})`);
}

// S6 — `openspec-hooks install` deploys a self-contained bundle; hooks keep
// working from it (no dependency on node_modules or the original package dir)
{
  const dir = makeRepo("s6");
  sh(dir, "node", [path.join(pkgRoot, "bin", "openspec-hooks.mjs"), "install", "--repo", dir]);
  const structural =
    fs.existsSync(path.join(dir, ".openspec-hooks", "bin", "openspec-hooks.mjs")) &&
    fs.existsSync(path.join(dir, ".openspec-hooks", "githooks", "pre-commit")) &&
    git(dir, "config", "core.hooksPath").stdout.trim() === ".openspec-hooks/githooks" &&
    fs.readFileSync(path.join(dir, ".gitignore"), "utf8").includes(".openspec-hooks/");
  if (structural) pass++;
  else fail++;
  console.log(`${structural ? "✔" : "✖"} S6 install deploys bundle + core.hooksPath + gitignore`);

  write(dir, "openspec/changes/do-thing/proposal.md", "# Proposal: Do thing\n\n## Scope\n- demo\n");
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]));
  write(dir, "openspec/changes/do-thing/specs/demo/spec.md", deltaMd("Do thing"));
  write(dir, "src/a.ts", "export const a = 1;\n");
  git(dir, "add", "-A");
  commitExpect(dir, "feat: implement do-thing\n\nChange-Id: do-thing", true, "S6 bundle hooks allow a good commit");
  write(dir, "openspec/changes/do-thing/tasks.md", tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]));
  git(dir, "add", "-A");
  commitExpect(dir, "feat: finish do-thing\n\nChange-Id: do-thing", false, "S6 bundle hooks block evidence-less check (B1)");
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
