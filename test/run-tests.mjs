// openspec-hooks-poc — rule unit tests (pure fixtures, no git needed)
// Run: node test/run-tests.mjs

import { createPreCommitCtx, createCommitMsgCtx, createPrePushCtx } from "../lib/engine.mjs";
import { runRules, DEFAULT_THRESHOLDS } from "../lib/rules.mjs";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✔ ${name}`);
  } catch (e) {
    fail++;
    console.log(`✖ ${name}\n    ${e.message}`);
  }
}
const fired = (findings) => [...new Set(findings.map((f) => f.id))];
function expectFires(findings, ids) {
  const got = fired(findings);
  for (const id of ids) if (!got.includes(id)) throw new Error(`expected ${id} to fire, got [${got.join(", ") || "none"}]`);
}
function expectNot(findings, ids) {
  // info-level findings never block and may legitimately mention the rule
  const got = fired(findings.filter((f) => f.severity !== "info"));
  for (const id of ids) if (got.includes(id)) throw new Error(`expected ${id} NOT to fire, got [${got.join(", ") || "none"}]`);
}
function expectClean(findings) {
  const bad = findings.filter((f) => f.severity !== "info");
  if (bad.length) throw new Error(`expected clean, got: ${bad.map((f) => `${f.id}:${f.message}`).join(" | ")}`);
}

// ---------------------------------------------------------------------------
// fixture builders
// ---------------------------------------------------------------------------
const add = (path) => ({ status: "A", path });
const mod = (path) => ({ status: "M", path });
const del = (path) => ({ status: "D", path });
const ren = (from, to) => ({ status: "R", from, path: to });

const tasksMd = (rows) =>
  ["# Tasks", "", ...rows.map(([id, text, done]) => `- [${done ? "x" : " "}] ${id} ${text}`)].join("\n");

const deltaMd = (reqs, heading = "## ADDED Requirements") =>
  [
    "# Delta for Demo",
    "",
    heading,
    "",
    ...reqs.flatMap((r) => [
      `### Requirement: ${r}`,
      "",
      `The system MUST implement ${r}.`,
      "",
      "#### Scenario: happy path",
      "- GIVEN a user",
      "- WHEN it happens",
      "- THEN it works",
      "",
    ]),
  ].join("\n");

const proposalMd = (scope = ["- demo"]) => ["# Proposal: Demo", "", "## Scope", ...scope].join("\n");

function ctx({ staged = [], files = {}, ls = null, extraChangeIds = [] }) {
  const lsFiles = ls ?? Object.keys(files);
  return createPreCommitCtx({
    staged,
    lsFiles,
    indexContent: (p) => files[p]?.index ?? "",
    headContent: (p) => files[p]?.head ?? "",
    extraChangeIds,
  });
}

/** Standard do-thing change: proposal + tasks + delta all present in index. */
function baseFiles(name = "do-thing", { tasksIndex, tasksHead, delta = deltaMd(["Do thing"]) } = {}) {
  return {
    [`openspec/changes/${name}/proposal.md`]: { index: proposalMd() },
    [`openspec/changes/${name}/tasks.md`]: {
      index: tasksIndex ?? tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]),
      head: tasksHead ?? tasksMd([["1.1", "Do thing", false], ["1.2", "Ship it", false]]),
    },
    [`openspec/changes/${name}/specs/demo/spec.md`]: { index: delta },
  };
}

const runPre = (input, config = {}) => runRules("pre-commit", ctx(input), config);
const runMsg = (message, input, config = {}) => runRules("commit-msg", createCommitMsgCtx({ message, ...inputLike(input) }), config);
function inputLike(input = {}) {
  return {
    staged: input.staged ?? [],
    lsFiles: input.ls ?? Object.keys(input.files ?? {}),
    indexContent: (p) => input.files?.[p]?.index ?? "",
    headContent: (p) => input.files?.[p]?.head ?? "",
    extraChangeIds: input.extraChangeIds,
  };
}

// ---------------------------------------------------------------------------
// A-class
// ---------------------------------------------------------------------------

test("good commit: code + one evidenced check → clean", () => {
  const findings = runPre({
    staged: [mod("src/a.ts"), mod("openspec/changes/do-thing/tasks.md")],
    files: baseFiles(),
  });
  expectClean(findings);
});

test("A1: direct specs/ edit without a change → error", () => {
  const findings = runPre({
    staged: [mod("openspec/specs/demo/spec.md")],
    files: { "openspec/specs/demo/spec.md": { index: "# spec", head: "# old" } },
  });
  expectFires(findings, ["A1"]);
});

test("A1: specs/ edit hidden inside a propose commit (changes/ but no archive/) → error", () => {
  const files = baseFiles();
  files["openspec/specs/demo/spec.md"] = { index: "# spec\nnew line", head: "# spec" };
  const findings = runPre({
    staged: [mod("openspec/specs/demo/spec.md"), add("openspec/changes/do-thing/proposal.md"), add("openspec/changes/do-thing/tasks.md")],
    files,
  });
  expectFires(findings, ["A1"]);
});

test("A1: bootstrap (unborn HEAD) specs/ creation → exempt (info)", () => {
  const findings = runRules(
    "pre-commit",
    createPreCommitCtx({
      staged: [add("openspec/specs/demo/spec.md")],
      lsFiles: ["openspec/specs/demo/spec.md"],
      indexContent: (p) => (p === "openspec/specs/demo/spec.md" ? "# spec" : ""),
      headContent: () => "",
      isBootstrap: true,
    }),
    {}
  );
  expectNot(findings, ["A1"]); // info-level only
  if (!findings.some((f) => f.id === "A1" && f.severity === "info")) throw new Error("expected A1 info note");
});

test("A1: specs/ edit WITH archive/changes in same commit → ok", () => {
  const a = "openspec/changes/archive/2026-04-20-do-thing";
  const files = {
    [`${a}/proposal.md`]: { index: proposalMd() },
    [`${a}/tasks.md`]: { index: tasksMd([["1.1", "Do thing", true]]), head: "" },
    [`${a}/specs/demo/spec.md`]: { index: deltaMd(["Do thing"]) },
    "openspec/specs/demo/spec.md": { index: "# spec", head: "" },
  };
  const findings = runPre({
    staged: [
      mod("openspec/specs/demo/spec.md"),
      add(`${a}/proposal.md`),
      ren("openspec/changes/do-thing/tasks.md", `${a}/tasks.md`),
    ],
    files,
  });
  expectNot(findings, ["A1", "A2", "B4"]);
});

test("A2: archive dir without date prefix → error; impure archive commit → warn", () => {
  const files = baseFiles("do-thing");
  files["openspec/changes/archive/do-thing/tasks.md"] = { index: tasksMd([["1.1", "Do thing", true]]) };
  const findings = runPre({
    staged: [ren("openspec/changes/do-thing/tasks.md", "openspec/changes/archive/do-thing/tasks.md"), mod("src/a.ts")],
    files,
  });
  expectFires(findings, ["A2"]);
  const impurity = findings.find((f) => f.id === "A2" && f.severity === "warn");
  if (!impurity) throw new Error("expected A2 impurity warn");
});

test("A3: change missing proposal.md → error", () => {
  const findings = runPre({
    staged: [add("openspec/changes/foo/tasks.md")],
    files: { "openspec/changes/foo/tasks.md": { index: tasksMd([["1.1", "x", false]]) } },
  });
  expectFires(findings, ["A3"]);
});

test("A4: near-miss delta heading '## ADDED Requirement' → error", () => {
  const findings = runPre({
    staged: [mod("src/a.ts"), mod("openspec/changes/do-thing/specs/demo/spec.md")],
    files: {
      ...baseFiles(),
      "openspec/changes/do-thing/specs/demo/spec.md": { index: deltaMd(["Do thing"], "## ADDED Requirement") },
    },
  });
  expectFires(findings, ["A4"]);
});

test("A5: malformed checkbox line → error", () => {
  const bad = ["# Tasks", "- [] 1.1 Do thing"].join("\n");
  const findings = runPre({
    staged: [mod("openspec/changes/do-thing/tasks.md")],
    files: {
      ...baseFiles("do-thing", { tasksIndex: bad, tasksHead: bad }),
    },
  });
  expectFires(findings, ["A5"]);
});

test("A7: non-kebab-case change name → warn", () => {
  const findings = runPre({
    staged: [add("openspec/changes/Add_Dark/tasks.md")],
    files: {
      "openspec/changes/Add_Dark/tasks.md": { index: tasksMd([["1.1", "x", false]]) },
      "openspec/changes/Add_Dark/proposal.md": { index: proposalMd() },
    },
  });
  expectFires(findings, ["A7"]);
});

// ---------------------------------------------------------------------------
// B-class — completion & evidence
// ---------------------------------------------------------------------------

test("B1: checkbox flipped with zero artifacts → fires", () => {
  const findings = runPre({
    staged: [mod("openspec/changes/do-thing/tasks.md")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]),
      tasksHead: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]),
    }),
  });
  expectFires(findings, ["B1"]);
});

test("B1 config: severity overridable to error", () => {
  const findings = runPre(
    {
      staged: [mod("openspec/changes/do-thing/tasks.md")],
      files: baseFiles("do-thing", {
        tasksIndex: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]),
        tasksHead: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]),
      }),
    },
    { rules: { B1: "error" } }
  );
  const b1 = findings.find((f) => f.id === "B1");
  if (b1?.severity !== "error") throw new Error(`expected B1 error, got ${b1?.severity}`);
});

test("B3: bulk-check (>5 flips) → warn", () => {
  const rows = (done) => Array.from({ length: 6 }, (_, i) => [`${i + 1}.1`, `task ${i}`, done]);
  const findings = runPre({
    staged: [mod("src/a.ts"), mod("openspec/changes/do-thing/tasks.md")],
    files: {
      ...baseFiles("do-thing", { tasksIndex: tasksMd(rows(true)), tasksHead: tasksMd(rows(false)) }),
    },
  });
  expectFires(findings, ["B3"]);
  expectNot(findings, ["B1"]);
});

test("B3: zero-iteration (new change 100% checked in creation commit) → warn", () => {
  const findings = runPre({
    staged: [add("src/a.ts"), add("openspec/changes/do-thing/proposal.md"), add("openspec/changes/do-thing/tasks.md")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]),
      tasksHead: "",
    }),
  });
  expectFires(findings, ["B3"]);
});

test("B4: archive with unchecked tasks → error", () => {
  const files = {
    "openspec/changes/archive/2026-04-20-do-thing/proposal.md": { index: proposalMd() },
    "openspec/changes/archive/2026-04-20-do-thing/tasks.md": {
      index: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]),
    },
    "openspec/changes/archive/2026-04-20-do-thing/specs/demo/spec.md": { index: deltaMd(["Do thing"]) },
  };
  const findings = runPre({
    staged: [
      ren("openspec/changes/do-thing/tasks.md", "openspec/changes/archive/2026-04-20-do-thing/tasks.md"),
      add("openspec/changes/archive/2026-04-20-do-thing/proposal.md"),
    ],
    files,
  });
  expectFires(findings, ["B4"]);
});

test("B5: requirement without any covering task → warn", () => {
  const findings = runPre({
    staged: [mod("src/a.ts"), mod("openspec/changes/do-thing/specs/demo/spec.md")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "set up login", false]]),
      tasksHead: tasksMd([["1.1", "set up login", false]]),
      delta: deltaMd(["Two-Factor Authentication"]),
    }),
  });
  expectFires(findings, ["B5"]);
});

test("B5: requirement covered by task text → clean", () => {
  const findings = runPre({
    staged: [mod("openspec/changes/do-thing/specs/demo/spec.md")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "Two-Factor Authentication", false]]),
      tasksHead: tasksMd([["1.1", "Two-Factor Authentication", false]]),
      delta: deltaMd(["Two-Factor Authentication"]),
    }),
  });
  expectNot(findings, ["B5"]);
});

test("B6: uncheck without syncing proposal.md Scope → warn", () => {
  const findings = runPre({
    staged: [mod("openspec/changes/do-thing/tasks.md")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "Do thing", false], ["1.2", "Ship it", false]]),
      tasksHead: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]),
    }),
  });
  expectFires(findings, ["B6"]);
});

test("B6: uncheck WITH proposal.md staged → clean", () => {
  const findings = runPre({
    staged: [mod("openspec/changes/do-thing/tasks.md"), mod("openspec/changes/do-thing/proposal.md")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "Do thing", false], ["1.2", "Ship it", false]]),
      tasksHead: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", false]]),
    }),
  });
  expectNot(findings, ["B6"]);
});

test("deleted change directory is ignored (no false A3)", () => {
  const findings = runPre({
    staged: [del("openspec/changes/do-thing/tasks.md"), del("openspec/changes/do-thing/proposal.md")],
    files: {},
  });
  expectNot(findings, ["A3", "A4", "A5"]);
});

// ---------------------------------------------------------------------------
// commit-msg
// ---------------------------------------------------------------------------

test("A6: missing Change-Id trailer → error", () => {
  const findings = runMsg("fix: repair the thing", { staged: [], files: {} });
  expectFires(findings, ["A6"]);
});

test("A6: Change-Id pointing at a non-existent change → error", () => {
  const findings = runMsg("fix: repair the thing\n\nChange-Id: ghost", { staged: [], files: {} });
  expectFires(findings, ["A6"]);
});

test("A6: Change-Id: none → info only; valid ref → clean", () => {
  const none = runMsg("chore: init\n\nChange-Id: none", { staged: [], files: {} });
  expectNot(none, ["A6"]);
  const ok = runMsg("feat: implement do-thing\n\nChange-Id: do-thing", {
    staged: [],
    files: baseFiles(),
  });
  expectNot(ok, ["A6"]);
});

test("A6: archived change id resolves (suffix match) → clean", () => {
  const findings = runMsg("fix: tweak\n\nChange-Id: do-thing", {
    staged: [],
    files: { "openspec/changes/archive/2026-04-20-do-thing/tasks.md": { index: "" } },
  });
  expectNot(findings, ["A6"]);
});

test("A6: non-conventional subject → warn", () => {
  const findings = runMsg("fixed stuff\n\nChange-Id: none", { staged: [], files: {} });
  const w = findings.find((f) => f.id === "A6" && f.severity === "warn");
  if (!w) throw new Error("expected A6 conventional-format warn");
});

test("B2: code staged after all tasks checked → scope-creep warn", () => {
  const findings = runMsg("feat: more\n\nChange-Id: do-thing", {
    staged: [mod("src/a.ts")],
    files: baseFiles("do-thing", {
      tasksIndex: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]),
      tasksHead: tasksMd([["1.1", "Do thing", true], ["1.2", "Ship it", true]]),
    }),
  });
  expectFires(findings, ["B2"]);
});

test("B2: code staged, tasks untouched, work remaining → info (non-blocking)", () => {
  const findings = runMsg("feat: partial\n\nChange-Id: do-thing", {
    staged: [mod("src/a.ts")],
    files: baseFiles(),
  });
  const b2 = findings.find((f) => f.id === "B2");
  if (!b2 || b2.severity !== "info") throw new Error("expected B2 info");
  if (findings.some((f) => f.severity === "error")) throw new Error("B2 info must not block");
});

// ---------------------------------------------------------------------------
// pre-push (B7 / B8 with fake history)
// ---------------------------------------------------------------------------

test("B7: stale active change → warn", () => {
  const now = 1_800_000_000;
  const c = createPrePushCtx({
    activeChanges: [{ name: "old", path: "openspec/changes/old", tasksPath: "openspec/changes/old/tasks.md" }],
    hist: { lastCommitEpoch: () => now - 30 * 86400, taskCheckEvents: () => [] },
    now,
    thresholds: DEFAULT_THRESHOLDS,
  });
  expectFires(runRules("pre-push", c, {}), ["B7"]);
});

test("B8: evidence rate below threshold → warn; healthy rate → info", () => {
  const events = [
    { sha: "a", checked: ["t1"], artifacts: ["src/a.ts"] },
    { sha: "b", checked: ["t2"], artifacts: [] },
    { sha: "c", checked: ["t3"], artifacts: [] },
  ];
  const mk = (ev) =>
    createPrePushCtx({
      activeChanges: [{ name: "do-thing", path: "openspec/changes/do-thing", tasksPath: "openspec/changes/do-thing/tasks.md" }],
      hist: { lastCommitEpoch: () => Math.floor(Date.now() / 1000), taskCheckEvents: () => ev },
    });
  expectFires(runRules("pre-push", mk(events), {}), ["B8"]);
  const healthy = runRules("pre-push", mk([{ sha: "a", checked: ["t1"], artifacts: ["src/a.ts"] }]), {});
  expectNot(healthy, ["B8"]);
});

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
