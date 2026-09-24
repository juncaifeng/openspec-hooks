#!/usr/bin/env node
// openspec-hooks — git hooks that turn OpenSpec workflow conventions into enforced constraints
//
// Commands:
//   openspec-hooks install [--repo <path>] [--skills-dir <dir> | --skills-global | --no-skills]
//                          install hooks (self-contained .openspec-hooks/ bundle + core.hooksPath)
//                          and deploy the SKILL.md commit contract for AI agents
//   openspec-hooks uninstall [--repo <path>]  remove hooks, bundle and installed skills
//   openspec-hooks pre-commit                 hook entry point (also runnable manually)
//   openspec-hooks commit-msg <msgfile>       hook entry point
//   openspec-hooks pre-push                   hook entry point
//   openspec-hooks status                     progress panel (check ratio + next step per active change)
//
// Env:
//   OPENSPEC_SKIP_HOOKS=1    skip all checks (fail-open escape hatch)
//   OPENSPEC_HOOKS_STRICT=1  promote warnings to errors

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { repoRoot } from "../lib/git.mjs";
import { runRules } from "../lib/rules.mjs";
import {
  gatherPreCommit,
  gatherCommitMsg,
  gatherPrePush,
  loadConfig,
  report,
  statusPanel,
} from "../lib/engine.mjs";

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE_DIRS = ["bin", "lib", "githooks", "skills"];
const BUNDLE_DIR_NAME = ".openspec-hooks";
const SKILL_NAME = "openspec-hooks";
const PROJECT_SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills"];
const GLOBAL_SKILL_DIRS = ["agents/skills", ".agents/skills", ".claude/skills"];
const DEFAULT_CONFIG = {
  rules: { B1: "warn", B3: "warn", B5: "warn", B7: "warn", B8: "warn" },
  thresholds: { batchCheck: 5, staleDays: 7, evidenceRate: 0.5 },
};

function git(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function resolveRepo(args) {
  const i = args.indexOf("--repo");
  return path.resolve(i >= 0 ? args[i + 1] ?? "." : ".");
}

/**
 * Where to deploy the SKILL.md contract so AI agents can read it:
 *   --no-skills            nowhere
 *   --skills-dir <dir>     exactly there
 *   --skills-global        user-level dirs (~/agents/skills by default;
 *                          mirrors into ~/.claude/skills etc. when they exist)
 *   (default)              repo-level dirs (mirrors into .claude/skills etc.
 *                          when they exist; creates .agents/skills otherwise)
 */
function resolveSkillTargets(root, args) {
  if (args.includes("--no-skills")) return [];
  const dirIdx = args.indexOf("--skills-dir");
  if (dirIdx >= 0 && args[dirIdx + 1]) return [path.resolve(root, args[dirIdx + 1])];
  const candidates = args.includes("--skills-global") ? GLOBAL_SKILL_DIRS : PROJECT_SKILL_DIRS;
  const base = args.includes("--skills-global") ? os.homedir() : root;
  const existing = candidates.map((d) => path.join(base, ...d.split("/"))).filter((p) => fs.existsSync(p));
  const fallback = args.includes("--skills-global")
    ? path.join(os.homedir(), ...GLOBAL_SKILL_DIRS[0].split("/"))
    : path.join(root, ...PROJECT_SKILL_DIRS[0].split("/"));
  return existing.length > 0 ? [...new Set(existing)] : [fallback];
}

function install(args) {
  const target = resolveRepo(args);
  const top = git(target, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    process.stderr.write(`不是 git 仓库：${target}\n`);
    return 2;
  }
  const root = top.stdout.trim();
  const bundle = path.join(root, BUNDLE_DIR_NAME);

  fs.rmSync(bundle, { recursive: true, force: true });
  for (const d of BUNDLE_DIRS) {
    fs.cpSync(path.join(PACKAGE_DIR, d), path.join(bundle, d), { recursive: true });
  }
  if (process.platform !== "win32") {
    for (const h of ["pre-commit", "commit-msg", "pre-push", "post-commit"]) {
      fs.chmodSync(path.join(bundle, "githooks", h), 0o755);
    }
  }

  // the bundle is machine-generated — keep it out of version control
  const gitignore = path.join(root, ".gitignore");
  const line = `${BUNDLE_DIR_NAME}/`;
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  if (!current.split(/\r?\n/).includes(line)) {
    fs.writeFileSync(gitignore, current + (current && !current.endsWith("\n") ? "\n" : "") + line + "\n");
  }

  const cfg = path.join(root, "openspec-hooks.json");
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }

  // deploy the SKILL.md commit contract so AI agents learn the rules up front
  const skillTargets = resolveSkillTargets(root, args);
  const manifest = { skills: [] };
  for (const dir of skillTargets) {
    const dest = path.join(dir, SKILL_NAME);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(PACKAGE_DIR, "skills", SKILL_NAME), dest, { recursive: true });
    manifest.skills.push(dest);
  }
  fs.writeFileSync(path.join(bundle, "install-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  git(root, ["config", "core.hooksPath", `${BUNDLE_DIR_NAME}/githooks`]);

  process.stdout.write(`✔ openspec-hooks 已安装\n`);
  process.stdout.write(`  仓库：${root}\n`);
  process.stdout.write(`  core.hooksPath = ${BUNDLE_DIR_NAME}/githooks（自包含 bundle，升级后重跑 install 即可）\n`);
  process.stdout.write(`  钩子：pre-commit / commit-msg / pre-push / post-commit（进度面板）\n`);
  if (manifest.skills.length > 0) {
    process.stdout.write(`  skills：${manifest.skills.join(", ")}\n`);
    process.stdout.write(`  （SKILL.md 提交契约已就位，agent 读到即知道 Change-Id/证据勾选/归档门禁规则）\n`);
  } else {
    process.stdout.write(`  skills：跳过（--no-skills）\n`);
  }
  process.stdout.write(`  逃生舱：--no-verify 或 OPENSPEC_SKIP_HOOKS=1；严格模式：OPENSPEC_HOOKS_STRICT=1\n`);
  return 0;
}

function uninstall(args) {
  const target = resolveRepo(args);
  const top = git(target, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) {
    process.stderr.write(`不是 git 仓库：${target}\n`);
    return 2;
  }
  const root = top.stdout.trim();
  // remove skill copies recorded at install time (before dropping the bundle)
  try {
    const manifestPath = path.join(root, BUNDLE_DIR_NAME, "install-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const p of manifest.skills ?? []) fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* no manifest — nothing to clean */
  }
  git(root, ["config", "--unset", "core.hooksPath"]);
  fs.rmSync(path.join(root, BUNDLE_DIR_NAME), { recursive: true, force: true });
  process.stdout.write(`✔ openspec-hooks 已卸载（${root}）\n`);
  return 0;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function lint(args) {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("-") && a !== json);
  const cmd = positional[0];

  if (process.env.OPENSPEC_SKIP_HOOKS === "1") {
    process.stderr.write("[openspec-hooks] OPENSPEC_SKIP_HOOKS=1 — 本次检查跳过\n");
    return 0;
  }

  const cwd = repoRoot(process.cwd());
  const config = loadConfig(cwd);

  if (cmd === "pre-commit") {
    return report(runRules("pre-commit", gatherPreCommit(cwd, config), config), { json, hook: "pre-commit" });
  }
  if (cmd === "commit-msg") {
    if (!positional[1]) {
      process.stderr.write("usage: openspec-hooks commit-msg <msgfile>\n");
      return 2;
    }
    return report(runRules("commit-msg", gatherCommitMsg(cwd, positional[1], config), config), { json, hook: "commit-msg" });
  }
  if (cmd === "pre-push") {
    await readStdin().catch(() => "");
    return report(runRules("pre-push", gatherPrePush(cwd, config), config), { json, hook: "pre-push" });
  }
  if (cmd === "status") {
    process.stdout.write(statusPanel(cwd));
    return 0;
  }
  process.stderr.write("usage: openspec-hooks install|uninstall|pre-commit|commit-msg <msgfile>|pre-push|status\n");
  process.stderr.write("       install flags: --repo <path> --skills-dir <dir> --skills-global --no-skills\n");
  return 2;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "install") return install(args);
  if (cmd === "uninstall") return uninstall(args);
  return lint(args);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    // fail-open: never brick a commit because the linter itself crashed
    process.stderr.write(`[openspec-hooks] 内部错误（已放行）：${err?.message ?? err}\n`);
    process.exit(0);
  });
