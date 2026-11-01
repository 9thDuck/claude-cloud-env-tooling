#!/usr/bin/env node
/**
 * diff-review: a second reader for a diff, driven by eco-worker.
 *
 *   diff-review                     # review `git diff origin/main...HEAD` + uncommitted and untracked work
 *   diff-review --base <ref>        # review against another base ref
 *   diff-review --diff-file <path>  # review a patch file instead of the working tree
 *   diff-review --self-test         # prove the reviewer fails fixtures/bad.patch and passes fixtures/good.patch
 *   diff-review --status            # one line: tool present and self-test newer than the tool
 *
 * Run it inside the repository under review. The rules come from .diff-review.json
 * at the merge-base commit (see README.md), or the bundled rules/default-rules.md
 * when the repo has no config. Each run's diff, prompt, rules and verdict go to
 * <repo>/.diff-review/<UTC timestamp>/, which git ignores. Each chunk's reviewer
 * writes chunks/<n>/verdict.json; the CLI reads only those files (never the
 * worker's stdout), merges them into the run's own verdict.json, prints the findings, writes verdict.md and exits by decide() (diff-review-lib.mjs).
 *
 * Advisory by default: a FAIL is printed and exits 0. DIFF_REVIEW_BLOCKING=1 makes
 * a FAIL exit 1. An ERROR (the review never ran or gave no valid verdict) exits 1
 * in both modes, so a broken review never looks green. The review is a second
 * reader, never acceptance.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_FILE,
  DECIDED_COPY,
  allowedBashCommands,
  chunkCharsError,
  chunkCharsFromEnv,
  blockingFromEnv,
  buildPrompt,
  concurrencyFromEnv,
  coverageProblems,
  decide,
  deltaReview,
  maxTurnsFor,
  mergeVerdicts,
  noRetry429FromEnv,
  parseConfig,
  parseEarlierVerdict,
  parseVerdict,
  rateLimitDetail,
  reviewerPermissionsFor,
  ruleCopies,
  runPool,
  runsToPrune,
  splitDiff,
  turnCapDetail,
  workerTimeoutSeconds,
} from "./diff-review-lib.mjs";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(TOOL_DIR, "fixtures");
export const FIXTURE_FILES = ["bad.patch", "good.patch"];
export const DEFAULT_RULES = join(TOOL_DIR, "rules", "default-rules.md");
// A lockfile regen must reach the chunk target, not die on Node's 1 MiB default.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Where the self-test keeps its record and runs; outside any repo, so it works anywhere.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(base, "diff-review");
}

/**
 * The eco-worker rule set for review runs: read and git-read commands only
 * (sed only as sed -n); git add/commit, cp, mv, rm and the like are denied. Rules are not a
 * security boundary (eco-worker's header says why), so review() also checks
 * that the repository is unchanged after the workers ran (repoState).
 */
export const REVIEWER_PERMISSIONS = join(TOOL_DIR, "reviewer-permissions.json");

/**
 * A fingerprint of everything a reviewer could change in the repository that
 * git does not ignore: HEAD, the porcelain status, the full diff of tracked
 * files against HEAD (so an edit to an already-modified file shows) and the
 * content of every untracked file. Ignored paths and the inside of an
 * untracked nested repository are not covered; the reviewer's own run
 * directory is one of the ignored paths.
 * @param {string} root
 * @returns {{ ok: true, state: string } | { ok: false, error: string }}
 */
export function repoState(root) {
  const head = git(["rev-parse", "HEAD"], root);
  if (!head.ok) return head;
  const status = git(["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"], root);
  if (!status.ok) return status;
  const tracked = git(["diff", "HEAD", "--binary"], root);
  if (!tracked.ok) return tracked;
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root);
  if (!untracked.ok) return untracked;
  const hash = createHash("sha256").update(tracked.stdout);
  for (const path of untracked.stdout.split("\0").filter(Boolean).sort()) {
    hash.update(`\0${path}\0`);
    try {
      // A symlink (to a directory, say) is recorded by its target, not read.
      // git lists an untracked nested repository as one "dir/" entry; it is
      // recorded by name only, so changes inside it are not covered.
      const full = join(root, path);
      if (path.endsWith("/")) continue;
      hash.update(lstatSync(full).isSymbolicLink() ? `link ${readlinkSync(full)}` : readFileSync(full));
    } catch (error) {
      return { ok: false, error: `could not read untracked ${path}: ${error.message}` };
    }
  }
  return { ok: true, state: `HEAD ${head.stdout.trim()}\n${status.stdout}\ncontent ${hash.digest("hex")}` };
}

/**
 * The Bash commands reviewer-permissions.json allows, for the prompt.
 * @param {string} [path] the permissions file; the shipped one by default.
 * @returns {{ ok: true, commands: string[] } | { ok: false, error: string }}
 */
export function loadReviewerCommands(path = REVIEWER_PERMISSIONS) {
  try {
    const commands = allowedBashCommands(JSON.parse(readFileSync(path, "utf8")));
    return commands === null
      ? { ok: false, error: `${path} has no permissions.allow list` }
      : { ok: true, commands };
  } catch (error) {
    return { ok: false, error: `could not read ${path}: ${error.message}` };
  }
}

/**
 * The reviewer command: DIFF_REVIEW_WORKER, else the eco-worker next to this tool.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function workerCommand(env = process.env) {
  return env.DIFF_REVIEW_WORKER
    ? env.DIFF_REVIEW_WORKER
    : join(TOOL_DIR, "..", "eco-worker", "eco-worker.sh");
}

/**
 * A UTC timestamp safe for a directory name and unique within the self-test.
 * @param {string} label
 * @returns {string}
 */
function stamp(label) {
  const utc = new Date().toISOString().replace(/[:.]/g, "-");
  return label === "" ? utc : `${utc}-${label}`;
}

/**
 * Run git, or report the failure loudly.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: true, stdout: string } | { ok: false, error: string }}
 */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  if (result.error)
    return { ok: false, error: `git ${args.join(" ")} failed: ${result.error.message}` };
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim().split("\n")[0];
    return { ok: false, error: `git ${args.join(" ")} exited ${result.status}: ${detail}` };
  }
  return { ok: true, stdout: result.stdout };
}

/**
 * The top of the repository that holds `cwd`.
 * @param {string} cwd
 * @returns {{ ok: true, root: string } | { ok: false, error: string }}
 */
export function repoRoot(cwd = process.cwd()) {
  const result = git(["rev-parse", "--show-toplevel"], cwd);
  if (!result.ok)
    return { ok: false, error: `run diff-review inside a git repository (${result.error})` };
  return { ok: true, root: result.stdout.trim() };
}

/**
 * The commit the change branches from: where `head` left `base`. The rules are read there.
 * @param {string} cwd repository directory.
 * @param {string} base ref the change targets.
 * @param {string} head
 * @returns {{ ok: true, sha: string } | { ok: false, error: string }}
 */
export function mergeBaseOf(cwd, base, head = "HEAD") {
  const result = git(["merge-base", base, head], cwd);
  if (!result.ok) return result;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha)
    ? { ok: true, sha }
    : { ok: false, error: `git merge-base ${base} ${head} gave no sha` };
}

/**
 * The bundled default rules, used by the self-test and by repos without a config.
 * @returns {{ ok: true, project: null, rules: Array<{ path: string, text: string }>, decided: null }}
 */
export function defaultRules() {
  return {
    ok: true,
    project: null,
    rules: [{ path: "default-rules.md", text: readFileSync(DEFAULT_RULES, "utf8") }],
    decided: null,
  };
}

/**
 * The rules as they are at the merge-base commit, not in the change's tree: a
 * change must not be able to rewrite the rules it is judged by. No config there
 * means the bundled defaults; a config naming a file that is not there is an error.
 * @param {string} cwd repository directory.
 * @param {string} mergeBase
 * @returns {{ ok: true, project: string | null, rules: Array<{ path: string, text: string }>, decided: string | null } | { ok: false, error: string }}
 */
export function loadRules(cwd, mergeBase) {
  const present = spawnSync("git", ["cat-file", "-e", `${mergeBase}:${CONFIG_FILE}`], {
    cwd,
    stdio: "ignore",
  });
  if (present.error) return { ok: false, error: `git could not run: ${present.error.message}` };
  if (present.status !== 0) return defaultRules();
  const shown = git(["show", `${mergeBase}:${CONFIG_FILE}`], cwd);
  if (!shown.ok) return shown;
  const config = parseConfig(shown.stdout);
  if (!config.ok) return config;
  const rules = [];
  for (const path of config.rules) {
    const rule = git(["show", `${mergeBase}:${path}`], cwd);
    if (!rule.ok)
      return {
        ok: false,
        error: `rule file ${path} named in ${CONFIG_FILE} is not at the merge-base ${mergeBase}: ${rule.error}`,
      };
    rules.push({ path, text: rule.stdout });
  }
  let decided = null;
  if (config.decided !== null) {
    const shownDecided = git(["show", `${mergeBase}:${config.decided}`], cwd);
    if (!shownDecided.ok)
      return {
        ok: false,
        error: `decided file ${config.decided} named in ${CONFIG_FILE} is not at the merge-base ${mergeBase}: ${shownDecided.error}`,
      };
    decided = shownDecided.stdout;
  }
  return { ok: true, project: config.project, rules, decided };
}

/**
 * Whether the self-test fixtures still match their pinned hashes.
 * @param {string} dir the fixtures directory.
 * @returns {string[]} problems; empty means they match.
 */
export function fixtureHashProblems(dir) {
  const pinned = join(dir, "fixtures.sha256");
  if (!existsSync(pinned)) return [`${pinned} is missing`];
  const expected = new Map(
    readFileSync(pinned, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", name = ""] = line.split(/\s+/);
        return [name, hash];
      }),
  );
  const problems = [];
  for (const name of FIXTURE_FILES) {
    const path = join(dir, name);
    const actual = existsSync(path)
      ? createHash("sha256").update(readFileSync(path)).digest("hex")
      : null;
    if (actual !== expected.get(name))
      problems.push(`${name} does not match its hash in fixtures.sha256`);
  }
  return problems;
}

/**
 * Parse a verdict file, or null when it is absent. A read error is a verdict
 * error, never an exception.
 * @param {string} verdictPath absolute path the prompt told the worker to write.
 * @returns {ReturnType<typeof parseVerdict> | null}
 */
function readVerdictFile(verdictPath) {
  if (!existsSync(verdictPath)) return null;
  try {
    return parseVerdict(readFileSync(verdictPath, "utf8"));
  } catch (error) {
    return { ok: false, error: `verdict.json could not be read: ${error.message}` };
  }
}

/**
 * The refused-call lines from the newest *.blocked.md a worker leg left in
 * `logDir`. eco-worker writes one blocked.md per leg and lists each refused
 * command there; the newline-delimited "- " lines are the commands. Empty only
 * when the directory was read and holds no *.blocked.md file; a directory or
 * file that cannot be read yields one line saying so; a readable newest file
 * with no "- " line yields one line saying it lists no refused call. Never an
 * empty list except the first case.
 * @param {string} logDir
 * @returns {string[]}
 */
function refusedCalls(logDir) {
  let newest;
  try {
    const files = readdirSync(logDir)
      .filter((name) => name.endsWith(".blocked.md"))
      .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
      // Newest first; on an mtime tie the later run id (a later leg) sorts first.
      .sort((left, right) => right.mtime - left.mtime || (left.name < right.name ? 1 : -1));
    newest = files[0]?.name;
  } catch (error) {
    return [`could not read the refused calls in ${logDir}: ${error.message}`];
  }
  if (newest === undefined) return [];
  try {
    const calls = readFileSync(join(logDir, newest), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter((line) => line.length > 0);
    if (calls.length === 0)
      return [`${join(logDir, newest)} was written but lists no refused call`];
    return calls;
  } catch (error) {
    return [`could not read the refused calls in ${join(logDir, newest)}: ${error.message}`];
  }
}

/**
 * Everything the worker leg left in `logDir` that can report a rejection: the
 * eco-worker log and status files. Unlike refusedCalls this cannot treat an
 * unreadable file as "no rejection": a 429 in a log we cannot read must not be
 * retried. Each unreadable path and its error are returned in `unreadable`.
 * @param {string} logDir
 * @returns {{ text: string, unreadable: string[] }}
 */
function logText(logDir) {
  let names;
  try {
    names = readdirSync(logDir);
  } catch (error) {
    return {
      text: "",
      unreadable: [`could not read the worker logs in ${logDir}: ${error.message}`],
    };
  }
  const text = [];
  const unreadable = [];
  for (const name of names) {
    if (!name.endsWith(".log") && !name.endsWith(".status")) continue;
    try {
      text.push(readFileSync(join(logDir, name), "utf8"));
    } catch (error) {
      unreadable.push(`could not read the worker log ${join(logDir, name)}: ${error.message}`);
    }
  }
  return { text: text.join("\n"), unreadable };
}

/**
 * Spawn the worker and settle when it closes. `error` (the command could not
 * start) and `close` both end the run; whichever comes first wins.
 * @param {string} worker
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 * @returns {Promise<{ status: number | null, signal: string | null } | { error: Error }>}
 */
function spawnWorker(worker, args, options) {
  return new Promise((settle) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      settle(result);
    };
    const child = spawn(worker, args, options);
    child.on("error", (error) => finish({ error }));
    child.on("close", (status, signal) => finish({ status, signal }));
  });
}

/**
 * The eco-worker ECO_WORKER_ALLOW_HOOK command for one chunk: readonly-hook.mjs
 * with the repository as read root and the chunk directory as the only place a
 * redirect may write. Each word is single-quoted for the hook's shell.
 * @param {string} readRoot
 * @param {string} workdir
 * @returns {string}
 */
export function readOnlyHookCommand(readRoot, workdir) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  return [process.execPath, join(TOOL_DIR, "readonly-hook.mjs"), "--read", readRoot, "--write", workdir].map(q).join(" ");
}

/** Turn cap for the one repair leg: rewrite one file, nothing else (ay7h3). */
const REPAIR_MAX_TURNS = 5;

/**
 * The run id of the newest eco-worker leg in `logDir` (its newest *.status),
 * so a repair leg resumes the reviewer's own session; null when none is left.
 * @param {string} logDir
 * @returns {string | null}
 */
function newestRunId(logDir) {
  const newest = readdirSync(logDir)
    .filter((name) => name.endsWith(".status"))
    .map((name) => ({ name, mtime: statSync(join(logDir, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime || (left.name < right.name ? 1 : -1))[0];
  return newest === undefined ? null : newest.name.slice(0, -".status".length);
}

/**
 * One repair leg for a verdict.json that exists but does not parse (ay7h3).
 * The reviewer's session is resumed with the parse error and asked to rewrite
 * the file as valid JSON; the tool never edits the file itself. Still invalid,
 * or no leg to resume, is an ERROR. With `finish` (the turn-cap detail), the leg
 * was ended at the cap with no verdict.json and is asked to write it from what it
 * has verified; still none is an ERROR.
 * @param {{ worker: string, workdir: string, logDir: string, verdictPath: string, parseError: string, finish?: string | null, timeoutSeconds: number, env: Record<string, string | undefined>, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true } | { ok: false, error: string, rateLimited?: boolean, detail?: string }>}
 */
async function repairVerdict({ worker, workdir, logDir, verdictPath, parseError, timeoutSeconds, env, signal, finish = null }) {
  let runId;
  try {
    runId = newestRunId(logDir);
  } catch (error) {
    return { ok: false, error: `could not find the reviewer's run to repair its verdict.json in ${logDir}: ${error.message}` };
  }
  if (runId === null)
    return finish === null
      ? { ok: false, error: `${parseError}; no reviewer run in ${logDir} to resume for a repair turn` }
      : { ok: false, turnCap: true, error: `turn cap: no verdict.json and no reviewer run in ${logDir} to resume (${finish})` };
  console.log(`[diff-review] ${finish === null ? "verdict.json is invalid" : "turn cap reached with no verdict.json"}; one ${finish === null ? "repair" : "finish"} turn for run ${runId}`);
  const prompt =
    finish !== null
      ? `The turn cap ended your review before you wrote ${verdictPath}. Write it now with the Write tool, from what you have already verified: the verdict, every finding you can back with what you read, and everything you did not get to under untested. Do not read or check anything else, then stop.`
      : `Your ${verdictPath} is not valid, so the review cannot be read. The parser said: ${parseError}
Rewrite ${verdictPath} as valid JSON with the Write tool. Keep every verdict, finding and untested entry you meant; only fix the syntax. Do not read or check anything else, then stop.`;
  const result = await spawnWorker(worker, ["-r", runId, "-t", String(timeoutSeconds), "-d", workdir, prompt], {
    cwd: workdir,
    stdio: "inherit",
    signal,
    env: { ...env, ECO_WORKER_MAX_TURNS: String(REPAIR_MAX_TURNS) },
  });
  if (result.error) return { ok: false, error: `${worker} could not start the repair turn: ${result.error.message}` };
  // The repair leg is judged like any leg: a 429 is fatal for the review, and a
  // failed leg is an ERROR even if the file now parses.
  const evidence = logText(logDir);
  if (evidence.unreadable.length > 0) return { ok: false, error: evidence.unreadable.join("; ") };
  const rate = rateLimitDetail(evidence.text);
  if (rate !== null) return { ok: false, rateLimited: true, detail: rate, error: `rate limited (429): ${rate}` };
  if (result.status !== 0)
    return {
      ok: false,
      error: `the verdict repair turn ${result.status === null ? `was killed by ${result.signal}` : `exited ${result.status}`}`,
    };
  const repaired = readVerdictFile(verdictPath);
  if (repaired?.ok === true) return { ok: true };
  if (finish !== null && repaired === null)
    return { ok: false, turnCap: true, error: `turn cap: no verdict.json after one finish turn (${finish})` };
  return {
    ok: false,
    error: `verdict.json invalid after one repair turn: ${repaired === null ? "the file is gone" : repaired.error}`,
  };
}

/**
 * Run the worker once, retrying once on a non-zero exit.
 *
 * Its logs go to `logDir` (inside the run directory) through eco-worker's
 * ECO_WORKER_LOG_DIR, and its verdict is written to the absolute `verdictPath`
 * given in the prompt.
 *
 * Chunk workers run concurrently (see runPool), so this is async: the run
 * completes on the child's close event rather than blocking the event loop.
 * `signal` aborts the child when another chunk hits a rate limit.
 *
 * The worker runs in `workdir`, the chunk's own run directory, so the only
 * files its edits are accepted in are its run files. `readRoot` is passed as an
 * eco-worker `-a "Read(/<root>/**)"` rule: the repository root, or the run
 * directory when there is no repository, so the rule copies in `<run>/rules/`
 * stay readable. The rule and reviewer-permissions.json keep the reviewer to
 * reads, but they are not a boundary (an allowed command can still write
 * through a shell redirect); review() checks the repository state instead.
 *
 * Exit 4 means eco-worker was blocked because at least one call was refused.
 * A blocked review did not do what it was asked, so it is an ERROR even when it
 * wrote a verdict, and it is not retried: the same prompt meets the same
 * refusal. The refused calls are reported. Exit 124 is eco-worker's timeout
 * (`-t`) or its no-output stall watchdog; it is an ERROR and not retried
 * either, so one hung or slow leg cannot spend the quota twice; its log says
 * which of the two it was. Every other non-zero exit is retried once and
 * then reported as an ERROR, except an attempt that left a refused call
 * (a *.blocked.md in its log dir): that ends the chunk as an ERROR at once,
 * because a retry would repeat a call that is already refused.
 *
 * A 429 is never retried and is fatal for the whole review: the caller cancels
 * the other chunks. A turn-cap report is not retried either; it is an ERROR
 * unless the leg still wrote a valid verdict. A leg that exits 0 or hits the
 * cap with a verdict.json that does not parse gets one repair leg (repairVerdict).
 * Both are read from eco-worker's
 * log/status files in `logDir`, and eco-worker runs with
 * ECO_WORKER_NO_RETRY_429=1 and ECO_WORKER_MAX_TURNS derived from the chunk size (maxTurnsFor).
 * `timeoutSeconds` scales with the chunk size and its turn cap
 * (workerTimeoutSeconds).
 * @param {{ workdir: string, readRoot: string, logDir: string, verdictPath: string, prompt: string, timeoutSeconds: number, chunkChars: number, signal?: AbortSignal }} options
 * @returns {Promise<{ ok: true, retried: boolean, turnCapped?: boolean } | { ok: false, error: string, retried: boolean, rateLimited?: boolean, detail?: string, turnCap?: boolean, cancelled?: boolean, blocked?: boolean, timedOut?: boolean }>}
 */
async function runWorker({ workdir, readRoot, logDir, verdictPath, prompt, timeoutSeconds, chunkChars, signal }) {
  const worker = workerCommand();
  const maxTurns = maxTurnsFor(chunkChars);
  const noRetry429 = noRetry429FromEnv();
  // The reviewer runs in the chunk directory, so it needs a -C twin of each
  // read-only git allow rule for readRoot only; an unreadable file is an ERROR.
  let shipped;
  const permissionsPath = join(logDir, "reviewer-permissions.json");
  try {
    shipped = JSON.parse(readFileSync(REVIEWER_PERMISSIONS, "utf8"));
    writeFileSync(permissionsPath, `${JSON.stringify(reviewerPermissionsFor(shipped, readRoot), null, 2)}\n`);
  } catch (error) {
    return { ok: false, retried: false, error: `could not build reviewer permissions from ${REVIEWER_PERMISSIONS}: ${error.message}` };
  }
  let lastFailure = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A retry must never read the previous attempt's verdict.
    rmSync(verdictPath, { force: true });
    console.log(
      `[diff-review] worker attempt ${attempt}/2 (workdir ${workdir}, logs ${logDir}, timeout ${timeoutSeconds}s)`,
    );
    // `-a` rules come before `-d`; eco-worker takes the task as the last argument.
    const env = {
        ...process.env,
        ECO_WORKER_LOG_DIR: logDir,
        // The reviewer's read-only rule set with git -C <readRoot> twins, not the
        // builder's permissions.json.
        ECO_WORKER_PERMISSIONS: permissionsPath,
        // Read-only commands as a class (67njw): prefix rules refused read-only
        // pipes and redirects, and each refusal voided the review.
        ECO_WORKER_ALLOW_HOOK: readOnlyHookCommand(readRoot, workdir),
        ECO_WORKER_NO_RETRY_429: noRetry429 ? "1" : "0",
        ECO_WORKER_MAX_TURNS: String(maxTurns),
    };
    const result = await spawnWorker(worker, ["-t", String(timeoutSeconds), "-a", `Read(/${readRoot}/**)`, "-d", workdir, prompt], {
      cwd: workdir,
      stdio: "inherit",
      signal,
      env,
    });
    // Aborted because another chunk was rate limited: not an attempt worth retrying.
    if (signal?.aborted)
      return {
        ok: false,
        cancelled: true,
        error: "cancelled after another chunk hit the rate limit",
        retried: attempt > 1,
      };
    if (result.error)
      return {
        ok: false,
        error: `${worker} could not start: ${result.error.message}`,
        retried: attempt > 1,
      };
    // A refused call is a failed review whatever the leg wrote. eco-worker keeps
    // every attempt's *.blocked.md, so a turn cap or a clean retry must not hide
    // one behind a verdict. Exit 4 has its own branch below, which lists the calls.
    let refusedFiles;
    try {
      refusedFiles = readdirSync(logDir)
        .filter((name) => name.endsWith(".blocked.md"))
        .sort();
    } catch (error) {
      return {
        ok: false,
        error: `could not read the worker logs in ${logDir}: ${error.message}`,
        retried: attempt > 1,
      };
    }
    const refusal =
      refusedFiles.length > 0
        ? {
            ok: false,
            blocked: true,
            error: `a worker attempt refused a call (${refusedFiles.join(", ")}); a blocked review is not a review`,
            retried: attempt > 1,
          }
        : null;
    // Every ok path goes through this: a refusal in any attempt fails the chunk,
    // and no retry follows it.
    const okResult = (extra) => (refusal !== null ? refusal : { ok: true, retried: attempt > 1, ...extra });
    const verdictRead = readVerdictFile(verdictPath);
    const validVerdict = verdictRead?.ok === true;
    // A clean exit with a verdict is a finished chunk; nothing else is trusted.
    if (result.status === 0 && validVerdict) return okResult({});
    const evidence = logText(logDir);
    // A leg that finished (or hit the cap) with a verdict.json that does not
    // parse gets one repair turn; a refused call or a 429 never does (ay7h3).
    const capped = evidence.unreadable.length === 0 && turnCapDetail(evidence.text) !== null;
    const repairable =
      verdictRead !== null &&
      verdictRead.ok !== true &&
      refusal === null &&
      evidence.unreadable.length === 0 &&
      rateLimitDetail(evidence.text) === null &&
      (result.status === 0 || capped);
    // A leg ended at the cap with no verdict.json gets one finish turn (ay7h3).
    const finishable =
      verdictRead === null &&
      capped &&
      refusal === null &&
      rateLimitDetail(evidence.text) === null;
    if (repairable || finishable) {
      const repaired = await repairVerdict({
        worker,
        workdir,
        logDir,
        verdictPath,
        parseError: verdictRead?.error ?? "",
        finish: finishable ? turnCapDetail(evidence.text) : null,
        timeoutSeconds,
        env,
        signal,
      });
      if (signal?.aborted)
        return { ok: false, cancelled: true, error: "cancelled after another chunk hit the rate limit", retried: attempt > 1 };
      if (!repaired.ok) return { ...repaired, retried: attempt > 1 };
      // The repair leg may itself have left a refused call.
      if (readdirSync(logDir).some((name) => name.endsWith(".blocked.md")))
        return { ok: false, blocked: true, error: "the verdict repair turn refused a call; a blocked review is not a review", retried: attempt > 1 };
      return { ok: true, retried: attempt > 1, ...(capped ? { turnCapped: true } : {}) };
    }
    // Unreadable evidence is a failed review, not a missing rejection: name the
    // path and error instead of retrying past a 429 nobody could read.
    if (evidence.unreadable.length > 0)
      return { ok: false, error: evidence.unreadable.join("; "), retried: attempt > 1 };
    // A 429 is the quota signal this tool exists to respect: no retry, no
    // further chunks. The caller cancels every other chunk worker.
    const rate = rateLimitDetail(evidence.text);
    if (rate !== null)
      return {
        ok: false,
        rateLimited: true,
        detail: rate,
        error: `rate limited (429): ${rate}`,
        retried: attempt > 1,
      };
    // The turn cap is deterministic; retrying would spend quota for the same result.
    const cap = turnCapDetail(evidence.text);
    if (cap !== null) {
      if (validVerdict) return okResult({ turnCapped: true });
      return {
        ok: false,
        turnCap: true,
        error: `turn cap (${maxTurns} turns): ${cap}`,
        retried: attempt > 1,
      };
    }
    if (result.status === 0) return okResult({});
    // Blocked: a refused call is part of the review that did not happen.
    if (result.status === 4)
      return {
        ok: false,
        blocked: true,
        error: `the worker exited 4 (blocked): refused calls are listed; a blocked review is not a review${validVerdict ? ", so its verdict.json is not used" : ""}`,
        retried: attempt > 1,
      };
    // Timed out or stalled: a retry would spend the quota a second time.
    if (result.status === 124)
      return {
        ok: false,
        timedOut: true,
        error: `the worker timed out (exit 124: the ${timeoutSeconds}s limit or eco-worker's stall watchdog; its log says which); not retried`,
        retried: attempt > 1,
      };
    // A refusal ends the chunk here too: a retry would spend a second attempt
    // to repeat a call that is already refused.
    if (refusal !== null) return refusal;
    lastFailure = result.status === null ? `was killed by ${result.signal}` : `exited ${result.status}`;
    // Loud: a failed reviewer run is a failed review, never a quiet PASS.
    console.error(`[diff-review] FAILED: worker ${lastFailure} on attempt ${attempt}/2`);
  }
  return { ok: false, error: `the worker ${lastFailure} twice`, retried: true };
}

/**
 * Read one chunk's verdict.json after its worker run. Errors are values, never
 * exceptions: a missing or malformed file is an ERROR for that chunk. A failed
 * run's refused calls are carried alongside the error so they reach verdict.md.
 * @param {string} verdictPath absolute path the prompt told the worker to write.
 * @param {{ ok: true, retried: boolean, turnCapped?: boolean } | { ok: false, error: string, retried: boolean }} run
 * @param {string} logDir
 * @returns {{ parsed: ReturnType<typeof parseVerdict>, workerNote: string, refused: string[] }}
 */
function readChunkVerdict(verdictPath, run, logDir) {
  if (!run.ok) {
    return {
      parsed: { ok: false, error: run.error },
      workerNote: `ERROR: ${run.error}`,
      refused: refusedCalls(logDir),
    };
  }
  const parsed = readVerdictFile(verdictPath);
  if (parsed === null) {
    // Never trust the worker's stdout; a run that wrote no file reviewed nothing.
    const error = `the worker exited 0 but wrote no verdict.json (${verdictPath})`;
    return { parsed: { ok: false, error }, workerNote: `ERROR: ${error}`, refused: refusedCalls(logDir) };
  }
  if (run.turnCapped)
    return { parsed, workerNote: "turn cap reached, but verdict.json is valid", refused: [] };
  return {
    parsed,
    workerNote: run.retried ? "exited non-zero once; the retry succeeded" : "exit 0",
    refused: [],
  };
}

/**
 * Review one diff and leave the evidence on disk.
 *
 * A diff over DIFF_REVIEW_CHUNK_CHARS is split into chunks (splitDiff); each
 * chunk gets its own worker run in `<run>/chunks/<n>/` (a one-chunk diff too),
 * with that directory as the worker's working directory and the repository root
 * (`readRoot`) readable, so it can read the code the diff talks about. A review
 * whose reviewer changed the repository (repoState before and after) is an
 * ERROR. Each run's timeout scales with its chunk size and
 * turn cap (workerTimeoutSeconds).
 * Chunk workers run concurrently, at most DIFF_REVIEW_CONCURRENCY (default 2,
 * minimum 1) at a time; results are merged in chunk order regardless of which
 * worker finished first. The verdicts are merged (any chunk ERROR => ERROR, else
 * any FAIL => FAIL), and a chunk set that does not cover every file in the diff
 * is an ERROR. A diff that yields no chunks is an ERROR too: a review that
 * looked at nothing cannot be a PASS. A diff that cannot be split or decoded
 * (a git path that is not UTF-8, say) ends in an ERROR verdict as well.
 *
 * A chunk that reports a rate limit (429) cancels every other chunk worker and
 * makes the whole review an ERROR; no further chunks are started. A turn-capped
 * chunk without a valid verdict is an ERROR too.
 *
 * `delta` turns this into an incremental review of the diff since an earlier
 * verdict's head; deltaReview combines the result with the earlier verdict.
 *
 * The run's own verdict.json (`<run>/verdict.json`, next to verdict.md) is
 * written by diff-review, never by a worker: `verdict` is PASS, FAIL or ERROR,
 * with `error` set on an ERROR, so a reader of the file alone cannot mistake a
 * failed review for a pass. Each worker's raw file stays in its chunk directory.
 * @param {{ diff: string, base: string, rules: ReturnType<typeof loadRules>, outDir: string, label?: string, blocking: boolean, readRoot?: string | null, maxChars?: number, head?: string | null, delta?: { since: string, path: string, result: string, earlier: ReturnType<typeof parseEarlierVerdict> } | null }} options
 *   `outDir` holds one directory per run; the oldest are pruned. `readRoot` is
 *   the repository root the worker may read (null for the self-test, which
 *   reads nothing outside its run). `head` is the commit under review, recorded
 *   in verdict.md and verdict.json.
 * @returns {Promise<{ parsed: ReturnType<typeof parseVerdict>, decision: ReturnType<typeof decide>, dir: string, verdictMd: string }>}
 */
export async function review({
  diff,
  base,
  rules,
  outDir,
  label = "",
  blocking,
  readRoot = null,
  maxChars = chunkCharsFromEnv(),
  head = null,
  delta = null,
}) {
  const runsDir = resolve(outDir);
  mkdirSync(runsDir, { recursive: true });
  // Run files must not show up in the repo's git status or the next review's diff.
  if (!existsSync(join(runsDir, ".gitignore"))) writeFileSync(join(runsDir, ".gitignore"), "*\n");
  const dir = resolve(join(runsDir, stamp(label)));
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const old of runsToPrune(names)) rmSync(join(runsDir, old), { recursive: true });

  const repoDir = readRoot === null ? null : resolve(readRoot);
  // The whole diff stays as evidence; each chunk gets its own patch file.
  writeFileSync(join(dir, "diff.patch"), diff);
  // A diff this tool cannot split or decode (a git path that is not UTF-8, say)
  // is a review it cannot run. The catch keeps the run on the fail-closed path
  // below, so it still ends in an ERROR verdict rather than a stack trace.
  let split = { chunks: [], files: [] };
  let coverage = [];
  let diffError = null;
  try {
    split = splitDiff(diff, { maxChars });
    coverage = coverageProblems(diff, split.chunks);
  } catch (error) {
    diffError = error.message;
  }
  const chunkRows = split.chunks.map((chunk, index) => {
    const chunkIndex = index + 1;
    // Every chunk, even the only one, has its own directory: <run>/verdict.json
    // belongs to diff-review, so no worker may write there.
    const chunkDir = resolve(join(dir, "chunks", String(chunkIndex)));
    return {
      index: chunkIndex,
      chunk,
      dir: chunkDir,
      files: chunk.files,
      chars: chunk.text.length,
      oversize: chunk.oversize === true,
      parsed: null,
      workerNote: "not run",
      refused: [],
    };
  });

  let ruleFiles = [];
  let decidedPath = null;
  if (rules.ok) {
    mkdirSync(join(dir, "rules"), { recursive: true });
    const copies = ruleCopies(rules.rules.map((rule) => rule.path));
    rules.rules.forEach((rule, index) => writeFileSync(join(dir, copies[index]), rule.text));
    ruleFiles = copies.map((copy) => resolve(join(dir, copy)));
    if (rules.decided !== null) {
      decidedPath = resolve(join(dir, DECIDED_COPY));
      writeFileSync(decidedPath, rules.decided);
    }
  }

  // A reviewer that changed the repository did not review what it was given.
  const reviewerCommands = loadReviewerCommands();
  const stateBefore = repoDir === null ? null : repoState(repoDir);
  let parsed;
  let deltaOutcome = null;
  if (diffError !== null) {
    // Nothing downstream can be trusted without the split and its coverage.
    parsed = { ok: false, error: diffError };
  } else if (!reviewerCommands.ok) {
    // The prompt must name the reviewer's commands, or its first guess blocks the run.
    parsed = { ok: false, error: reviewerCommands.error };
  } else if (stateBefore !== null && !stateBefore.ok) {
    // Without a before-state the read-only check cannot run, so no review starts.
    parsed = { ok: false, error: `could not record the repository state at ${repoDir} before the review, so the read-only check cannot run: ${stateBefore.error}` };
  } else if (!rules.ok) {
    // No rules, no review: a reviewer without them would judge from memory.
    parsed = { ok: false, error: rules.error };
  } else if (coverage.length > 0) {
    // Nothing may be silently dropped.
    parsed = { ok: false, error: `diff coverage is incomplete: ${coverage.join("; ")}` };
  } else if (chunkRows.length === 0) {
    // Fail closed: a review of zero chunks has looked at nothing, so it cannot
    // be a PASS. At an unchanged head the earlier verdict still covers the code.
    parsed = {
      ok: false,
      error:
        delta === null
          ? "nothing to review: the diff is empty and no verdict was produced"
          : `nothing changed since the earlier verdict at ${delta.since}; reuse that verdict instead of a new one`,
    };
  } else {
    const concurrency = concurrencyFromEnv();
    console.log(
      `[diff-review] reviewing ${chunkRows.length} chunk(s), ${concurrency} at a time`,
    );
    // One controller for the whole review: aborted as soon as a chunk reports 429.
    const controller = new AbortController();
    const rateLimit = { hit: null };
    // runPool keeps the results in chunk order even when later chunks finish first.
    const results = await runPool(chunkRows, concurrency, async (row) => {
      if (rateLimit.hit !== null) {
        // No further chunks start once a 429 is known.
        const note = `not started: cancelled after the rate limit in chunk ${rateLimit.hit.index}`;
        row.parsed = { ok: false, error: note };
        row.workerNote = note;
        return { index: row.index, parsed: row.parsed };
      }
      mkdirSync(row.dir, { recursive: true });
      const chunkPatch = resolve(join(row.dir, "diff.patch"));
      writeFileSync(chunkPatch, row.chunk.text);
      const verdictPath = resolve(join(row.dir, "verdict.json"));
      const prompt = buildPrompt({
        base,
        rules: rules.rules.map((rule) => rule.path),
        decided: rules.decided !== null,
        project: rules.project,
        chunk: row.chunk,
        chunkIndex: row.index,
        chunkCount: chunkRows.length,
        diffPath: chunkPatch,
        verdictPath,
        rulePaths: ruleFiles,
        decidedPath,
        workdir: row.dir,
        readRoot: repoDir,
        allowedCommands: reviewerCommands.commands,
        delta,
      });
      writeFileSync(join(row.dir, "prompt.md"), prompt);
      const run = await runWorker({
        workdir: row.dir,
        readRoot: repoDir ?? resolve(dir),
        logDir: row.dir,
        verdictPath,
        prompt,
        timeoutSeconds: workerTimeoutSeconds(row.chars),
        chunkChars: row.chars,
        signal: controller.signal,
      });
      if (run.ok === false && run.rateLimited === true && rateLimit.hit === null) {
        rateLimit.hit = { index: row.index, detail: run.detail };
        // Cancel the chunk workers already running; no later one will start.
        controller.abort();
      }
      const verdict = readChunkVerdict(verdictPath, run, row.dir);
      row.parsed = verdict.parsed;
      row.workerNote = verdict.workerNote;
      row.refused = verdict.refused;
      return { index: row.index, parsed: verdict.parsed };
    });
    parsed =
      rateLimit.hit === null
        ? mergeVerdicts(results)
        : {
            ok: false,
            error: `ERROR: rate limited (429) in chunk ${rateLimit.hit.index}: ${rateLimit.hit.detail}`,
          };
  }

  if (stateBefore !== null && stateBefore.ok && chunkRows.length > 0) {
    const stateAfter = repoState(repoDir);
    if (!stateAfter.ok || stateAfter.state !== stateBefore.state) {
      const changed = stateAfter.ok
        ? `the reviewer changed the repository at ${repoDir} (HEAD, git status or file contents differ from before the review); revert its changes and re-run`
        : `could not record the repository state at ${repoDir} after the review: ${stateAfter.error}`;
      parsed = { ok: false, error: parsed.ok === false ? `${parsed.error}; also ${changed}` : changed };
    }
  }

  if (delta !== null && rules.ok && coverage.length === 0) {
    deltaOutcome = deltaReview({
      parsed,
      reviewedFiles: split.files,
      earlier: delta.earlier,
    });
    parsed = deltaOutcome.parsed;
  }

  const oversize = chunkRows.some((row) => row.oversize === true);
  const decision = decide({ parsed, blocking, oversize });
  writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(runVerdict({ parsed, decision, base, head }), null, 2)}\n`);
  const verdictMd = join(dir, "verdict.md");
  writeFileSync(
    verdictMd,
    renderVerdictMarkdown({
      parsed,
      decision,
      base,
      head,
      diff,
      chunkRows,
      files: split.files,
      repoDir,
      coverage,
      delta,
      deltaOutcome,
    }),
  );
  return { parsed, decision, dir, verdictMd };
}

/**
 * The run's machine-readable verdict, taken from the decision so the file and
 * the exit code can never disagree: an oversize chunk is an ERROR here even
 * when the merged verdict is a PASS.
 * @param {{ parsed: ReturnType<typeof parseVerdict>, decision: ReturnType<typeof decide>, base: string, head: string | null }} options
 * @returns {{ verdict: "PASS" | "FAIL" | "ERROR", head: string | null, base: string, error?: string, findings: Array<object>, untested: string[] }}
 */
export function runVerdict({ parsed, decision, base, head }) {
  if (decision.verdict === "ERROR")
    return {
      verdict: "ERROR",
      head,
      base,
      error: parsed.ok === false ? parsed.error : decision.line,
      findings: [],
      untested: [],
    };
  return { verdict: decision.verdict, head, base, findings: parsed.findings, untested: parsed.untested };
}

/**
 * The human record of one review, next to the patch and the raw verdict. It
 * lists every chunk and every file the diff names, so coverage is auditable.
 * @param {{ parsed: ReturnType<typeof parseVerdict>, decision: ReturnType<typeof decide>, base: string, head: string | null, diff: string, chunkRows: Array<object>, files: string[], repoDir: string | null, coverage: string[], delta: { since: string, path: string, result: string } | null, deltaOutcome: { unchangedFiles: string[] } | null }} options
 * @returns {string}
 */
function renderVerdictMarkdown({
  parsed,
  decision,
  base,
  head,
  diff,
  chunkRows,
  files,
  repoDir,
  coverage,
  delta,
  deltaOutcome,
}) {
  const lines = [
    `# ${decision.line}`,
    "",
    `- at: ${new Date().toISOString()}`,
    // A direct review() call (tests, embedders) passes no head; main() always does.
    `- head: ${head ?? "(unknown)"}`,
    `- base: ${base}`,
    ...(delta === null
      ? []
      : [`- delta since ${delta.since}, earlier verdict ${delta.path} (${delta.result})`]),
    `- diff: ${diff.length} characters`,
    `- repository (read-only for the worker): ${repoDir ?? "(none)"}`,
    `- chunks: ${chunkRows.length}`,
    `- files covered: ${files.length}`,
    "",
  ];
  if (coverage.length > 0) {
    lines.push("## Coverage problems", "");
    for (const problem of coverage) lines.push(`- ${problem}`);
    lines.push("");
  }
  lines.push("## Chunks", "");
  if (chunkRows.length === 0) lines.push("None.");
  for (const row of chunkRows) {
    const verdict = row.parsed === null ? "not run" : row.parsed.ok === false ? "ERROR" : row.parsed.verdict;
    const oversize = row.oversize ? " (one hunk exceeds the chunk limit)" : "";
    lines.push(
      `- chunk ${row.index}: ${verdict} — ${row.chars} characters, ${row.files.length} file(s)${oversize} — ${row.workerNote} — ${row.dir}`,
    );
  }
  lines.push("", `## Files covered (${files.length})`, "");
  if (files.length === 0) lines.push("None.");
  const chunksByFile = new Map();
  for (const row of chunkRows) {
    for (const file of row.files) {
      if (!chunksByFile.has(file)) chunksByFile.set(file, []);
      chunksByFile.get(file).push(row.index);
    }
  }
  for (const file of files)
    lines.push(`- ${file} (chunk ${chunksByFile.get(file)?.join(", ") ?? "not covered"})`);
  lines.push("");
  if (delta !== null) {
    // The delta's evidence is complete only if the files it did not re-review
    // are named, with the earlier verdict that still covers them.
    lines.push(
      `## Files unchanged since ${delta.since} (covered by the earlier verdict ${delta.path})`,
      "",
    );
    const unchanged = deltaOutcome?.unchangedFiles ?? [];
    if (unchanged.length === 0) lines.push("None.");
    for (const file of unchanged) lines.push(`- ${file}`);
    lines.push("");
  }
  if (parsed.ok === false) {
    lines.push("## ERROR", "", parsed.error, "");
  } else {
    lines.push("## Findings", "");
    if (parsed.findings.length === 0) lines.push("None.");
    for (const finding of parsed.findings) {
      // An earlier verdict may list a finding with no why; do not add a fake one.
      const why = finding.why.length > 0 ? ` — ${finding.why}` : "";
      lines.push(`- \`${finding.file}:${finding.line ?? "-"}\` ${finding.rule}${why}`);
    }
    lines.push("", "## Untested", "");
    if (parsed.untested.length === 0) lines.push("None.");
    for (const entry of parsed.untested) lines.push(`- ${entry}`);
    lines.push("");
  }
  // A blocked worker leg is an ERROR; its refused calls say what it was refused,
  // so the next run's permissions or prompt can be fixed.
  const refused = chunkRows.flatMap((row) =>
    (row.refused ?? []).map((entry) => ({ index: row.index, entry })),
  );
  lines.push("## Untested / refused calls", "");
  if (refused.length === 0) lines.push("None.");
  for (const { index, entry } of refused) lines.push(`- chunk ${index}: ${entry}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * Print a review's result: findings, untested, verdict line.
 * @param {ReturnType<typeof review>} result
 */
export function report({ parsed, decision, verdictMd }) {
  if (parsed.ok === false) {
    console.error(`diff-review: ERROR report: ${parsed.error}`);
  } else {
    for (const finding of parsed.findings) {
      console.log(`  ${finding.file}:${finding.line ?? "-"} ${finding.rule} — ${finding.why}`);
    }
    if (parsed.untested.length > 0) {
      console.log("  untested:");
      for (const entry of parsed.untested) console.log(`    - ${entry}`);
    }
  }
  console.log(`  verdict: ${verdictMd}`);
  console.log(decision.line);
}

/**
 * The patch file's contents.
 * @param {string} path
 * @returns {{ ok: true, diff: string } | { ok: false, error: string }}
 */
function readPatch(path) {
  if (!existsSync(path)) return { ok: false, error: `--diff-file ${path} does not exist` };
  try {
    return { ok: true, diff: readFileSync(path, "utf8") };
  } catch (error) {
    return { ok: false, error: `--diff-file ${path} could not be read: ${error.message}` };
  }
}

/**
 * The change in the working tree: committed since `base`, uncommitted, and untracked files.
 * @param {string} root repository top.
 * @param {string} base
 * @returns {{ ok: true, diff: string } | { ok: false, error: string }}
 */
export function collectDiff(root, base) {
  const committed = git(["diff", `${base}...HEAD`], root);
  if (!committed.ok) return committed;
  // Against HEAD, not base: base...HEAD already holds the committed hunks.
  const uncommitted = git(["diff", "HEAD"], root);
  if (!uncommitted.ok) return uncommitted;
  const listed = git(["ls-files", "-o", "--exclude-standard"], root);
  if (!listed.ok) return listed;
  let untracked = "";
  for (const file of listed.stdout.split("\n").filter(Boolean)) {
    // --no-index exits 1 when the files differ, which is the normal case here.
    const added = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
    });
    if (added.error || (added.status !== 0 && added.status !== 1))
      return {
        ok: false,
        error: `could not diff untracked file ${file}: ${added.error ? added.error.message : added.stderr}`,
      };
    untracked += added.stdout;
  }
  return { ok: true, diff: `${committed.stdout}${uncommitted.stdout}${untracked}` };
}

/**
 * The delta a `--since-verdict` review builds on: read the earlier verdict, check
 * its head is an ancestor of `head`, and collect only the changes since that
 * head. The earlier verdict must not be an ERROR and must carry a head sha; a
 * delta with no changes yields no chunks, and review() reports an ERROR asking
 * for the earlier verdict to be reused rather than reviewing nothing.
 * @param {string} root repository top.
 * @param {string} sincePath path to the earlier verdict.md, as the user gave it.
 * @param {string | null} head current HEAD sha.
 * @returns {{ ok: true, diff: string, earlierPath: string, earlier: ReturnType<typeof parseEarlierVerdict> } | { ok: false, error: string }}
 */
export function prepareDelta(root, sincePath, head) {
  const earlierPath = resolve(sincePath);
  if (!existsSync(earlierPath))
    return { ok: false, error: `--since-verdict ${sincePath} does not exist` };
  let text;
  try {
    text = readFileSync(earlierPath, "utf8");
  } catch (error) {
    return { ok: false, error: `--since-verdict ${sincePath} could not be read: ${error.message}` };
  }
  const earlier = parseEarlierVerdict(text);
  if (!earlier.ok) return { ok: false, error: `${sincePath}: ${earlier.error}` };
  if (earlier.result === "ERROR")
    return {
      ok: false,
      error: `--since-verdict ${sincePath} is an ERROR verdict; there is nothing trusted to review a delta against`,
    };
  if (head === null)
    return { ok: false, error: "--since-verdict needs a git HEAD to compare against" };
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", earlier.head, head], {
    cwd: root,
    encoding: "utf8",
  });
  if (ancestor.error)
    return { ok: false, error: `git merge-base could not run: ${ancestor.error.message}` };
  if (ancestor.status !== 0)
    return {
      ok: false,
      error: `--since-verdict head ${earlier.head} is not an ancestor of HEAD (${head})`,
    };
  const collected = collectDiff(root, earlier.head);
  if (!collected.ok) return collected;
  return { ok: true, diff: collected.diff, earlierPath, earlier };
}

/**
 * A failed setup (git, a missing patch) goes through the same verdict line as a
 * reviewer ERROR, so it exits 1 in both modes.
 * @param {string} error
 * @returns {number} exit code
 */
function setupError(error) {
  const decision = decide({ parsed: { ok: false, error }, blocking: blockingFromEnv() });
  console.error(`diff-review: ERROR report: ${error}`);
  console.error(decision.line);
  return decision.exitCode;
}

/**
 * Prove the reviewer can fail: bad.patch must be FAIL with a finding, good.patch PASS.
 * Uses the bundled rules and runs advisory on purpose; it asserts the verdicts itself.
 * @returns {Promise<number>} exit code
 */
async function selfTest() {
  const state = stateDir();
  const rows = [];
  let pass = true;
  const drift = fixtureHashProblems(FIXTURES);
  for (const problem of drift) console.error(`diff-review: ERROR self-test fixtures: ${problem}`);
  if (drift.length > 0) pass = false;
  for (const testCase of [
    { name: "bad", verdict: "FAIL" },
    { name: "good", verdict: "PASS" },
  ]) {
    const patch = readPatch(join(FIXTURES, `${testCase.name}.patch`));
    if (!patch.ok) {
      console.error(`diff-review: ERROR self-test ${testCase.name}: ${patch.error}`);
      rows.push({ name: testCase.name, verdict: "ERROR", findings: 0, verdictMd: "-" });
      pass = false;
      continue;
    }
    const result = await review({
      diff: patch.diff,
      base: "(self-test fixture)",
      rules: defaultRules(),
      outDir: join(state, "self-test-runs"),
      label: testCase.name,
      blocking: false,
      head: "(self-test fixture)",
    });
    const verdict = result.parsed.ok === false ? "ERROR" : result.parsed.verdict;
    const findings = result.parsed.ok === false ? 0 : result.parsed.findings.length;
    report(result);
    rows.push({ name: testCase.name, verdict, findings, verdictMd: result.verdictMd });
    if (verdict !== testCase.verdict || (testCase.verdict === "FAIL" && findings === 0))
      pass = false;
  }

  console.log("\ncase  verdict  findings  verdict.md");
  for (const row of rows)
    console.log(
      `${row.name.padEnd(6)}${row.verdict.padEnd(9)}${String(row.findings).padEnd(10)}${row.verdictMd}`,
    );
  const recordPath = join(state, "self-test.json");
  const record = {
    at: new Date().toISOString(),
    badVerdict: rows[0].verdict,
    goodVerdict: rows[1].verdict,
    pass,
  };
  mkdirSync(state, { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `self-test ${pass ? "PASS" : "FAIL"}: bad=${record.badVerdict} good=${record.goodVerdict} (${recordPath})`,
  );
  return pass ? 0 : 1;
}

/**
 * One line; exit 0 only when the tool is present and its self-test passed after
 * the last change to any of its files.
 * @returns {number} exit code
 */
function status() {
  const recordPath = join(stateDir(), "self-test.json");
  const required = [
    fileURLToPath(import.meta.url),
    join(TOOL_DIR, "diff-review-lib.mjs"),
    ...FIXTURE_FILES.map((name) => join(FIXTURES, name)),
    join(FIXTURES, "fixtures.sha256"),
    DEFAULT_RULES,
    REVIEWER_PERMISSIONS,
  ];
  for (const file of required) {
    if (!existsSync(file)) {
      console.log(`FAIL diff-review: missing ${file}`);
      return 1;
    }
  }
  if (!existsSync(recordPath)) {
    console.log(`FAIL diff-review: no self-test record at ${recordPath}; run diff-review --self-test`);
    return 1;
  }
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch (error) {
    console.log(`FAIL diff-review: self-test record is not valid JSON: ${error.message}`);
    return 1;
  }
  if (record?.pass !== true) {
    console.log(
      `FAIL diff-review: last self-test did not pass (bad=${record?.badVerdict} good=${record?.goodVerdict}); run diff-review --self-test`,
    );
    return 1;
  }
  const at = Date.parse(record.at);
  if (!Number.isFinite(at)) {
    console.log(`FAIL diff-review: self-test record has no readable "at" (${JSON.stringify(record.at)})`);
    return 1;
  }
  for (const file of required) {
    if (at <= statSync(file).mtimeMs) {
      console.log(
        `FAIL diff-review: self-test (${record.at}) is older than ${relative(TOOL_DIR, file)}; run diff-review --self-test`,
      );
      return 1;
    }
  }
  console.log(
    `PASS diff-review: ${blockingFromEnv() ? "blocking (DIFF_REVIEW_BLOCKING=1)" : "advisory"}, self-test ${record.at} bad=${record.badVerdict} good=${record.goodVerdict}`,
  );
  return 0;
}

/**
 * Parse argv into the mode.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: "review" | "self-test" | "status", base: string, diffFile: string | null, sinceVerdict: string | null } | { error: string }}
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    mode: "review",
    base: env.DIFF_REVIEW_BASE ? env.DIFF_REVIEW_BASE : "origin/main",
    diffFile: null,
    sinceVerdict: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: "--base needs a ref" };
      options.base = value;
      i += 1;
    } else if (arg === "--diff-file") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { error: "--diff-file needs a path" };
      options.diffFile = value;
      i += 1;
    } else if (arg === "--since-verdict") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { error: "--since-verdict needs a path to an earlier verdict.md" };
      options.sinceVerdict = value;
      i += 1;
    } else if (arg === "--self-test") options.mode = "self-test";
    else if (arg === "--status") options.mode = "status";
    else if (arg === "-h" || arg === "--help") options.mode = "help";
    else return { error: `unknown argument ${arg}` };
  }
  return options;
}

const USAGE = `usage: diff-review [--base <ref>] [--diff-file <path> | --since-verdict <verdict.md>] | --self-test | --status
Reviews the change against <ref> (default DIFF_REVIEW_BASE or origin/main) with eco-worker.
--since-verdict reviews only what changed since an earlier verdict's head.
Advisory by default; DIFF_REVIEW_BLOCKING=1 makes a FAIL exit 1. See README.md.`;

/**
 * The CLI.
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`diff-review: ERROR ${options.error}\n${USAGE}`);
    return 2;
  }
  if (options.mode === "help") {
    console.log(USAGE);
    return 0;
  }
  if (options.mode === "status") return status();
  const chunkProblem = chunkCharsError();
  if (chunkProblem !== null) return setupError(chunkProblem);
  if (options.mode === "self-test") return await selfTest();
  const top = repoRoot();
  if (!top.ok) return setupError(top.error);
  if (options.diffFile !== null && options.sinceVerdict !== null)
    return setupError("--since-verdict cannot be combined with --diff-file; delta mode reads the repository");
  // A repository with no commits has no HEAD: report the git error rather than
  // writing a verdict whose "- head:" line --since-verdict could never use.
  const headResult = git(["rev-parse", "HEAD"], top.root);
  if (!headResult.ok) return setupError(headResult.error);
  const head = headResult.stdout.trim();
  const mergeBase = mergeBaseOf(top.root, options.base);
  const rules = mergeBase.ok ? loadRules(top.root, mergeBase.sha) : mergeBase;
  let diff;
  let delta = null;
  if (options.sinceVerdict !== null) {
    const prepared = prepareDelta(top.root, options.sinceVerdict, head);
    if (!prepared.ok) return setupError(prepared.error);
    diff = prepared.diff;
    delta = {
      since: prepared.earlier.head,
      path: prepared.earlierPath,
      result: prepared.earlier.result,
      earlier: prepared.earlier,
    };
  } else {
    const collected =
      options.diffFile === null ? collectDiff(top.root, options.base) : readPatch(options.diffFile);
    if (!collected.ok) return setupError(collected.error);
    diff = collected.diff;
  }
  const result = await review({
    diff,
    base: options.base,
    rules,
    outDir: join(top.root, ".diff-review"),
    blocking: blockingFromEnv(),
    readRoot: top.root,
    head,
    delta,
  });
  report(result);
  return result.decision.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`diff-review: ERROR ${error?.stack ?? error}`);
      process.exit(1);
    },
  );
}
