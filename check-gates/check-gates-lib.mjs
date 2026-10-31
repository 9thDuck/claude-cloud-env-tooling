/**
 * Pure helpers for check-gates (check-gates.mjs).
 *
 * A PR may merge only when every gate it needs left a verdict file that names
 * the PR head and reads PASS. This module parses verdict files and judges them;
 * the CLI owns all file and git I/O (test/check-gates-lib.test.mjs).
 *
 * A verdict file is Markdown whose first lines are a fixed header:
 *
 *   Gate: diff-review
 *   Head: <40-char sha>
 *   Status: PASS
 *   Coverage: 12/12          (files reviewed / files in the diff; diff-review only)
 *   Runner: eco-worker
 *   Refused calls: 0         (diff-review only)
 *   Rounds: 1                (optional; review rounds so far)
 */

/** Paths that alone make a PR small: beads, docs and Markdown. */
const SMALL_PATH = /^(\.beads\/|docs\/)|\.md$/;

/** Gates each PR class needs (project rules B6, B7). */
export const REQUIRED_GATES = {
  small: ["diff-review", "sanity-review"],
  big: ["diff-review", "blind-review", "acceptance", "process-audit"],
};

/** Header keys every verdict file must carry. */
const HEADER_KEYS = ["Gate", "Head", "Status", "Runner"];

/** Text a lead leaves for later; a verdict holding it was never finished. */
const PLACEHOLDER = /<fill[^>]*>|\bTBD\b|\bTODO\b/i;

/** A cited bead: "bead astro_template-74yi3" or "bead: 6c3bv". */
const BEAD_ID = /\bbead:?\s+[A-Za-z0-9_.-]+/i;

/** At most this many review rounds (B6). */
export const MAX_ROUNDS = 2;

/**
 * The PR class, computed from the changed paths, never chosen by the builder.
 * @param {string[]} paths repo-relative changed paths.
 * @returns {"small" | "big"}
 */
export function prClass(paths) {
  return paths.length > 0 && paths.every((path) => SMALL_PATH.test(path)) ? "small" : "big";
}

/**
 * Read the fixed header: `Key: value` lines before the first blank line.
 * @param {string} text the verdict file.
 * @returns {Record<string, string>}
 */
export function parseHeader(text) {
  /** @type {Record<string, string>} */
  const header = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") break;
    const match = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/.exec(line);
    if (match === null) break;
    header[match[1] ?? ""] = (match[2] ?? "").trim();
  }
  return header;
}

/**
 * The body of a `## <name>` section, up to the next `## ` heading.
 * @param {string} text
 * @param {string} name
 * @returns {string | null} null when there is no such heading.
 */
function section(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name.toLowerCase()}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * Every problem with one verdict file, each its own message.
 * @param {{ name: string, text: string, head: string, changedFiles: number }} options
 *   `name` is the file name for messages; `changedFiles` the files in the PR diff.
 * @returns {string[]} empty when the file stands.
 */
export function verdictProblems({ name, text, head, changedFiles }) {
  const header = parseHeader(text);
  const gate = header.Gate ?? name;
  const problems = [];
  const missing = HEADER_KEYS.filter((key) => !header[key]);
  if (missing.length > 0) problems.push(`${gate} (${name}): header lacks ${missing.join(", ")}`);
  if (PLACEHOLDER.test(text)) problems.push(`${gate} (${name}): placeholder text left in the file`);
  if (header.Status && header.Status !== "PASS")
    problems.push(`${gate} (${name}): Status is ${header.Status}, not PASS`);
  if (header.Head && header.Head !== head)
    problems.push(`${gate} (${name}): Head ${header.Head} is not the PR head ${head} (stale verdict)`);
  if (/^## .*\bERROR\b/m.test(text) || /\bERROR chunk\b/i.test(text))
    problems.push(`${gate} (${name}): an ERROR chunk is recorded`);

  if (gate === "diff-review") {
    const coverage = /^(\d+)\/(\d+)$/.exec(header.Coverage ?? "");
    if (coverage === null) problems.push(`${gate} (${name}): Coverage missing or not <reviewed>/<total>`);
    else {
      const reviewed = Number(coverage[1]);
      const total = Number(coverage[2]);
      if (reviewed < total || total !== changedFiles)
        problems.push(
          `${gate} (${name}): Coverage ${reviewed}/${total} does not cover all ${changedFiles} changed files`,
        );
    }
    const refused = header["Refused calls"];
    if (refused === undefined || !/^\d+$/.test(refused))
      problems.push(`${gate} (${name}): Refused calls missing`);
    else if (Number(refused) > 0) problems.push(`${gate} (${name}): ${refused} refused call(s)`);
  }

  if (gate === "acceptance") {
    const body = section(text, "Acceptance");
    if (body === null || body === "") problems.push(`${gate} (${name}): no Acceptance section`);
  }

  const rounds = header.Rounds;
  if (rounds !== undefined && (!/^\d+$/.test(rounds) || Number(rounds) > MAX_ROUNDS))
    problems.push(`${gate} (${name}): Rounds ${rounds} is more than ${MAX_ROUNDS}`);

  for (const line of text.split("\n")) {
    if (!/pre-existing/i.test(line)) continue;
    if (!BEAD_ID.test(line) || !/\S+\.(md|txt|log|json)\b/.test(line))
      problems.push(`${gate} (${name}): "pre-existing" without a bead id and a main-run file: ${line.trim()}`);
  }
  return problems;
}

/**
 * Judge a PR's verdict files against the gates its class needs.
 * @param {{ files: Array<{ name: string, text: string }>, head: string, changed: string[], require?: string[] }} options
 *   `require` adds gates the scenario author named (B3).
 * @returns {{ ok: boolean, prClass: "small" | "big", gates: string[], problems: string[] }}
 */
export function checkGates({ files, head, changed, require = [] }) {
  const cls = prClass(changed);
  const gates = [...new Set([...REQUIRED_GATES[cls], ...require])];
  const problems = [];
  const byGate = new Map();
  for (const file of files) {
    const gate = parseHeader(file.text).Gate;
    if (gate) byGate.set(gate, [...(byGate.get(gate) ?? []), file]);
    else problems.push(`${file.name}: no Gate header`);
  }
  for (const gate of gates) {
    if (!byGate.has(gate)) problems.push(`${gate}: verdict file missing`);
  }
  for (const file of files) {
    problems.push(...verdictProblems({ ...file, head, changedFiles: changed.length }));
  }
  return { ok: problems.length === 0, prClass: cls, gates, problems };
}
