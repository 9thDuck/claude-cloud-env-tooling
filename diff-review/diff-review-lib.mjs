/**
 * Pure helpers for diff-review (diff-review.mjs).
 *
 * Config parsing, prompt building, strict verdict parsing and the
 * advisory/blocking decision live here so they can be tested as pure functions
 * (test/diff-review-lib.test.mjs). No file, process or network I/O in this
 * module: the CLI owns all of that.
 *
 * diff-review is a required gate, not acceptance: check-gates refuses a merge
 * without its PASS verdict on the PR head. A FAIL exits 0 unless
 * DIFF_REVIEW_BLOCKING=1 (blockingFromEnv); an ERROR exits 1 in both modes.
 */

/**
 * Largest diff (in characters) the reviewer is asked to read. The CLI writes
 * only this much to diff.patch and buildPrompt says so, so a reviewer never
 * believes it saw the whole change.
 */
export const MAX_DIFF_CHARS = 200000;

/** The per-repo config file, read from the merge-base commit. */
export const CONFIG_FILE = ".diff-review.json";

/** Review runs kept under <repo>/.diff-review/; older ones are pruned. */
export const KEEP_RUNS = 20;

/**
 * Which run directories to delete: everything but the newest `keep`.
 * Names start with a UTC timestamp, so a plain sort is oldest-first.
 * @param {string[]} names run directory names.
 * @param {number} keep how many to keep.
 * @returns {string[]} names to delete.
 */
export function runsToPrune(names, keep = KEEP_RUNS) {
  const sorted = [...names].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

/**
 * A repo-relative path that stays inside the repo.
 * @param {unknown} path
 * @returns {boolean}
 */
function isRepoPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..")
  );
}

/**
 * Parse .diff-review.json strictly; an unknown key or a bad value is an error,
 * never a silent default.
 * @param {string} text the file's contents.
 * @returns {{ ok: true, project: string | null, rules: string[], decided: string | null } | { ok: false, error: string }}
 */
export function parseConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `${CONFIG_FILE} is not valid JSON: ${error.message}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${CONFIG_FILE} must be a JSON object` };
  }
  const unknown = Object.keys(raw).filter((key) => !["project", "rules", "decided"].includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: `${CONFIG_FILE} has unknown key(s): ${unknown.join(", ")}` };
  }
  if (raw.project !== undefined && (typeof raw.project !== "string" || raw.project.trim() === "")) {
    return { ok: false, error: `${CONFIG_FILE} "project" must be a non-empty string` };
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0 || !raw.rules.every(isRepoPath)) {
    return {
      ok: false,
      error: `${CONFIG_FILE} "rules" must be a non-empty list of repo-relative file paths`,
    };
  }
  if (raw.decided !== undefined && !isRepoPath(raw.decided)) {
    return { ok: false, error: `${CONFIG_FILE} "decided" must be a repo-relative file path` };
  }
  return {
    ok: true,
    project: raw.project ?? null,
    rules: [...raw.rules],
    decided: raw.decided ?? null,
  };
}

/**
 * Where the reviewer finds its copy of each rule file. Numbered, so two rule
 * files with the same name never overwrite each other.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function ruleCopies(paths) {
  return paths.map((path, index) => `./rules/${index + 1}-${path.split("/").pop()}`);
}

/** Where the reviewer finds its copy of the decided-items file. */
export const DECIDED_COPY = "./decided.md";

/**
 * The task the reviewer is given.
 * @param {{ diff: string, base: string, rules: string[], decided?: boolean, project?: string | null }} options
 *   `diff` is the full diff; over MAX_DIFF_CHARS only its head is written to ./diff.patch, and the prompt says so.
 *   `rules` are the rule file paths (as in the config). `decided` is true when a decided-items file was copied.
 * @returns {string} the prompt for the worker.
 */
export function buildPrompt({ diff, base, rules, decided = false, project = null }) {
  const length = typeof diff === "string" ? diff.length : 0;
  const truncated = length > MAX_DIFF_CHARS;
  const diffLine = truncated
    ? `The change under review is a unified diff in ./diff.patch in your working directory. That file holds only the first ${MAX_DIFF_CHARS} of ${length} characters of the diff, so the rest is cut; judge what is there and name what you could not see under "untested".`
    : `The change under review is a unified diff in ./diff.patch in your working directory (${length} characters, complete).`;
  return [
    "You are an independent, adversarial code reviewer.",
    ...(project ? [`The project: ${project}`] : []),
    "Assume the diff is wrong until it proves otherwise. Find what would break, mislead or embarrass the team that ships it; do not praise.",
    "",
    `Base ref: ${base}. Judge the diff as the change a pull request would land.`,
    diffLine,
    "",
    "Read these rule files yourself before judging; do not rely on memory or on this prompt:",
    ...ruleCopies(rules).map((copy) => `- ${copy}`),
    ...(decided
      ? [
          `- ${DECIDED_COPY} lists items the team already decided and tracked; do not raise them.`,
        ]
      : []),
    "These files are the rules as they stand on the base branch, not as the diff would change them.",
    "",
    "Rules:",
    "- FAIL when any finding breaks a rule in the rule files.",
    "- PASS only with zero findings.",
    `- Every finding must carry \`rule\`: a short quote of the rule text it violates, copied from one of the rule files${decided ? ` (not ${DECIDED_COPY})` : ""}, with that file's name. A finding without a quoted rule is not a finding.`,
    "- Style nits are not findings unless a rule file states the rule. Do not invent rules.",
    "- List anything you could not check (unread code, truncated diff, a claim you cannot verify) under `untested`; an empty list is allowed only when you checked everything.",
    "",
    "When you are done, write your verdict to ./verdict.json in your working directory, exactly this shape and nothing else:",
    '{"verdict":"PASS"|"FAIL","findings":[{"file":"<repo-relative path>","line":<number or null>,"rule":"<quoted rule>","why":"<what the diff does and which rule it breaks>"}],"untested":["<what you could not check>"]}',
    "Write no other file, print nothing to stdout, and stop. Do not modify the repository.",
  ].join("\n");
}

/**
 * Parse a reviewer's verdict.json strictly.
 *
 * Anything ambiguous is a failure, never a pass: a malformed answer must not
 * read as PASS.
 * @param {string} text the file's contents.
 * @returns {{ ok: true, verdict: "PASS" | "FAIL", findings: Array<{ file: string, line: number | null, rule: string, why: string }>, untested: string[] } | { ok: false, error: string }}
 */
export function parseVerdict(text) {
  if (typeof text !== "string") return { ok: false, error: "verdict.json is not text" };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `verdict.json is not valid JSON: ${error.message}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "verdict.json must be a JSON object" };
  }
  if (raw.verdict !== "PASS" && raw.verdict !== "FAIL") {
    return {
      ok: false,
      error: `verdict must be "PASS" or "FAIL", got ${JSON.stringify(raw.verdict)}`,
    };
  }
  if (raw.findings === undefined) return { ok: false, error: "findings is missing" };
  if (!Array.isArray(raw.findings)) return { ok: false, error: "findings must be an array" };
  if (raw.untested === undefined) return { ok: false, error: "untested is missing" };
  if (!Array.isArray(raw.untested)) return { ok: false, error: "untested must be an array" };
  if (raw.verdict === "FAIL" && raw.findings.length === 0) {
    return { ok: false, error: "FAIL requires at least one finding" };
  }
  if (raw.verdict === "PASS" && raw.findings.length > 0) {
    return { ok: false, error: `PASS requires zero findings, got ${raw.findings.length}` };
  }
  const findings = [];
  for (const [index, finding] of raw.findings.entries()) {
    const at = `findings[${index}]`;
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      return { ok: false, error: `${at} must be an object` };
    }
    if (typeof finding.file !== "string" || finding.file.length === 0) {
      return { ok: false, error: `${at}.file must be a non-empty string` };
    }
    if (finding.line !== null && !Number.isFinite(finding.line)) {
      return { ok: false, error: `${at}.line must be a number or null` };
    }
    if (typeof finding.rule !== "string" || finding.rule.trim().length === 0) {
      return { ok: false, error: `${at}.rule must be a non-empty string quoting the rule` };
    }
    if (typeof finding.why !== "string" || finding.why.trim().length === 0) {
      return { ok: false, error: `${at}.why must be a non-empty string` };
    }
    findings.push({ file: finding.file, line: finding.line, rule: finding.rule, why: finding.why });
  }
  for (const [index, entry] of raw.untested.entries()) {
    if (typeof entry !== "string")
      return { ok: false, error: `untested[${index}] must be a string` };
  }
  return { ok: true, verdict: raw.verdict, findings, untested: [...raw.untested] };
}

/**
 * Files a unified diff touches, counted by its `diff --git` headers.
 * @param {string} diff
 * @returns {number}
 */
export function diffFileCount(diff) {
  return (diff.match(/^diff --git /gm) ?? []).length;
}

/**
 * The fixed header check-gates reads (check-gates/check-gates-lib.mjs).
 * Coverage counts only files whose whole patch reached the reviewer.
 * @param {{ decision: { line: string }, head: string, diff: string, refused: number | null }} options
 *   `refused` is null when the worker's refusal count could not be read.
 * @returns {string[]}
 */
export function gateHeader({ decision, head, diff, refused }) {
  const status = /^diff-review: (PASS|FAIL|ERROR)/.exec(decision.line)?.[1] ?? "ERROR";
  const total = diffFileCount(diff);
  const seen = diff.length > MAX_DIFF_CHARS ? Math.max(0, diffFileCount(diff.slice(0, MAX_DIFF_CHARS)) - 1) : total;
  return [
    "Gate: diff-review",
    `Head: ${head}`,
    `Status: ${status}`,
    `Coverage: ${seen}/${total}`,
    "Runner: eco-worker",
    `Refused calls: ${refused === null ? "unknown" : refused}`,
  ];
}

/**
 * The review's one human line and exit code.
 *
 * Blocking is the single switch for a reviewer FAIL. ERROR (the review never
 * ran or gave no valid verdict) exits 1 in both modes, so a broken review never
 * looks green; a clean PASS, or an advisory FAIL, exits 0. A PASS on a
 * truncated diff is an ERROR in both modes: the reviewer never saw all of it.
 * @param {{ parsed: ReturnType<typeof parseVerdict>, blocking?: boolean, truncated?: boolean }} options
 * @returns {{ exitCode: 0 | 1, line: string }}
 */
export function decide({ parsed, blocking, truncated = false }) {
  const mode = "required gate, not acceptance";
  if (parsed.ok === true && parsed.verdict === "PASS" && truncated === true) {
    return {
      exitCode: 1,
      line: `diff-review: ERROR (${mode}) the diff was cut at ${MAX_DIFF_CHARS} characters, so a PASS cannot stand; split the change into smaller pieces`,
    };
  }
  if (parsed.ok === false) {
    return {
      exitCode: 1,
      line: `diff-review: ERROR (${mode}) ${parsed.error}`,
    };
  }
  if (parsed.verdict === "FAIL") {
    const count = parsed.findings.length;
    const untested = parsed.untested.length;
    return {
      exitCode: blocking === true ? 1 : 0,
      line: `diff-review: FAIL (${mode}) ${count} finding${count === 1 ? "" : "s"}${untested > 0 ? `, ${untested} untested` : ""}`,
    };
  }
  const untested = parsed.untested.length;
  return {
    exitCode: 0,
    line: `diff-review: PASS (${mode}) 0 findings${untested > 0 ? `, ${untested} untested` : ""}`,
  };
}

/**
 * Advisory is the default; DIFF_REVIEW_BLOCKING=1 makes a FAIL exit 1.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function blockingFromEnv(env = process.env) {
  return env.DIFF_REVIEW_BLOCKING === "1";
}
