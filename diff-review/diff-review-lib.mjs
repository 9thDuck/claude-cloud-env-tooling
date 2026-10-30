/**
 * Pure helpers for diff-review (diff-review.mjs).
 *
 * Config parsing, prompt building, strict verdict parsing and the
 * advisory/blocking decision live here so they can be tested as pure functions
 * (test/diff-review-lib.test.mjs). No file, process or network I/O in this
 * module: the CLI owns all of that.
 *
 * Advisory by default: a FAIL is printed and exits 0. DIFF_REVIEW_BLOCKING=1
 * makes a FAIL exit 1 (blockingFromEnv). An ERROR exits 1 in both modes.
 * The review is a second reader, never acceptance.
 */

/**
 * Largest diff (in characters) this tool was originally willing to hand over in
 * one piece. Review chunking uses DIFF_REVIEW_CHUNK_CHARS instead; this remains
 * the ceiling named in decide()'s truncated-diff message. Nothing is truncated.
 */
export const MAX_DIFF_CHARS = 200000;

/**
 * Target chunk size (in characters) for one reviewer run. It is deliberately
 * smaller than MAX_DIFF_CHARS: the reviewer reads the repository to verify the
 * diff, so its run time grows with the chunk it is given. A bigger diff is split
 * by file (and a bigger file by hunk) so every file is reviewed; see splitDiff.
 */
export const DIFF_REVIEW_CHUNK_CHARS = 60000;

/** Worker timeout: a base plus a step for every WORKER_TIMEOUT_STEP_CHARS. */
export const WORKER_TIMEOUT_BASE_SECONDS = 600;
export const WORKER_TIMEOUT_STEP_SECONDS = 600;
export const WORKER_TIMEOUT_STEP_CHARS = 50000;
export const WORKER_TIMEOUT_MAX_SECONDS = 3600;

/**
 * Seconds to give the worker for a chunk of `chars` characters: 600s base plus
 * 600s per started 50,000 characters, capped at 3600s. A larger chunk is read
 * with more of the repository, so a fixed timeout would cut it off. An explicit
 * DIFF_REVIEW_TIMEOUT_SECONDS (a positive integer) wins over both the formula
 * and the cap.
 * @param {number} chars chunk size in characters.
 * @param {Record<string, string | undefined>} env
 * @returns {number} timeout in seconds.
 */
export function workerTimeoutSeconds(chars, env = process.env) {
  const override = env.DIFF_REVIEW_TIMEOUT_SECONDS;
  if (typeof override === "string" && /^[1-9]\d*$/.test(override)) return Number(override);
  const size = Number.isFinite(chars) && chars > 0 ? chars : 0;
  const steps = Math.ceil(size / WORKER_TIMEOUT_STEP_CHARS);
  return Math.min(
    WORKER_TIMEOUT_MAX_SECONDS,
    WORKER_TIMEOUT_BASE_SECONDS + steps * WORKER_TIMEOUT_STEP_SECONDS,
  );
}

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

/** Directory prefixes whose files a reviewer should see first. */
const FIRST_PREFIXES = ["src/", "e2e/", "scripts/", "config/", "test/", "tests/", "__tests__/"];

/** Directory prefixes whose files a reviewer should see last. */
const LAST_PREFIXES = ["docs/", ".beads/"];

/**
 * Review order for a file: source and tests first (0), docs and beads last (2),
 * everything else between (1).
 * @param {string} path repo-relative path.
 * @returns {0 | 1 | 2}
 */
export function fileRank(path) {
  const normalized = String(path).replace(/^\.\//, "");
  if (LAST_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 2;
  if (FIRST_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return 0;
  if (/(^|\/)(__tests__|test|tests|e2e|spec)\//.test(normalized)) return 0;
  if (/\.(test|spec)\.[^/]+$/.test(normalized)) return 0;
  return 1;
}

/**
 * A git path from a header, removing the a/ or b/ prefix and quotes.
 * @param {string} value e.g. `b/src/a.js` or `"a/file with space.js"`.
 * @returns {string}
 */
function unquotePath(value) {
  let path = value;
  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      path = JSON.parse(path);
    } catch {
      path = path.slice(1, -1);
    }
  }
  return path.replace(/^[ab]\//, "");
}

/**
 * The target path from a `diff --git a/<old> b/<new>` header. Null when the
 * line cannot be parsed.
 * @param {string} line
 * @returns {string | null}
 */
function pathFromGitHeader(line) {
  const rest = line.slice("diff --git ".length);
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted !== null) return unquotePath(quoted[2]);
  const at = rest.indexOf(" b/");
  return at > 0 ? unquotePath(rest.slice(at + 1)) : null;
}

/**
 * The path a file section describes: the `+++` line (or `---` for a deletion),
 * else the `diff --git` header. Null when the section names no file.
 * @param {string} text one file section.
 * @returns {string | null}
 */
function sectionPath(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const value = unquotePath(line.slice(4).split("\t")[0]);
      if (value !== "/dev/null") return value;
    }
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) {
      const value = unquotePath(line.slice(4).split("\t")[0]);
      if (value !== "/dev/null") return value;
    }
  }
  const header = text.split("\n").find((line) => line.startsWith("diff --git "));
  return header === undefined ? null : pathFromGitHeader(header);
}

/**
 * Split a unified diff into per-file sections, preserving every byte.
 * Sections start at `diff --git`; a plain `diff -u` header without it is also
 * recognised. Hunks are tracked so a removed line that looks like a header is
 * never mistaken for one.
 * @param {string} diff
 * @returns {Array<{ path: string | null, text: string }>}
 */
export function splitFileSections(diff) {
  if (typeof diff !== "string" || diff.length === 0) return [];
  const lines = diff.split("\n");
  const sections = [];
  let current = null;
  let inHunk = false;
  const start = (line) => {
    current = { lines: line === null ? [] : [line] };
    sections.push(current);
    inHunk = false;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      start(line);
      continue;
    }
    if (!inHunk && line.startsWith("--- ") && /^\+\+\+ /.test(lines[index + 1] ?? "")) {
      const ownHeader = current !== null && current.lines.some((entry) => entry.startsWith("+++ "));
      if (current === null || ownHeader) {
        start(line);
        continue;
      }
    }
    if (current === null) start(null);
    current.lines.push(line);
    if (line.startsWith("@@ ")) inHunk = true;
  }
  return sections.map((section) => {
    const text = section.lines.join("\n");
    return { path: sectionPath(text), text };
  });
}

/**
 * Every file the diff names, in first-seen order. This reads `diff --git`
 * headers itself, independently of splitFileSections, so a splitter bug shows
 * up as a coverage ERROR instead of hiding. A plain `diff -u` patch with no
 * such headers falls back to the section parser.
 * @param {string} diff
 * @returns {string[]}
 */
export function filesInDiff(diff) {
  if (typeof diff !== "string" || diff.length === 0) return [];
  const fromHeaders = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const path = pathFromGitHeader(line);
    if (path !== null && !fromHeaders.includes(path)) fromHeaders.push(path);
  }
  if (fromHeaders.length > 0) return fromHeaders;
  const seen = new Set();
  for (const section of splitFileSections(diff)) {
    if (section.path !== null) seen.add(section.path);
  }
  return [...seen];
}

/**
 * Split one oversized file section by hunk, repeating the file header in every
 * piece so each piece is a valid standalone diff. A single hunk bigger than the
 * limit is kept whole and marked oversize: cutting lines out of a hunk would
 * silently drop context.
 * @param {{ path: string | null, text: string }} section
 * @param {number} maxChars
 * @returns {Array<{ text: string, files: string[], oversize: boolean }>}
 */
function splitSectionByHunks(section, maxChars) {
  const lines = section.text.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk === -1) {
    return [
      {
        text: section.text,
        files: section.path === null ? [] : [section.path],
        oversize: section.text.length > maxChars,
      },
    ];
  }
  const header = lines.slice(0, firstHunk).join("\n");
  const hunks = [];
  let current = [];
  for (const line of lines.slice(firstHunk)) {
    if (line.startsWith("@@ ") && current.length > 0) {
      hunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) hunks.push(current.join("\n"));
  const pieces = [];
  let body = "";
  for (const hunk of hunks) {
    const candidate = body === "" ? hunk : `${body}\n${hunk}`;
    if (body !== "" && `${header}\n${candidate}`.length > maxChars) {
      pieces.push(`${header}\n${body}`);
      body = hunk;
    } else {
      body = candidate;
    }
  }
  if (body !== "") pieces.push(`${header}\n${body}`);
  return pieces.map((text) => ({
    text,
    files: section.path === null ? [] : [section.path],
    oversize: text.length > maxChars,
  }));
}

/**
 * Split a diff into reviewable chunks, ordered source/tests first and docs and
 * .beads last. Whole files are packed under `maxChars` (default
 * DIFF_REVIEW_CHUNK_CHARS); a file bigger than that is split by hunk. Every file
 * appears in at least one chunk.
 * @param {string} diff
 * @param {{ maxChars?: number }} [options]
 * @returns {{ chunks: Array<{ text: string, files: string[], oversize: boolean }>, files: string[] }}
 */
export function splitDiff(diff, { maxChars = DIFF_REVIEW_CHUNK_CHARS } = {}) {
  if (!Number.isInteger(maxChars) || maxChars <= 0)
    throw new Error("maxChars must be a positive integer");
  const sections = splitFileSections(diff)
    .map((section, order) => ({
      ...section,
      order,
      rank: section.path === null ? 1 : fileRank(section.path),
    }))
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      const leftPath = left.path ?? "";
      const rightPath = right.path ?? "";
      if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
      return left.order - right.order;
    });
  const chunks = [];
  let text = "";
  let files = [];
  const flush = () => {
    if (text === "") return;
    chunks.push({ text, files: [...new Set(files)], oversize: text.length > maxChars });
    text = "";
    files = [];
  };
  for (const section of sections) {
    const sectionFiles = section.path === null ? [] : [section.path];
    const joined = text === "" ? section.text : `${text}\n${section.text}`;
    if (joined.length <= maxChars) {
      text = joined;
      files.push(...sectionFiles);
      continue;
    }
    flush();
    if (section.text.length <= maxChars) {
      text = section.text;
      files = [...sectionFiles];
      continue;
    }
    for (const piece of splitSectionByHunks(section, maxChars)) {
      flush();
      chunks.push({ text: piece.text, files: [...new Set(piece.files)], oversize: piece.oversize });
    }
  }
  flush();
  return { chunks, files: filesInDiff(diff) };
}

/**
 * Why the chunks do not cover every file in the diff. Empty means complete;
 * anything else must fail the run as ERROR, never a quiet PASS.
 * @param {string} diff
 * @param {Array<{ files: string[] }>} chunks
 * @returns {string[]}
 */
export function coverageProblems(diff, chunks) {
  const expected = filesInDiff(diff);
  const covered = chunks.flatMap((chunk) => chunk.files ?? []);
  const problems = [];
  if (diff.trim().length > 0 && expected.length === 0)
    problems.push("the diff has no recognizable file headers, so file coverage cannot be verified");
  for (const file of expected)
    if (!covered.includes(file)) problems.push(`file ${file} is in the diff but no chunk covers it`);
  for (const file of new Set(covered))
    if (!expected.includes(file)) problems.push(`a chunk covers ${file}, which is not a file in the diff`);
  return problems;
}

/**
 * Merge per-chunk verdicts: any chunk ERROR makes the whole review an ERROR;
 * otherwise any FAIL makes it FAIL; otherwise PASS. Findings and untested items
 * are kept, with the chunk number on each untested entry.
 * @param {Array<{ index: number, parsed: ReturnType<typeof parseVerdict> }>} results
 * @returns {{ ok: true, verdict: "PASS" | "FAIL", findings: Array<object>, untested: string[] } | { ok: false, error: string }}
 */
export function mergeVerdicts(results) {
  if (!Array.isArray(results) || results.length === 0)
    return { ok: false, error: "no chunk verdicts to merge" };
  const findings = [];
  const untested = [];
  let fail = false;
  for (const { index, parsed } of results) {
    if (parsed.ok === false) return { ok: false, error: `chunk ${index}: ${parsed.error}` };
    findings.push(...parsed.findings);
    untested.push(...parsed.untested.map((entry) => `chunk ${index}: ${entry}`));
    if (parsed.verdict === "FAIL") fail = true;
  }
  return { ok: true, verdict: fail ? "FAIL" : "PASS", findings, untested };
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
 * @param {{ base: string, rules?: string[], decided?: boolean, project?: string | null, chunk?: { text: string, files: string[] }, chunkIndex?: number, chunkCount?: number, diffPath?: string, verdictPath?: string, rulePaths?: string[], decidedPath?: string | null, workdir?: string }} options
 *   `chunk` is this run's complete patch; `diffPath`, `verdictPath` and
 *   `rulePaths` are absolute paths (the worker's cwd is the repository root, not
 *   the run directory). `rules` names the rule files when `rulePaths` is absent.
 * @returns {string} the prompt for the worker.
 */
export function buildPrompt({
  base,
  rules = [],
  decided = false,
  project = null,
  chunk = { text: "", files: [] },
  chunkIndex = 1,
  chunkCount = 1,
  diffPath = "./diff.patch",
  verdictPath = "./verdict.json",
  rulePaths = null,
  decidedPath = null,
  workdir = "the repository root",
}) {
  const text = typeof chunk.text === "string" ? chunk.text : "";
  const files = Array.isArray(chunk.files) ? chunk.files : [];
  const copies = rulePaths ?? ruleCopies(rules);
  const chunkLine =
    chunkCount > 1
      ? `The change under review is chunk ${chunkIndex} of ${chunkCount} of a unified diff, in ${diffPath} (${text.length} characters, complete for this chunk). Other chunks are reviewed separately.`
      : `The change under review is a unified diff in ${diffPath} (${text.length} characters, complete).`;
  return [
    "You are an independent, adversarial code reviewer.",
    ...(project ? [`The project: ${project}`] : []),
    "Assume the diff is wrong until it proves otherwise. Find what would break, mislead or embarrass the team that ships it; do not praise.",
    "",
    `Base ref: ${base}. Judge the diff as the change a pull request would land.`,
    chunkLine,
    ...(files.length > 0
      ? ["This chunk covers these files:", ...files.map((file) => `- ${file}`)]
      : ["This chunk holds no file body."]),
    "",
    `Your working directory is ${workdir}, the repository root. Read the repository with Read, Grep, Glob and git show/log/diff/blame/rev-parse/ls-files; that is where you verify what the diff claims. Treat the repository as read-only: do not edit, create or delete anything in it. The only files you may write are ${verdictPath} and the progress file named in your WORKER RULES.`,
    "",
    "Read these rule files yourself before judging; do not rely on memory or on this prompt:",
    ...copies.map((copy) => `- ${copy}`),
    ...(decided
      ? [
          `- ${decidedPath ?? DECIDED_COPY} lists items the team already decided and tracked; do not raise them.`,
        ]
      : []),
    "These files are the rules as they stand on the base branch, not as the diff would change them.",
    "",
    "Rules:",
    "- FAIL when any finding breaks a rule in the rule files.",
    "- PASS only with zero findings.",
    `- Every finding must carry \`rule\`: a short quote of the rule text it violates, copied from one of the rule files${decided ? " (not the decided-items file)" : ""}, with that file's name. A finding without a quoted rule is not a finding.`,
    "- Style nits are not findings unless a rule file states the rule. Do not invent rules.",
    "- List anything you could not check (unread code, a claim you cannot verify) under `untested`; an empty list is allowed only when you checked everything.",
    "",
    `When you are done, write your verdict to ${verdictPath}, exactly this shape and nothing else:`,
    '{"verdict":"PASS"|"FAIL","findings":[{"file":"<repo-relative path>","line":<number or null>,"rule":"<quoted rule>","why":"<what the diff does and which rule it breaks>"}],"untested":["<what you could not check>"]}',
    "Write no other file except the progress file named in your WORKER RULES, print nothing to stdout, and stop. Do not modify the repository.",
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
  const mode = blocking === true ? "blocking" : "advisory";
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
      line: `diff-review: FAIL (${mode}) ${count} finding${count === 1 ? "" : "s"}${untested > 0 ? `, ${untested} untested` : ""} — second reader, never acceptance`,
    };
  }
  const untested = parsed.untested.length;
  return {
    exitCode: 0,
    line: `diff-review: PASS (${mode}) 0 findings${untested > 0 ? `, ${untested} untested` : ""} — second reader, never acceptance`,
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
