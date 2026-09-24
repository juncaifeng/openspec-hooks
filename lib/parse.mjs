// openspec-hooks-poc — parsers for OpenSpec artifacts (pure functions, no I/O)
// Parses: tasks.md (checkboxes), delta specs (ADDED/MODIFIED/REMOVED), proposal.md (Scope)

/** Normalized task text used to pair a task line across git revisions. */
export function normalizeTaskText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

const CHECKBOX = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;
const BULLET_BRACKET = /^\s*[-*]\s+\[/;

/** Parse tasks.md → { tasks: [{line, indent, done, id, text, norm}], issues: [{line, message}] } */
export function parseTasks(text) {
  const tasks = [];
  const issues = [];
  const seenIds = new Map();
  const lines = String(text ?? "").split(/\r?\n/);

  lines.forEach((line, i) => {
    const m = line.match(CHECKBOX);
    if (m) {
      const raw = m[3].trim();
      const idm = raw.match(/^(\d+(?:\.\d+)*)[.)]?\s+(.*)$/);
      const id = idm ? idm[1] : null;
      const body = idm ? idm[2].trim() : raw;
      if (id) {
        if (seenIds.has(id)) {
          issues.push({ line: i + 1, message: `duplicate task id "${id}" (first at line ${seenIds.get(id)})` });
        } else {
          seenIds.set(id, i + 1);
        }
      }
      tasks.push({
        line: i + 1,
        indent: m[1].length,
        done: m[2].toLowerCase() === "x",
        id,
        text: body,
        norm: normalizeTaskText(body),
      });
      return;
    }
    if (BULLET_BRACKET.test(line)) {
      issues.push({
        line: i + 1,
        message: `malformed checkbox (expected "- [ ] ..." or "- [x] ..."): "${line.trim()}"`,
      });
    }
  });

  return { tasks, issues };
}

/**
 * Diff two parsed tasks revisions (HEAD vs index).
 * Pairing is by normalized text — good enough for a PoC (rewording a task
 * counts as remove+add).
 */
export function taskTransitions(head, staged) {
  const headByNorm = new Map();
  for (const t of head?.tasks ?? []) if (!headByNorm.has(t.norm)) headByNorm.set(t.norm, t);
  const checked = []; // unchecked→checked, or newly added already checked
  const unchecked = []; // checked→unchecked (scope shrink / reopen)
  for (const t of staged?.tasks ?? []) {
    const h = headByNorm.get(t.norm);
    if (t.done && (!h || !h.done)) checked.push({ ...t, isNew: !h });
    if (!t.done && h && h.done) unchecked.push(t);
  }
  return { checked, unchecked };
}

// ---------------------------------------------------------------------------
// Delta specs:  "## ADDED Requirements" / "## MODIFIED Requirements" / ...
// ---------------------------------------------------------------------------

const SECTION = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/i;
const H2 = /^##\s+(.*)$/;
const REQUIREMENT = /^###\s+Requirement:\s*(.+?)\s*$/i;
const SCENARIO = /^####\s+Scenario:\s*(.+?)\s*$/i;
export const KNOWN_SECTIONS = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"];

/**
 * Parse a delta spec → {
 *   sections: { ADDED: [{name, scenarios, empty}], ... },
 *   issues: [{line, message, kind: "error"|"warn"}]
 * }
 */
export function parseDelta(text) {
  const sections = Object.fromEntries(KNOWN_SECTIONS.map((s) => [s, []]));
  const issues = [];
  const lines = String(text ?? "").split(/\r?\n/);

  let currentSection = null;
  let currentReq = null;
  let reqHasBody = false;
  const sectionSeen = new Set();

  const closeReq = () => {
    if (currentReq && !reqHasBody && currentReq.scenarios.length === 0) {
      issues.push({
        line: currentReq.line,
        message: `empty requirement "${currentReq.name}" (no text and no scenarios)`,
        kind: "error",
      });
      currentReq.empty = true;
    }
    currentReq = null;
    reqHasBody = false;
  };

  lines.forEach((line, i) => {
    const sec = line.match(SECTION);
    if (sec) {
      closeReq();
      currentSection = sec[1].toUpperCase();
      sectionSeen.add(currentSection);
      return;
    }
    const h2 = line.match(H2);
    if (h2) {
      closeReq();
      // A near-miss heading like "## ADDED Requirement" silently drops content
      // on archive — that is exactly the bug this rule exists to catch.
      if (/requirement/i.test(h2[1]) || /^(added|modified|removed|renamed)\b/i.test(h2[1])) {
        issues.push({
          line: i + 1,
          message: `unknown delta section heading "## ${h2[1].trim()}" (expected "## ADDED|MODIFIED|REMOVED|RENAMED Requirements")`,
          kind: "error",
        });
      }
      currentSection = null;
      return;
    }
    const req = line.match(REQUIREMENT);
    if (req) {
      closeReq();
      if (!currentSection) {
        issues.push({
          line: i + 1,
          message: `requirement "${req[1]}" is not under any "## <TYPE> Requirements" section`,
          kind: "error",
        });
      }
      currentReq = { name: req[1].trim(), line: i + 1, scenarios: [] };
      if (currentSection) sections[currentSection].push(currentReq);
      return;
    }
    const sc = line.match(SCENARIO);
    if (sc) {
      if (!currentReq) {
        issues.push({
          line: i + 1,
          message: `scenario "${sc[1]}" is not under any "### Requirement:" section`,
          kind: "error",
        });
      } else {
        currentReq.scenarios.push(sc[1].trim());
        reqHasBody = true;
      }
      return;
    }
    if (currentReq && line.trim() !== "") reqHasBody = true;
  });
  closeReq();

  for (const s of sectionSeen) {
    if (sections[s].length === 0) {
      issues.push({ line: 0, message: `section "## ${s} Requirements" has no requirements`, kind: "warn" });
    }
  }

  return { sections, issues };
}

/** proposal.md → Scope bullet items (used by the scope-creep heuristic). */
export function parseProposalScope(text) {
  const items = [];
  let inScope = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      inScope = /^scope\s*$/i.test(h2[1].trim());
      continue;
    }
    if (inScope) {
      const m = line.match(/^\s*[-*]\s+(.*)$/);
      if (m) items.push(m[1].trim());
    }
  }
  return items;
}

/** Task keywords ↔ requirement name matching (heuristic coverage check). */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "shall", "must", "should", "may",
  "system", "requirement", "user", "when", "then", "given", "allow", "support",
]);
export function requirementTokens(name) {
  return new Set(
    normalizeTaskText(name)
      .split(" ")
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
  );
}
export function requirementCovered(reqName, tasks) {
  const full = normalizeTaskText(reqName);
  const tokens = requirementTokens(reqName);
  for (const t of tasks) {
    if (full && t.norm.includes(full)) return true;
    if (tokens.size === 0) return true; // nothing distinctive to match — do not flag
    const taskTokens = new Set(t.norm.split(" "));
    let hit = 0;
    for (const tok of tokens) if (taskTokens.has(tok)) hit++;
    if (hit >= Math.min(2, tokens.size)) return true;
  }
  return false;
}

/** Fallback coverage: requirement name appears anywhere in raw tasks.md text
 *  (headings/grouping labels carry the mapping even when task lines don't). */
export function requirementCoveredInText(reqName, text) {
  const full = normalizeTaskText(reqName);
  const normText = normalizeTaskText(text);
  if (full && normText.includes(full)) return true;
  const tokens = requirementTokens(reqName);
  if (tokens.size === 0) return true;
  const textTokens = new Set(normText.split(" "));
  let hit = 0;
  for (const tok of tokens) if (textTokens.has(tok)) hit++;
  return hit >= Math.min(2, tokens.size);
}
