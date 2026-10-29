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
 * <repo>/.diff-review/<UTC timestamp>/, which git ignores. The reviewer writes
 * verdict.json there; the CLI reads only that file (never the worker's stdout),
 * prints the findings, writes verdict.md and exits by decide() (diff-review-lib.mjs).
 *
 * Advisory by default: a FAIL is printed and exits 0. DIFF_REVIEW_BLOCKING=1 makes
 * a FAIL exit 1. An ERROR (the review never ran or gave no valid verdict) exits 1
 * in both modes, so a broken review never looks green. The review is a second
 * reader, never acceptance.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_FILE,
  DECIDED_COPY,
  MAX_DIFF_CHARS,
  blockingFromEnv,
  buildPrompt,
  decide,
  parseConfig,
  parseVerdict,
  ruleCopies,
  runsToPrune,
} from "./diff-review-lib.mjs";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(TOOL_DIR, "fixtures");
export const FIXTURE_FILES = ["bad.patch", "good.patch"];
export const DEFAULT_RULES = join(TOOL_DIR, "rules", "default-rules.md");
// A lockfile regen must reach MAX_DIFF_CHARS, not die on Node's 1 MiB default.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const TIMEOUT_SECONDS = "600";

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
 * Run the worker once, retrying once on a non-zero exit.
 * @param {string} dir working directory the reviewer treats as its own.
 * @param {string} prompt
 * @returns {{ ok: true, retried: boolean } | { ok: false, error: string, retried: boolean }}
 */
function runWorker(dir, prompt) {
  const worker = workerCommand();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A retry must never read the previous attempt's verdict.
    rmSync(join(dir, "verdict.json"), { force: true });
    console.log(`[diff-review] worker attempt ${attempt}/2 (-d ${dir})`);
    const result = spawnSync(worker, ["-t", TIMEOUT_SECONDS, "-d", dir, prompt], {
      cwd: dir,
      encoding: "utf8",
      stdio: "inherit",
    });
    if (result.error)
      return {
        ok: false,
        error: `${worker} could not start: ${result.error.message}`,
        retried: attempt > 1,
      };
    if (result.status === 0) return { ok: true, retried: attempt > 1 };
    // Loud: a failed reviewer run is a failed review, never a quiet PASS.
    console.error(`[diff-review] FAILED: worker exited ${result.status} on attempt ${attempt}/2`);
  }
  return { ok: false, error: "the worker exited non-zero twice", retried: true };
}

/**
 * Review one diff and leave the evidence on disk.
 * @param {{ diff: string, base: string, rules: ReturnType<typeof loadRules>, outDir: string, label?: string, blocking: boolean }} options
 *   `outDir` holds one directory per run; the oldest are pruned.
 * @returns {{ parsed: ReturnType<typeof parseVerdict>, decision: ReturnType<typeof decide>, dir: string, verdictMd: string }}
 */
export function review({ diff, base, rules, outDir, label = "", blocking }) {
  mkdirSync(outDir, { recursive: true });
  // Run files must not show up in the repo's git status or the next review's diff.
  if (!existsSync(join(outDir, ".gitignore"))) writeFileSync(join(outDir, ".gitignore"), "*\n");
  const dir = join(outDir, stamp(label));
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const old of runsToPrune(names)) rmSync(join(outDir, old), { recursive: true });
  writeFileSync(join(dir, "diff.patch"), diff.slice(0, MAX_DIFF_CHARS));

  let run;
  if (rules.ok) {
    mkdirSync(join(dir, "rules"), { recursive: true });
    const copies = ruleCopies(rules.rules.map((rule) => rule.path));
    rules.rules.forEach((rule, index) => writeFileSync(join(dir, copies[index]), rule.text));
    if (rules.decided !== null) writeFileSync(join(dir, DECIDED_COPY), rules.decided);
    const prompt = buildPrompt({
      diff,
      base,
      rules: rules.rules.map((rule) => rule.path),
      decided: rules.decided !== null,
      project: rules.project,
    });
    writeFileSync(join(dir, "prompt.md"), prompt);
    run = runWorker(dir, prompt);
  } else {
    // No rules, no review: a reviewer without them would judge from memory.
    run = { ok: false, error: rules.error, retried: false };
  }

  const verdictPath = join(dir, "verdict.json");
  let parsed;
  let workerNote;
  if (!run.ok) {
    parsed = { ok: false, error: run.error };
    workerNote = `ERROR: ${run.error}`;
  } else if (!existsSync(verdictPath)) {
    // Never trust the worker's stdout; a run that wrote no file reviewed nothing.
    parsed = { ok: false, error: `the worker exited 0 but wrote no verdict.json (${verdictPath})` };
    workerNote = `ERROR: ${parsed.error}`;
  } else {
    try {
      parsed = parseVerdict(readFileSync(verdictPath, "utf8"));
    } catch (error) {
      parsed = { ok: false, error: `verdict.json could not be read: ${error.message}` };
    }
    workerNote = run.retried ? "exited non-zero once; the retry succeeded" : "exit 0";
  }

  const decision = decide({ parsed, blocking, truncated: diff.length > MAX_DIFF_CHARS });
  const verdictMd = join(dir, "verdict.md");
  writeFileSync(verdictMd, renderVerdictMarkdown({ parsed, decision, base, diff, workerNote }));
  return { parsed, decision, dir, verdictMd };
}

/**
 * The human record of one review, next to the patch and the raw verdict.
 * @param {{ parsed: ReturnType<typeof parseVerdict>, decision: ReturnType<typeof decide>, base: string, diff: string, workerNote: string }} options
 * @returns {string}
 */
function renderVerdictMarkdown({ parsed, decision, base, diff, workerNote }) {
  const lines = [
    `# ${decision.line}`,
    "",
    `- at: ${new Date().toISOString()}`,
    `- base: ${base}`,
    `- diff: ${diff.length} characters${diff.length > MAX_DIFF_CHARS ? ` (diff.patch holds the first ${MAX_DIFF_CHARS})` : ""}`,
    `- worker: ${workerNote}`,
    "",
  ];
  if (parsed.ok === false) {
    lines.push("## ERROR", "", parsed.error, "");
  } else {
    lines.push("## Findings", "");
    if (parsed.findings.length === 0) lines.push("None.");
    for (const finding of parsed.findings) {
      lines.push(`- \`${finding.file}:${finding.line ?? "-"}\` ${finding.rule} — ${finding.why}`);
    }
    lines.push("", "## Untested", "");
    if (parsed.untested.length === 0) lines.push("None.");
    for (const entry of parsed.untested) lines.push(`- ${entry}`);
    lines.push("");
  }
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
 * @returns {number} exit code
 */
function selfTest() {
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
    const result = review({
      diff: patch.diff,
      base: "(self-test fixture)",
      rules: defaultRules(),
      outDir: join(state, "self-test-runs"),
      label: testCase.name,
      blocking: false,
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
 * @returns {{ mode: "review" | "self-test" | "status", base: string, diffFile: string | null } | { error: string }}
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    mode: "review",
    base: env.DIFF_REVIEW_BASE ? env.DIFF_REVIEW_BASE : "origin/main",
    diffFile: null,
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
    } else if (arg === "--self-test") options.mode = "self-test";
    else if (arg === "--status") options.mode = "status";
    else if (arg === "-h" || arg === "--help") options.mode = "help";
    else return { error: `unknown argument ${arg}` };
  }
  return options;
}

const USAGE = `usage: diff-review [--base <ref>] [--diff-file <path>] | --self-test | --status
Reviews the change against <ref> (default DIFF_REVIEW_BASE or origin/main) with eco-worker.
Advisory by default; DIFF_REVIEW_BLOCKING=1 makes a FAIL exit 1. See README.md.`;

/**
 * The CLI.
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv) {
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
  if (options.mode === "self-test") return selfTest();
  const top = repoRoot();
  if (!top.ok) return setupError(top.error);
  const collected =
    options.diffFile === null ? collectDiff(top.root, options.base) : readPatch(options.diffFile);
  if (!collected.ok) return setupError(collected.error);
  if (collected.diff.trim().length === 0) {
    console.log("diff-review: nothing to review");
    return 0;
  }
  const mergeBase = mergeBaseOf(top.root, options.base);
  const rules = mergeBase.ok ? loadRules(top.root, mergeBase.sha) : mergeBase;
  const result = review({
    diff: collected.diff,
    base: options.base,
    rules,
    outDir: join(top.root, ".diff-review"),
    blocking: blockingFromEnv(),
  });
  report(result);
  return result.decision.exitCode;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
