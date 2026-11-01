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
 * Target chunk size (in characters) for one reviewer run. It is deliberately
 * small: the reviewer reads the repository to verify the diff, so its turns and
 * run time grow with the chunk it is given (a 52K chunk needed more than 40
 * turns). A bigger diff is split by file (and a bigger file by hunk) so every
 * file is reviewed; see splitDiff. Override with DIFF_REVIEW_CHUNK_CHARS.
 */
export const DIFF_REVIEW_CHUNK_CHARS = 20000;

/**
 * The smallest chunk DIFF_REVIEW_CHUNK_CHARS may ask for. Below it every file
 * becomes its own worker run (DIFF_REVIEW_CHUNK_CHARS=1 would start one per
 * hunk), which multiplies the quota spend for no extra coverage.
 */
export const DIFF_REVIEW_CHUNK_CHARS_MIN = 5000;

/**
 * The chunk size: DIFF_REVIEW_CHUNK_CHARS when it is valid (see
 * chunkCharsError), else 20000. An unset or empty value gets the 20000
 * default; any other value is either a valid integer of at least
 * DIFF_REVIEW_CHUNK_CHARS_MIN, or chunkCharsError rejects it before any worker
 * runs.
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function chunkCharsFromEnv(env = process.env) {
  if (chunkCharsError(env) !== null) return DIFF_REVIEW_CHUNK_CHARS;
  const raw = env.DIFF_REVIEW_CHUNK_CHARS;
  return typeof raw === "string" && raw !== "" ? Number(raw) : DIFF_REVIEW_CHUNK_CHARS;
}

/**
 * Why DIFF_REVIEW_CHUNK_CHARS cannot be used, or null when it is unset or valid.
 * A set value must be an integer of at least DIFF_REVIEW_CHUNK_CHARS_MIN.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function chunkCharsError(env = process.env) {
  const raw = env.DIFF_REVIEW_CHUNK_CHARS;
  if (raw === undefined || raw === "") return null;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) < DIFF_REVIEW_CHUNK_CHARS_MIN)
    return `DIFF_REVIEW_CHUNK_CHARS=${raw} is not an integer of at least ${DIFF_REVIEW_CHUNK_CHARS_MIN}; unset it for the ${DIFF_REVIEW_CHUNK_CHARS} default`;
  return null;
}

/** Worker timeout: a base plus a step for every WORKER_TIMEOUT_STEP_CHARS. */
export const WORKER_TIMEOUT_BASE_SECONDS = 600;
export const WORKER_TIMEOUT_STEP_SECONDS = 600;
export const WORKER_TIMEOUT_STEP_CHARS = 50000;
export const WORKER_TIMEOUT_MAX_SECONDS = 3600;

/**
 * Seconds per turn of the turn cap in the turn term of workerTimeoutSeconds.
 * The timeout is max(size formula, min(WORKER_TIMEOUT_TURN_MAX_SECONDS,
 * maxTurns * this)), or DIFF_REVIEW_TIMEOUT_SECONDS when that is set. The
 * timeout can fire before the turn cap is reached.
 */
export const WORKER_TIMEOUT_SECONDS_PER_TURN = 30;
/** The turn-derived timeout never exceeds this, whatever DIFF_REVIEW_MAX_TURNS says. */
export const WORKER_TIMEOUT_TURN_MAX_SECONDS = 7200;

/**
 * Seconds to give the worker for a chunk of `chars` characters: the larger of
 * the size formula (600s base plus 600s per started 50,000 characters, capped
 * at 3600s) and 30s for every turn of the chunk's turn cap (capped at 7200s).
 * The turn term makes the timeout grow with the turn cap. A timeout is not
 * retried, so a run that times out spends quota and gives no verdict. An
 * explicit DIFF_REVIEW_TIMEOUT_SECONDS (a positive integer) wins over both.
 * @param {number} chars chunk size in characters.
 * @param {Record<string, string | undefined>} env
 * @param {number} maxTurns the chunk's turn cap (maxTurnsFor).
 * @returns {number} timeout in seconds.
 */
export function workerTimeoutSeconds(chars, env = process.env, maxTurns = maxTurnsFor(chars, env)) {
  const override = env.DIFF_REVIEW_TIMEOUT_SECONDS;
  if (typeof override === "string" && /^[1-9]\d*$/.test(override)) return Number(override);
  const size = Number.isFinite(chars) && chars > 0 ? chars : 0;
  const steps = Math.ceil(size / WORKER_TIMEOUT_STEP_CHARS);
  const bySize = Math.min(
    WORKER_TIMEOUT_MAX_SECONDS,
    WORKER_TIMEOUT_BASE_SECONDS + steps * WORKER_TIMEOUT_STEP_SECONDS,
  );
  const byTurns = Math.min(WORKER_TIMEOUT_TURN_MAX_SECONDS, maxTurns * WORKER_TIMEOUT_SECONDS_PER_TURN);
  return Math.max(bySize, byTurns);
}

/** Chunk workers in flight when DIFF_REVIEW_CONCURRENCY is not set. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * How many chunk workers may run at once. An integer DIFF_REVIEW_CONCURRENCY
 * wins, clamped to at least 1; anything that is not a number falls back to the
 * default.
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function concurrencyFromEnv(env = process.env) {
  const raw = env.DIFF_REVIEW_CONCURRENCY;
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) return Math.max(1, Number(raw));
  return DEFAULT_CONCURRENCY;
}

/**
 * Turns every chunk worker may take before the per-1000-character allowance;
 * 40 was the old fixed cap, so a small chunk never gets fewer turns than before.
 */
export const MAX_TURNS_BASE = 40;
/** Extra turns allowed for every 1000 characters of the chunk. */
export const MAX_TURNS_PER_1000_CHARS = 1;

/**
 * The per-chunk turn cap. A positive integer DIFF_REVIEW_MAX_TURNS wins;
 * otherwise it is derived from the chunk size (40 + 1 per started 1000
 * characters): a bigger chunk needs more reads, so it gets more turns. This
 * does not guarantee a reviewer finishes within the cap. The cap is passed to
 * eco-worker as ECO_WORKER_MAX_TURNS; a chunk that reaches it without a valid
 * verdict is an ERROR, never a PASS.
 * @param {number} chunkChars characters in the chunk.
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function maxTurnsFor(chunkChars, env = process.env) {
  const raw = env.DIFF_REVIEW_MAX_TURNS;
  if (typeof raw === "string" && /^[1-9]\d*$/.test(raw)) return Number(raw);
  const size = Number.isFinite(chunkChars) && chunkChars > 0 ? chunkChars : 0;
  return MAX_TURNS_BASE + Math.ceil(size / 1000) * MAX_TURNS_PER_1000_CHARS;
}

/**
 * diff-review asks eco-worker to stop at the first 429 instead of letting the
 * API client retry it. On by default for diff-review; ECO_WORKER_NO_RETRY_429=0
 * restores the worker's normal retry behaviour.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function noRetry429FromEnv(env = process.env) {
  return env.ECO_WORKER_NO_RETRY_429 !== "0";
}

/**
 * `line` as a JSON object, or null when it is not one.
 * @param {string} line
 * @returns {Record<string, any> | null}
 */
function jsonObject(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** eco-worker's own status lines start this way; the rest of a log is stream-json. */
function isWorkerStatusLine(line) {
  return line.startsWith("eco-worker:") || line.startsWith("RESULT=");
}

/**
 * A line that reports a rate-limit rejection: a stream-json event whose
 * top-level api_error_status or error_status is 429, or whose error.type is
 * "rate_limit_error"; or an eco-worker status line carrying the
 * api_error_status=429 field. A user/assistant event never counts: its text can
 * echo a tool_result that quotes this file or a log mentioning 429.
 * @param {string} line
 * @returns {boolean}
 */
function isRateLimitLine(line) {
  const event = jsonObject(line);
  if (event !== null) {
    if (event.type === "user" || event.type === "assistant") return false;
    const status = event.api_error_status ?? event.error_status;
    return status === 429 || status === "429" || event.error?.type === "rate_limit_error";
  }
  return isWorkerStatusLine(line) && /(?:^|\s)api_error_status=429(?:\s|$)/.test(line);
}

/**
 * A line that reports the assistant's turn cap: a stream-json event whose
 * subtype is "error_max_turns", or an eco-worker status line carrying the
 * error=error_max_turns field. A user/assistant event never counts; neither
 * does prose that merely mentions the words.
 * @param {string} line
 * @returns {boolean}
 */
function isTurnCapLine(line) {
  const event = jsonObject(line);
  if (event !== null) {
    if (event.type === "user" || event.type === "assistant") return false;
    return event.subtype === "error_max_turns";
  }
  return isWorkerStatusLine(line) && /(?:^|\s)error=error_max_turns\b/.test(line);
}

/**
 * The error text of a rate-limit rejection in worker log text, or null. The
 * first matching line (see isRateLimitLine) is parsed when it is JSON so a
 * nested error message is reported instead of the whole event; otherwise the
 * line itself is the evidence.
 * @param {string} text log text.
 * @returns {string | null}
 */
export function rateLimitDetail(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const line = text.split("\n").find(isRateLimitLine);
  if (line === undefined) return null;
  let detail = line.trim();
  try {
    const event = JSON.parse(line);
    const nested = event?.error;
    const message =
      typeof nested === "string"
        ? nested
        : (nested?.message ?? event?.result ?? event?.message);
    if (typeof message === "string" && message.trim().length > 0) detail = message.trim();
  } catch {
    // Not JSON: the matching line is the evidence.
  }
  return detail.slice(0, 400);
}

/**
 * The text of a turn-cap report in worker log text, or null. See isTurnCapLine
 * for what counts.
 * @param {string} text log text.
 * @returns {string | null}
 */
export function turnCapDetail(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const line = text.split("\n").find(isTurnCapLine);
  return line === undefined ? null : line.trim().slice(0, 400);
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results keep the
 * input order no matter which call finishes first. A throwing `fn` rejects the
 * whole pool; calls already started finish, but their results are ignored.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function runPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.floor(Number(limit)) || 1);
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await fn(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, list.length) }, worker));
  return results;
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

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/**
 * Decode git's C-style quoted path (core.quotePath): `\ooo` octal bytes and
 * the escapes in C_ESCAPES, read as UTF-8.
 * @param {string} quoted the path with its surrounding quotes.
 * @returns {string}
 * @throws {Error} on an escape git does not write or bytes that are not UTF-8.
 */
function unquoteC(quoted) {
  const bytes = [];
  const body = quoted.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const code = C_ESCAPES[body[index + 1]];
    if (code === undefined) throw new Error(`diff-review: cannot unquote git path ${quoted}`);
    bytes.push(code);
    index += 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new Error(`diff-review: git path ${quoted} is not UTF-8`);
  }
}

/**
 * A git path from a header, removing the a/ or b/ prefix and quotes.
 * @param {string} value e.g. `b/src/a.js` or `"b/caf\\303\\251.js"`.
 * @returns {string}
 */
function unquotePath(value) {
  const path = value.startsWith('"') && value.endsWith('"') ? unquoteC(value) : value;
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
 * recognised. Hunk line counts are tracked, so a removed line that looks like a
 * header is never mistaken for one and the next file's header is found after
 * the last hunk.
 * @param {string} diff
 * @returns {Array<{ path: string | null, text: string }>}
 */
export function splitFileSections(diff) {
  if (typeof diff !== "string" || diff.length === 0) return [];
  const lines = diff.split("\n");
  const sections = [];
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (line) => {
    current = { lines: line === null ? [] : [line] };
    sections.push(current);
    oldLeft = 0;
    newLeft = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      start(line);
      continue;
    }
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk && line.startsWith("--- ") && /^\+\+\+ /.test(lines[index + 1] ?? "")) {
      const ownHeader = current !== null && current.lines.some((entry) => entry.startsWith("+++ "));
      if (current === null || ownHeader) {
        start(line);
        continue;
      }
    }
    if (current === null) start(null);
    current.lines.push(line);
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!inHunk && hunk !== null) {
      // Unified diff omits ",count" when the count is 1, so an absent group means 1.
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
    } else if (inHunk) {
      if (line.startsWith(" ") || line === "") {
        oldLeft -= 1;
        newLeft -= 1;
      } else if (line.startsWith("-")) oldLeft -= 1;
      else if (line.startsWith("+")) newLeft -= 1;
    }
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
 * The "- " lines under a "## <heading>" block, stopping at the next heading.
 * @param {string} text
 * @param {string} heading the heading prefix, e.g. "## Files covered".
 * @returns {string[]}
 */
function sectionLines(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return [];
  const entries = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) entries.push(line.slice(2).trim());
  }
  return entries;
}

/**
 * The findings a verdict.md lists, in the same shape parseVerdict uses. A line
 * that cannot be read is skipped; the caller refuses a FAIL that lists none.
 * A line without " — why" keeps an empty why: the earlier verdict gave no
 * reason for this finding, and inventing one would put words in the reviewer's
 * mouth.
 * @param {string} text
 * @returns {Array<{ file: string, line: number | null, rule: string, why: string }>}
 */
function findingsFromMarkdown(text) {
  const findings = [];
  for (const entry of sectionLines(text, "## Findings")) {
    const match = /^`(.+?):([^`]*)` (.*)$/.exec(entry);
    if (match === null) continue;
    const file = match[1];
    const rawLine = match[2].trim();
    const line = rawLine === "" || rawLine === "-" ? null : Number(rawLine);
    const body = match[3];
    const split = body.indexOf(" — ");
    const rule = split === -1 ? body.trim() : body.slice(0, split).trim();
    const why = split === -1 ? "" : body.slice(split + 3).trim();
    if (file.length === 0 || rule.length === 0) continue;
    findings.push({
      file,
      line: Number.isFinite(line) ? line : null,
      rule,
      why,
    });
  }
  return findings;
}

/**
 * Read the parts of an earlier verdict.md that delta mode trusts: its head sha,
 * result, covered files and findings. A missing head line, a missing result or a
 * FAIL with no readable findings is an error: delta mode must not guess.
 * @param {string} text verdict.md contents.
 * @returns {{ ok: true, head: string, result: "PASS" | "FAIL" | "ERROR", coveredFiles: string[], findings: Array<{ file: string, line: number | null, rule: string, why: string }> } | { ok: false, error: string }}
 */
export function parseEarlierVerdict(text) {
  if (typeof text !== "string") return { ok: false, error: "the earlier verdict is not text" };
  const headLine = text.split("\n").find((line) => line.startsWith("- head:"));
  const head = headLine === undefined ? "" : headLine.slice("- head:".length).trim();
  if (!/^[0-9a-f]{40}$/.test(head))
    return {
      ok: false,
      error: "the earlier verdict has no readable '- head: <sha>' line; re-run diff-review on it first",
    };
  const resultMatch = /^# diff-review: (PASS|FAIL|ERROR)\b/m.exec(text);
  if (resultMatch === null)
    return { ok: false, error: "the earlier verdict has no readable 'diff-review: PASS|FAIL|ERROR' line" };
  const result = resultMatch[1];
  const coveredFiles = sectionLines(text, "## Files covered").map((entry) =>
    entry.replace(/ \(chunk .*\)$/, "").trim(),
  );
  const findings = findingsFromMarkdown(text);
  if (result === "FAIL" && findings.length === 0)
    return { ok: false, error: "the earlier verdict is FAIL but lists no readable findings" };
  return { ok: true, head, result, coveredFiles: [...new Set(coveredFiles)].filter(Boolean), findings };
}

/**
 * Combine a delta review's verdict with the earlier verdict it builds on.
 *
 * Files the earlier verdict covered and this delta did not re-review are listed
 * as covered by the earlier verdict. If the earlier verdict had a finding in a
 * file the delta did not re-review, that finding is carried into the result and
 * the overall verdict is FAIL, even when the delta itself passed: a finding may
 * not disappear because the file was skipped.
 * @param {{ parsed: ReturnType<typeof parseVerdict>, reviewedFiles: string[], earlier: { coveredFiles?: string[], findings?: Array<object> } }} options
 * @returns {{ parsed: ReturnType<typeof parseVerdict>, unchangedFiles: string[], unreviewedFindings: Array<object> }}
 */
export function deltaReview({ parsed, reviewedFiles, earlier }) {
  const reviewed = new Set(Array.isArray(reviewedFiles) ? reviewedFiles : []);
  const covered = Array.isArray(earlier?.coveredFiles) ? earlier.coveredFiles : [];
  const earlierFindings = Array.isArray(earlier?.findings) ? earlier.findings : [];
  const unchangedFiles = covered.filter((file) => !reviewed.has(file));
  const unreviewedFindings = earlierFindings.filter((finding) => !reviewed.has(finding.file));
  if (parsed.ok === false || unreviewedFindings.length === 0)
    return { parsed, unchangedFiles, unreviewedFindings };
  return {
    parsed: {
      ok: true,
      verdict: "FAIL",
      findings: [...(parsed.findings ?? []), ...unreviewedFindings],
      untested: parsed.untested ?? [],
    },
    unchangedFiles,
    unreviewedFindings,
  };
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

/**
 * The Bash commands a permissions file allows, from its `Bash(<cmd>:*)` and
 * `Bash(<cmd>)` allow entries, in file order.
 * @param {{ permissions?: { allow?: unknown[] } }} permissions parsed permissions JSON.
 * @returns {string[] | null} null when the file has no allow list.
 */
export function allowedBashCommands(permissions) {
  // No allow list is a broken permissions file, not an empty one: the caller errors.
  const allow = permissions?.permissions?.allow;
  if (!Array.isArray(allow)) return null;
  return allow.flatMap((entry) => {
    const match = typeof entry === "string" ? /^Bash\((.+?)(?::\*)?\)$/.exec(entry) : null;
    return match === null ? [] : [match[1]];
  });
}

/**
 * The reviewer's permissions for one run: three twins of every `Bash(git ...)`
 * allow rule — `-C <root>`, `--no-pager`, and `--no-pager -C <root>` — so the
 * reviewer (whose cwd is its chunk's run directory, not the repo root) can run
 * read-only git against the repository under review. The `--no-pager` twins
 * exist because `git --no-pager diff ...` does not match `Bash(git diff:*)`,
 * and that refusal turned a review into an ERROR. Only that root and only
 * allow-listed subcommands get a twin, so any other -C path or a write
 * subcommand is refused. Deny rules are copied; the input is not mutated.
 * @param {{ permissions: { allow: unknown[], deny: unknown[] } }} permissions parsed permissions JSON.
 * @param {string} root the repository root under review.
 * @returns {Record<string, any>} a new permissions object.
 * @throws {Error} when `permissions.permissions.allow` or `.deny` is not an array.
 */
export function reviewerPermissionsFor(permissions, root) {
  const source = permissions.permissions;
  if (!Array.isArray(source.allow)) {
    throw new Error("reviewer permissions have no permissions.allow list");
  }
  if (!Array.isArray(source.deny)) {
    throw new Error("reviewer permissions have no permissions.deny list");
  }
  const twins = source.allow.flatMap((rule) => {
    if (typeof rule !== "string" || !rule.startsWith("Bash(git ")) return [];
    const rest = rule.slice("Bash(git ".length);
    return [
      `Bash(git -C ${root} ${rest}`,
      `Bash(git --no-pager ${rest}`,
      `Bash(git --no-pager -C ${root} ${rest}`,
    ];
  });
  const merged = { ...source, allow: [...source.allow, ...twins], deny: [...source.deny] };
  return { ...permissions, permissions: merged };
}

/** Where the reviewer finds its copy of the decided-items file. */
export const DECIDED_COPY = "./decided.md";

/**
 * The task the reviewer is given.
 * @param {{ base: string, rules?: string[], decided?: boolean, project?: string | null, chunk?: { text: string, files: string[] }, chunkIndex?: number, chunkCount?: number, diffPath?: string, verdictPath?: string, rulePaths?: string[], decidedPath?: string | null, workdir?: string, readRoot?: string | null, allowedCommands?: string[], delta?: { since: string, path: string, result: string } | null }} options
 *   `chunk` is this run's complete patch; `diffPath`, `verdictPath` and
 *   `rulePaths` are absolute paths (the worker's cwd is its chunk directory;
 *   `readRoot`, when set, is the repository it may read). `rules` names the rule files when `rulePaths` is absent.
 *   `delta` names the earlier verdict a delta review builds on.
 *   `allowedCommands` are the Bash commands the reviewer's permissions allow
 *   (allowedBashCommands); the prompt names them so the reviewer does not try
 *   another one and turn the review into an ERROR.
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
  workdir = "the run directory",
  readRoot = null,
  allowedCommands = [],
  delta = null,
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
    ...(delta
      ? [
          `This is a delta review since ${delta.since}: only changes since that commit are in the diff. An earlier verdict at ${delta.path} returned ${delta.result}; judge only the delta, and do not re-raise findings its files no longer contain.`,
        ]
      : []),
    ...(files.length > 0
      ? ["This chunk covers these files:", ...files.map((file) => `- ${file}`)]
      : ["This chunk holds no file body."]),
    "",
    readRoot === null
      ? `Your working directory is ${workdir}. There is no repository to read for this review; judge the diff and the rule files. The only files you may write are ${verdictPath} and the progress file named in your WORKER RULES.`
      : `Your working directory is ${workdir}, this chunk's directory. The repository is at ${readRoot}: read it with Read, Grep and Glob on absolute paths under ${readRoot}, and with plain git show/log/diff/blame/rev-parse/ls-files run from your working directory, which is inside the repository; read-only git also works as \`git -C ${readRoot} <subcommand>\` for the allowed subcommands, and any other git -C path is refused; that is where you verify what the diff claims. Do not change the repository: the run compares its state before and after you, and any change makes the review an ERROR. The only files you may write are ${verdictPath} and the progress file named in your WORKER RULES.`,
    ...(allowedCommands.length > 0
      ? [
          `Bash is limited to these commands: ${allowedCommands.join(", ")}. Do not run tests, builds, node or any other command: a refused call makes the whole review an ERROR. List what you could not check that way under \`untested\` instead.`,
          "Run one command per Bash call, from your working directory: no cd, no ; or && chains, no $? or other variables. A pipe is fine only when every command in it is on that list. sed only as sed -n to print a line range (or use the Read tool with offset and limit). Paths outside the repository and your run directory are refused.",
        ]
      : []),
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
    "- You have no web access: do not call WebFetch or WebSearch, since a refused call makes the review an ERROR; a claim that rests on external documentation goes under `untested` and never counts as checked on its own.",
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
 * looks green; a clean PASS, or an advisory FAIL, exits 0. A PASS when a chunk
 * was larger than the chunk limit is an ERROR in both modes: the reviewer may
 * not have read that chunk whole.
 * @param {{ parsed: ReturnType<typeof parseVerdict>, blocking?: boolean, oversize?: boolean }} options
 * @returns {{ exitCode: 0 | 1, verdict: "PASS" | "FAIL" | "ERROR", line: string }}
 */
export function decide({ parsed, blocking, oversize = false }) {
  const mode = blocking === true ? "blocking" : "advisory";
  if (parsed.ok === true && parsed.verdict === "PASS" && oversize === true) {
    return {
      exitCode: 1,
      verdict: "ERROR",
      line: `diff-review: ERROR (${mode}) a chunk was larger than the chunk limit, so the reviewer may not have read it whole and a PASS cannot stand; split the change into smaller pieces`,
    };
  }
  if (parsed.ok === false) {
    return {
      exitCode: 1,
      verdict: "ERROR",
      line: `diff-review: ERROR (${mode}) ${parsed.error}`,
    };
  }
  if (parsed.verdict === "FAIL") {
    const count = parsed.findings.length;
    const untested = parsed.untested.length;
    return {
      exitCode: blocking === true ? 1 : 0,
      verdict: "FAIL",
      line: `diff-review: FAIL (${mode}) ${count} finding${count === 1 ? "" : "s"}${untested > 0 ? `, ${untested} untested` : ""} — second reader, never acceptance`,
    };
  }
  const untested = parsed.untested.length;
  return {
    exitCode: 0,
    verdict: "PASS",
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
