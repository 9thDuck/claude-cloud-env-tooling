import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { workerTimeoutSeconds } from "../diff-review/diff-review-lib.mjs";
import {
  FIXTURES,
  collectDiff,
  defaultRules,
  fixtureHashProblems,
  loadRules,
  mergeBaseOf,
  parseArgs,
  prepareDelta,
  REVIEWER_PERMISSIONS,
  loadReviewerCommands,
  repoState,
  review,
  stateDir,
  workerCommand,
} from "../diff-review/diff-review.mjs";

const WORK = resolve(import.meta.dirname, "..", ".work");
let dir;
const extraDirs = [];

/** Run git in the temp repo. */
function git(...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

/** A fresh git repo whose committed app.js is NOT in the reviewed diff. */
function makeRepo(prefix) {
  const repo = mkdtempSync(join(WORK, prefix));
  extraDirs.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  writeFileSync(join(repo, "app.js"), "export const marker = 'from-repo';\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
  return repo;
}

/** One file's section of a unified diff. */
function fileSection(path, hunks = ["@@ -1 +1 @@\n-a\n+b"]) {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join("\n");
}

// Proves what the worker may read: it reads app.js, a repo file outside the
// diff, from the root its -a "Read(/<root>/**)" rule grants, and writes its
// verdict to its chunk directory. Without the rule it has no repo to read.
const FAKE_WORKER = `#!/usr/bin/env bash
set -euo pipefail
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
root=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-a" ]; then root="\${arg#Read(/}"; root="\${root%/\*\*)}"; fi
  prev="$arg"
done
for last in "$@"; do :; done
prompt="$last"
[ -n "$root" ] || { echo "no read rule" >&2; exit 1; }
value="$(cat "$root/app.js")"
printf 'cwd=%s\\nread app.js=%s\\n' "$PWD" "$value" > "$out/c1-read-proof.txt"
if printf '%s' "$prompt" | grep -q 'src/bad.js'; then
  printf '%s\\n' '{"verdict":"FAIL","findings":[{"file":"src/bad.js","line":1,"rule":"No stubs","why":"planted bad file"}],"untested":[]}' > "$out/verdict.json"
else
  printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
fi
`;

// Records the -t value it was called with, next to a valid verdict.
const RECORDING_WORKER = `#!/usr/bin/env bash
set -euo pipefail
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf '%s\\n' "$2" > "$out/timeout.txt"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

beforeAll(() => {
  mkdirSync(WORK, { recursive: true });
  dir = mkdtempSync(join(WORK, "repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(dir, "app.js"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const path of extraDirs) rmSync(path, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("defaults to a review against origin/main", () => {
    expect(parseArgs([], {})).toEqual({
      mode: "review",
      base: "origin/main",
      diffFile: null,
      sinceVerdict: null,
    });
  });

  it("takes the base from DIFF_REVIEW_BASE, then --base", () => {
    expect(parseArgs([], { DIFF_REVIEW_BASE: "origin/dev" })).toMatchObject({ base: "origin/dev" });
    expect(parseArgs(["--base", "main"], { DIFF_REVIEW_BASE: "origin/dev" })).toMatchObject({ base: "main" });
  });

  it("parses the modes and rejects bad arguments", () => {
    expect(parseArgs(["--self-test"], {})).toMatchObject({ mode: "self-test" });
    expect(parseArgs(["--status"], {})).toMatchObject({ mode: "status" });
    expect(parseArgs(["--diff-file", "x.patch"], {})).toMatchObject({ diffFile: "x.patch" });
    expect(parseArgs(["--since-verdict", "old/verdict.md"], {})).toMatchObject({
      sinceVerdict: "old/verdict.md",
    });
    expect(parseArgs(["--base"], {})).toHaveProperty("error");
    expect(parseArgs(["--diff-file", "--status"], {})).toHaveProperty("error");
    expect(parseArgs(["--since-verdict", "--status"], {})).toHaveProperty("error");
    expect(parseArgs(["--nope"], {})).toHaveProperty("error");
  });
});

describe("environment defaults", () => {
  it("keeps self-test state under XDG_STATE_HOME", () => {
    expect(stateDir({ XDG_STATE_HOME: "/s" })).toBe("/s/diff-review");
  });

  it("uses DIFF_REVIEW_WORKER, else the bundled eco-worker", () => {
    expect(workerCommand({ DIFF_REVIEW_WORKER: "my-worker" })).toBe("my-worker");
    expect(workerCommand({})).toMatch(/eco-worker[/\\]eco-worker\.sh$/);
  });
});

describe("loadRules", () => {
  it("uses the bundled default rules when the repo has no config", () => {
    const base = mergeBaseOf(dir, "main");
    expect(base.ok).toBe(true);
    const rules = loadRules(dir, base.sha);
    expect(rules).toMatchObject({ ok: true, project: null, decided: null });
    expect(rules.rules[0].text).toContain("No swallowed errors");
  });

  it("reads the config and rules from the merge-base, not the working tree", () => {
    writeFileSync(join(dir, ".diff-review.json"), JSON.stringify({ project: "Demo", rules: ["RULES.md"], decided: "DECIDED.md" }));
    writeFileSync(join(dir, "RULES.md"), "1. Base rule.\n");
    writeFileSync(join(dir, "DECIDED.md"), "- known item\n");
    git("add", ".");
    git("commit", "-q", "-m", "config");
    git("checkout", "-q", "-b", "change");
    writeFileSync(join(dir, "RULES.md"), "1. Rewritten by the change.\n");
    git("commit", "-q", "-am", "rewrite rules");
    const base = mergeBaseOf(dir, "main");
    const rules = loadRules(dir, base.sha);
    expect(rules).toMatchObject({ ok: true, project: "Demo", decided: "- known item\n" });
    expect(rules.rules).toEqual([{ path: "RULES.md", text: "1. Base rule.\n" }]);
    git("checkout", "-q", "main");
  });

  it("is an error when the config names a missing rule file", () => {
    writeFileSync(join(dir, ".diff-review.json"), JSON.stringify({ rules: ["MISSING.md"] }));
    git("commit", "-q", "-am", "bad config");
    const base = mergeBaseOf(dir, "main");
    const rules = loadRules(dir, base.sha);
    expect(rules.ok).toBe(false);
    expect(rules.error).toContain("MISSING.md");
  });
});

describe("collectDiff", () => {
  it("holds committed, uncommitted and untracked changes", () => {
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "app.js"), "export const a = 2;\n");
    git("commit", "-q", "-am", "change a");
    writeFileSync(join(dir, "app.js"), "export const a = 3;\n");
    writeFileSync(join(dir, "new.js"), "export const b = 1;\n");
    const collected = collectDiff(dir, "main");
    expect(collected.ok).toBe(true);
    expect(collected.diff).toContain("+export const a = 2;");
    expect(collected.diff).toContain("+export const a = 3;");
    expect(collected.diff).toContain("+export const b = 1;");
  });

  it("is an error for an unknown base", () => {
    expect(collectDiff(dir, "no-such-ref").ok).toBe(false);
  });
});

describe("fixtureHashProblems", () => {
  it("passes on the shipped fixtures and catches a tampered copy", () => {
    expect(fixtureHashProblems(FIXTURES)).toEqual([]);
    const copy = mkdtempSync(join(WORK, "fixtures-"));
    for (const name of ["bad.patch", "good.patch", "fixtures.sha256"]) copyFileSync(join(FIXTURES, name), join(copy, name));
    writeFileSync(join(copy, "good.patch"), `${readFileSync(join(copy, "good.patch"), "utf8")}+tampered\n`);
    expect(fixtureHashProblems(copy)).toEqual(["good.patch does not match its hash in fixtures.sha256"]);
    rmSync(copy, { recursive: true, force: true });
  });
});

describe("CLI", () => {
  it("exits 2 with usage on an unknown argument", () => {
    const result = spawnSync("node", [resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"), "--nope"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: diff-review");
  });

  it("is an ERROR (exit 1) before any review when DIFF_REVIEW_CHUNK_CHARS is below the minimum", () => {
    const result = spawnSync("node", [resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"), "--self-test"], {
      encoding: "utf8",
      env: { ...process.env, DIFF_REVIEW_CHUNK_CHARS: "1", DIFF_REVIEW_WORKER: "/nonexistent-worker" },
    });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("DIFF_REVIEW_CHUNK_CHARS=1 is not an integer of at least 5000");
  });
});

// A --base that already contains HEAD (--base HEAD, or a branch ahead of HEAD)
// makes the collected diff empty. In blocking mode that must not turn the gate
// green with nothing reviewed: review() fails closed on zero chunks, so main()
// must let the empty diff reach it.
describe("CLI: an empty diff in blocking mode", () => {
  it("is an ERROR with a verdict.md, not exit 0", () => {
    const repo = makeRepo("empty-blocking-");
    const result = spawnSync(
      "node",
      [resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"), "--base", "HEAD"],
      {
        cwd: repo,
        encoding: "utf8",
        // The worker must never be called: there is no chunk to review.
        env: { ...process.env, DIFF_REVIEW_BLOCKING: "1", DIFF_REVIEW_WORKER: "/nonexistent-worker" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("ERROR");
    expect(result.stdout).toContain("nothing to review");
    const runs = readdirSync(join(repo, ".diff-review")).filter((name) => name !== ".gitignore").sort();
    expect(runs.length).toBe(1);
    const verdict = readFileSync(join(repo, ".diff-review", runs[0], "verdict.md"), "utf8");
    expect(verdict).toContain("ERROR");
  });
});

// git prints a path that is not valid UTF-8 C-quoted, and decoding it throws.
// That throw is a diff this tool cannot split, so the run must end in the same
// fail-closed verdict as an empty diff: an ERROR verdict.md, one ERROR line and
// a nonzero exit, never a stack trace with no verdict.
describe("CLI: a diff whose path is not UTF-8", () => {
  // Built by concatenation so the patch holds the backslash and digits git
  // prints, not an escape the test file itself would decode.
  function nonUtf8Patch(repo) {
    const path = join(repo, "bad-path.patch");
    writeFileSync(
      path,
      [
        'diff --git "a/x\\377.txt" "b/x\\377.txt"',
        "index 1111111..2222222 100644",
        '--- "a/x\\377.txt"',
        '+++ "b/x\\377.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    return path;
  }

  function run(repo, patch, blocking) {
    const env = { ...process.env, DIFF_REVIEW_WORKER: "/nonexistent-worker" };
    if (blocking) env.DIFF_REVIEW_BLOCKING = "1";
    else delete env.DIFF_REVIEW_BLOCKING;
    return spawnSync(
      "node",
      [resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"), "--diff-file", patch],
      { cwd: repo, encoding: "utf8", env },
    );
  }

  for (const blocking of [true, false]) {
    it(`ends in an ERROR verdict with a verdict.md (${blocking ? "blocking" : "advisory"})`, () => {
      const repo = makeRepo(`non-utf8-${blocking ? "blocking" : "advisory"}-`);
      const result = run(repo, nonUtf8Patch(repo), blocking);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("ERROR");
      expect(result.stdout).toContain("not UTF-8");
      expect(result.stdout).not.toContain("    at ");
      const runs = readdirSync(join(repo, ".diff-review")).filter((name) => name !== ".gitignore").sort();
      expect(runs.length).toBe(1);
      const verdict = readFileSync(join(repo, ".diff-review", runs[0], "verdict.md"), "utf8");
      expect(verdict).toContain("ERROR");
    });
  }
});

// The CLI finds its tool files from its own path, so a copy of the tool with
// its own XDG state is a complete installation. The state holds a fresh passing
// self-test record, so the one file a test removes is the only fault --status
// can report.
describe("CLI: --status requires reviewer-permissions.json", () => {
  const TOOL = resolve(import.meta.dirname, "..", "diff-review");

  function toolCopy(prefix) {
    const copy = mkdtempSync(join(WORK, prefix));
    extraDirs.push(copy);
    cpSync(TOOL, copy, { recursive: true });
    const stateHome = mkdtempSync(join(WORK, "status-state-"));
    extraDirs.push(stateHome);
    const state = join(stateHome, "diff-review");
    mkdirSync(state, { recursive: true });
    // Newer than every copied file, so freshness is not what --status reports.
    writeFileSync(
      join(state, "self-test.json"),
      `${JSON.stringify({
        at: new Date(Date.now() + 60_000).toISOString(),
        badVerdict: "FAIL",
        goodVerdict: "PASS",
        pass: true,
      })}\n`,
    );
    return { path: join(copy, "diff-review.mjs"), env: { ...process.env, XDG_STATE_HOME: stateHome } };
  }

  function runStatus(tool) {
    return spawnSync("node", [tool.path, "--status"], { encoding: "utf8", env: tool.env });
  }

  it("fails naming reviewer-permissions.json when it is missing", () => {
    const tool = toolCopy("status-missing-");
    rmSync(join(dirname(tool.path), "reviewer-permissions.json"));
    const result = runStatus(tool);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("missing");
    expect(result.stdout).toContain("reviewer-permissions.json");
  });

  it("does not report reviewer-permissions.json missing when it is present", () => {
    const tool = toolCopy("status-present-");
    const result = runStatus(tool);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("reviewer-permissions.json");
  });
});

describe("review: repo read access and chunking", () => {
  let fakeWorker;
  let previousWorker;

  beforeAll(() => {
    const fakeDir = mkdtempSync(join(WORK, "fake-worker-"));
    extraDirs.push(fakeDir);
    fakeWorker = join(fakeDir, "fake-worker.sh");
    writeFileSync(fakeWorker, FAKE_WORKER);
    chmodSync(fakeWorker, 0o755);
    previousWorker = process.env.DIFF_REVIEW_WORKER;
    process.env.DIFF_REVIEW_WORKER = fakeWorker;
  });

  afterAll(() => {
    if (previousWorker === undefined) delete process.env.DIFF_REVIEW_WORKER;
    else process.env.DIFF_REVIEW_WORKER = previousWorker;
  });

  it("lets the worker read a repo file outside the diff through its read rule (C1)", async () => {
    const repo = makeRepo("c1-");
    const result = await review({
      diff: `${fileSection("src/feature.js")}\n`,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      readRoot: repo,
    });
    expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
    const chunkDir = join(result.dir, "chunks", "1");
    const proof = readFileSync(join(chunkDir, "c1-read-proof.txt"), "utf8");
    // The worker's cwd is its chunk directory, not the repo root.
    expect(proof).toContain(`cwd=${chunkDir}`);
    expect(proof).toContain("read app.js=export const marker = 'from-repo';");
    // Without the -a read rule the worker has no repository to read.
    const oldWay = spawnSync(fakeWorker, ["-t", "600", "-d", chunkDir, "prompt"], {
      cwd: chunkDir,
      encoding: "utf8",
      env: { ...process.env, ECO_WORKER_LOG_DIR: chunkDir },
    });
    expect(oldWay.status).not.toBe(0);
  });

  it("gives the worker a read rule for the run directory when there is no repository (self-test)", async () => {
    const previous = process.env.DIFF_REVIEW_WORKER;
    const argsDir = mkdtempSync(join(WORK, "args-worker-"));
    extraDirs.push(argsDir);
    const argsWorker = join(argsDir, "args-worker.sh");
    writeFileSync(argsWorker, ARGS_WORKER);
    chmodSync(argsWorker, 0o755);
    process.env.DIFF_REVIEW_WORKER = argsWorker;
    try {
      const outDir = mkdtempSync(join(WORK, "no-root-"));
      extraDirs.push(outDir);
      const result = await review({
        diff: `${fileSection("src/feature.js")}\n`,
        base: "main",
        rules: defaultRules(),
        outDir,
        blocking: false,
      });
      expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
      const args = readFileSync(join(result.dir, "chunks", "1", "args.txt"), "utf8").split("\n");
      // The rule copies live in <run>/rules/, outside the chunk directory.
      expect(args).toContain(`Read(/${resolve(result.dir)}/**)`);
    } finally {
      process.env.DIFF_REVIEW_WORKER = previous;
    }
  });

  it("runs one worker per chunk and lists every chunk and file", async () => {
    const repo = makeRepo("chunks-");
    const diff = [
      fileSection("src/bad.js"),
      fileSection("src/good.js"),
      fileSection("docs/guide.md"),
    ].join("\n");
    const result = await review({
      diff,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      readRoot: repo,
      maxChars: 150,
    });
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.verdict).toBe("FAIL");
    expect(result.parsed.findings).toHaveLength(1);
    expect(result.parsed.findings[0].file).toBe("src/bad.js");
    const chunkDirs = readdirSync(join(result.dir, "chunks"));
    expect(chunkDirs.length).toBeGreaterThan(1);
    const markdown = readFileSync(result.verdictMd, "utf8");
    // Every verdict records its head; a direct review() call has no repo head.
    expect(markdown).toContain("- head: (unknown)");
    expect(markdown).toContain(`- chunks: ${chunkDirs.length}`);
    expect(markdown).toContain("## Chunks");
    for (const file of ["src/bad.js", "src/good.js", "docs/guide.md"])
      expect(markdown).toContain(file);
    expect(markdown).not.toContain("not covered");
  });

  it("is an ERROR when a hunk is larger than the chunk limit (F2)", async () => {
    const repo = makeRepo("oversize-");
    const added = Array.from({ length: 40 }, (_, index) => `+const value${index} = ${index};`).join("\n");
    const diff = `${fileSection("src/feature.js", [`@@ -0,0 +1,40 @@\n${added}`])}\n`;
    const result = await review({
      diff,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: true,
      readRoot: repo,
      maxChars: 150,
    });
    // The worker says PASS, but its single chunk was too big to have been read whole.
    expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
    expect(result.decision.exitCode).toBe(1);
    expect(result.decision.line).toContain("ERROR");
  });

  it("gives each worker run a timeout scaled to its chunk size", async () => {
    const repo = makeRepo("timeout-");
    const workerDir = mkdtempSync(join(WORK, "recording-worker-"));
    extraDirs.push(workerDir);
    const worker = join(workerDir, "recording-worker.sh");
    writeFileSync(worker, RECORDING_WORKER);
    chmodSync(worker, 0o755);
    const previousWorker = process.env.DIFF_REVIEW_WORKER;
    const previousTimeout = process.env.DIFF_REVIEW_TIMEOUT_SECONDS;
    process.env.DIFF_REVIEW_WORKER = worker;
    delete process.env.DIFF_REVIEW_TIMEOUT_SECONDS;
    try {
      const diff = [fileSection("src/a.js"), fileSection("src/b.js"), fileSection("src/c.js")].join("\n");
      const result = await review({
        diff,
        base: "main",
        rules: defaultRules(),
        outDir: join(repo, ".diff-review"),
        blocking: false,
        readRoot: repo,
        maxChars: 150,
      });
      expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
      const chunkDirs = readdirSync(join(result.dir, "chunks"));
      expect(chunkDirs.length).toBeGreaterThan(1);
      for (const name of chunkDirs) {
        const chunkDir = join(result.dir, "chunks", name);
        const chars = readFileSync(join(chunkDir, "diff.patch"), "utf8").length;
        // The old fixed -t 600 is now too short even for a small chunk.
        expect(Number(readFileSync(join(chunkDir, "timeout.txt"), "utf8").trim())).toBe(
          workerTimeoutSeconds(chars),
        );
      }
    } finally {
      if (previousWorker === undefined) delete process.env.DIFF_REVIEW_WORKER;
      else process.env.DIFF_REVIEW_WORKER = previousWorker;
      if (previousTimeout === undefined) delete process.env.DIFF_REVIEW_TIMEOUT_SECONDS;
      else process.env.DIFF_REVIEW_TIMEOUT_SECONDS = previousTimeout;
    }
  });

  it("finishes a --diff-file review with the repo as the worker's read root", () => {
    const repo = makeRepo("cli-");
    execFileSync("git", ["branch", "origin/main", "main"], { cwd: repo });
    writeFileSync(join(repo, "change.patch"), `${fileSection("src/bad.js")}\n`);
    const result = spawnSync(
      "node",
      [resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"), "--diff-file", "change.patch"],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, DIFF_REVIEW_WORKER: fakeWorker },
      },
    );
    // Advisory FAIL: the reviewer ran and found something, so exit 0.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("diff-review: FAIL (advisory) 1 finding");
    expect(result.stdout).toContain("verdict:");
  });

  it("is a setup ERROR naming the git failure when the repository has no HEAD", () => {
    const repo = mkdtempSync(join(WORK, "no-head-"));
    extraDirs.push(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    const result = spawnSync(
      "node",
      [resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"), "--base", "main"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git rev-parse HEAD exited");
    expect(result.stderr).toContain("ERROR report");
  });
});

// eco-worker exits 4 when any optional Bash call was refused, even after the
// worker wrote a correct verdict.json. These scripts stand in for that leg and
// append one line per attempt so a test can prove whether runWorker retried.
const BLOCKED_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' '{"verdict":"FAIL","findings":[{"file":"src/bad.js","line":1,"rule":"No stubs","why":"planted bad file"}],"untested":[]}' > "$out/verdict.json"
printf '# Refused tool calls in run old\\n- NOT ALLOWED Bash: old-command\\n' > "$out/old.blocked.md"
touch -d '2000-01-01' "$out/old.blocked.md"
printf '# Refused tool calls in run new\\nRules line.\\n- NOT ALLOWED Bash: git log --all\\n- DENIED Bash: gh pr view\\n' > "$out/new.blocked.md"
touch -d '2020-01-01' "$out/new.blocked.md"
exit 4
`;

// A blocked leg whose newest *.blocked.md is a directory: reading it fails, and
// the review must say so rather than printing "None.".
const BLOCKED_UNREADABLE_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' '{"verdict":"FAIL","findings":[{"file":"src/bad.js","line":1,"rule":"No stubs","why":"planted bad file"}],"untested":[]}' > "$out/verdict.json"
mkdir "$out/run-x.blocked.md"
touch -d '2030-01-01' "$out/run-x.blocked.md"
exit 4
`;

// A blocked leg whose newest *.blocked.md is readable but has no "- " line: the
// review must say it lists no refused call rather than printing "None.".
const BLOCKED_EMPTY_FILE_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' '{"verdict":"FAIL","findings":[{"file":"src/bad.js","line":1,"rule":"No stubs","why":"planted bad file"}],"untested":[]}' > "$out/verdict.json"
printf '# Refused tool calls in run x\\nRules line.\\n' > "$out/run-x.blocked.md"
touch -d '2030-01-01' "$out/run-x.blocked.md"
exit 4
`;

const BLOCKED_NO_VERDICT_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '# Refused tool calls\\n- NOT ALLOWED Bash: blocked-cmd\\n' > "$out/run-$RANDOM.blocked.md"
exit 4
`;

const TIMEOUT_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
exit 124
`;

// Records its arguments, one per line, and passes.
const ARGS_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf '%s\\n' "$@" > "$out/args.txt"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

// Records the permissions file it was given, then edits the repository it may
// only read: the review must see the change and refuse the PASS.
const REPO_WRITER_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' "\${ECO_WORKER_PERMISSIONS:-}" > "$out/permissions.txt"
root=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-a" ]; then root="\${arg#Read(/}"; root="\${root%/\\*\\*)}"; fi
  prev="$arg"
done
printf 'tampered\\n' >> "$root/app.js"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

const EXIT_ONE_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
exit 1
`;

describe("review: a blocked worker (exit 4)", () => {
  let scriptsDir;
  let previousWorker;

  function script(name, body) {
    const path = join(scriptsDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  async function runReview(worker) {
    process.env.DIFF_REVIEW_WORKER = worker;
    const repo = makeRepo("blocked-");
    return await review({
      diff: `${fileSection("src/bad.js")}\n`,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      readRoot: repo,
    });
  }

  /** How many times the fake worker ran in this review. */
  function attempts(result) {
    return readFileSync(join(result.dir, "chunks", "1", "attempts"), "utf8").trim().split("\n").length;
  }

  beforeAll(() => {
    scriptsDir = mkdtempSync(join(WORK, "blocked-workers-"));
    extraDirs.push(scriptsDir);
    previousWorker = process.env.DIFF_REVIEW_WORKER;
  });

  afterAll(() => {
    if (previousWorker === undefined) delete process.env.DIFF_REVIEW_WORKER;
    else process.env.DIFF_REVIEW_WORKER = previousWorker;
  });

  it("is an ERROR on exit 4 even with a valid verdict.json, not retried, refused calls listed", async () => {
    const result = await runReview(script("blocked-ok.sh", BLOCKED_WORKER));
    // A blocked review is not a review: its verdict.json is not used.
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("exited 4 (blocked)");
    expect(attempts(result)).toBe(1);
    const markdown = readFileSync(result.verdictMd, "utf8");
    expect(markdown).toContain("## ERROR");
    expect(markdown).not.toMatch(/^- verdict: (PASS|FAIL)/m);
    expect(markdown).toContain("git log --all");
    expect(markdown).toContain("gh pr view");
    // Only the newest *.blocked.md is carried.
    expect(markdown).not.toContain("old-command");
  });

  it("is an ERROR when exit 4 leaves no verdict, not retried", async () => {
    const result = await runReview(script("blocked-empty.sh", BLOCKED_NO_VERDICT_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("exited 4 (blocked)");
    expect(attempts(result)).toBe(1);
    expect(readFileSync(result.verdictMd, "utf8")).toContain("## ERROR");
  });

  it("reports an unreadable blocked.md instead of listing no refused calls", async () => {
    const result = await runReview(script("blocked-unreadable.sh", BLOCKED_UNREADABLE_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("exited 4 (blocked)");
    expect(attempts(result)).toBe(1);
    expect(JSON.parse(readFileSync(join(result.dir, "verdict.json"), "utf8")).verdict).toBe("ERROR");
    const markdown = readFileSync(result.verdictMd, "utf8");
    const section = markdown.slice(markdown.indexOf("## Untested / refused calls"));
    expect(section).not.toContain("None.");
    expect(section).toContain("could not read");
  });

  it("reports a blocked.md with no refused-call line instead of listing none", async () => {
    const result = await runReview(script("blocked-empty-file.sh", BLOCKED_EMPTY_FILE_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("exited 4 (blocked)");
    expect(attempts(result)).toBe(1);
    expect(JSON.parse(readFileSync(join(result.dir, "verdict.json"), "utf8")).verdict).toBe("ERROR");
    const markdown = readFileSync(result.verdictMd, "utf8");
    const section = markdown.slice(markdown.indexOf("## Untested / refused calls"));
    expect(section).not.toContain("None.");
    expect(section).toContain("lists no refused call");
  });

  it("is an ERROR on exit 124 (timeout), not retried, and verdict.json says ERROR", async () => {
    const result = await runReview(script("timeout.sh", TIMEOUT_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toMatch(/timed out \(exit 124: the \d+s limit or eco-worker's stall watchdog; its log says which\); not retried/);
    expect(attempts(result)).toBe(1);
    const top = JSON.parse(readFileSync(join(result.dir, "verdict.json"), "utf8"));
    expect(top.verdict).toBe("ERROR");
    expect(top.error).toContain("exit 124");
  });

  it("writes ERROR into the run's verdict.json on exit 4, so no reader sees a PASS", async () => {
    const result = await runReview(script("blocked-top.sh", BLOCKED_WORKER));
    const top = JSON.parse(readFileSync(join(result.dir, "verdict.json"), "utf8"));
    expect(top).toMatchObject({ verdict: "ERROR", base: "main", findings: [] });
    expect(top.error).toContain("exited 4 (blocked)");
  });

  it("is an ERROR when the worker changes the repository, and runs it under the reviewer permissions", async () => {
    const result = await runReview(script("repo-writer.sh", REPO_WRITER_WORKER));
    expect(readFileSync(join(result.dir, "chunks", "1", "permissions.txt"), "utf8").trim()).toBe(REVIEWER_PERMISSIONS);
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("the reviewer changed the repository");
    expect(JSON.parse(readFileSync(join(result.dir, "verdict.json"), "utf8")).verdict).toBe("ERROR");
  });

  it("is an ERROR, with no worker run, when the repository state cannot be recorded first", async () => {
    process.env.DIFF_REVIEW_WORKER = script("never.sh", REPO_WRITER_WORKER);
    // WORK sits inside this repo, so a broken .git link is what makes git fail here.
    const notRepo = mkdtempSync(join(WORK, "not-repo-"));
    extraDirs.push(notRepo);
    writeFileSync(join(notRepo, ".git"), "gitdir: ./missing\n");
    const result = await review({
      diff: `${fileSection("src/bad.js")}\n`,
      base: "main",
      rules: defaultRules(),
      outDir: join(notRepo, ".diff-review"),
      blocking: false,
      readRoot: notRepo,
    });
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("could not record the repository state");
    expect(existsSync(join(result.dir, "chunks", "1", "attempts"))).toBe(false);
    expect(JSON.parse(readFileSync(join(result.dir, "verdict.json"), "utf8")).verdict).toBe("ERROR");
  });

  it("is an ERROR on exit 1, after retrying", async () => {
    const result = await runReview(script("exit-one.sh", EXIT_ONE_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("exited 1 twice");
    expect(attempts(result)).toBe(2);
  });
});

// An unreadable log must not read as "no rejection": the chunk is an ERROR that
// names the path and the error, instead of a retried generic failure.
const UNREADABLE_LOG_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
mkdir "$out/run.log"
exit 1
`;

const MISSING_LOG_DIR_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
rm -rf "$out"
exit 1
`;

describe("review: unreadable worker logs", () => {
  let scriptsDir;
  let previousWorker;

  function script(name, body) {
    const path = join(scriptsDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  async function runReview(worker, { diff = `${fileSection("src/bad.js")}\n`, maxChars } = {}) {
    process.env.DIFF_REVIEW_WORKER = worker;
    const repo = makeRepo("unreadable-log-");
    return await review({
      diff,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      readRoot: repo,
      ...(maxChars === undefined ? {} : { maxChars }),
    });
  }

  beforeAll(() => {
    scriptsDir = mkdtempSync(join(WORK, "unreadable-log-workers-"));
    extraDirs.push(scriptsDir);
    previousWorker = process.env.DIFF_REVIEW_WORKER;
  });

  afterAll(() => {
    if (previousWorker === undefined) delete process.env.DIFF_REVIEW_WORKER;
    else process.env.DIFF_REVIEW_WORKER = previousWorker;
  });

  it("is an ERROR naming a log file that cannot be read", async () => {
    const result = await runReview(script("dir-log.sh", UNREADABLE_LOG_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("run.log");
    expect(result.parsed.error).toContain("EISDIR");
  });

  it("is an ERROR naming a log directory that cannot be listed", async () => {
    // Two chunks, so the worker's log dir is a chunk dir and not the run dir
    // that review still needs for verdict.md.
    const diff = ["src/aaa.js", "src/zzz.js"].map((path) => fileSection(path)).join("\n");
    const result = await runReview(script("no-dir.sh", MISSING_LOG_DIR_WORKER), { diff, maxChars: 150 });
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("could not read the worker logs in");
    expect(result.parsed.error).toContain("ENOENT");
  });
});

// A 429 ends the review: the chunk that saw it is not retried and no later chunk
// starts. The second chunk is slow so the cancellation is observable.
const RATE_LIMIT_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
for last in "$@"; do :; done
prompt="$last"
if printf '%s' "$prompt" | grep -q 'src/aaa.js'; then
  printf '%s\\n' '{"type":"system","subtype":"api_retry","error_status":429,"error":{"type":"rate_limit_error","message":"slow down please"}}' > "$out/run.log"
  exit 1
fi
sleep 5
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

const TURN_CAP_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' '{"type":"result","subtype":"error_max_turns","is_error":true}' > "$out/run.log"
exit 1
`;

const TURN_CAP_WITH_VERDICT_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
printf '%s\\n' '{"type":"result","subtype":"error_max_turns","is_error":true}' > "$out/run.log"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
exit 1
`;

const ENV_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf '%s\\n%s\\n' "\${ECO_WORKER_MAX_TURNS:-}" "\${ECO_WORKER_NO_RETRY_429:-}" > "$out/env.txt"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

// Needs one turn per 1000 characters of its chunk, as a real reviewer roughly does
// (a 52K chunk needed more than 40 turns). Hits the cap like eco-worker does.
const TURN_NEED_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
printf 'x\\n' >> "$out/attempts"
bytes=$(wc -c < "$out/diff.patch")
need=$(( (bytes + 999) / 1000 ))
if [ "$need" -gt "\${ECO_WORKER_MAX_TURNS:?ECO_WORKER_MAX_TURNS missing}" ]; then
  printf '%s\\n' '{"type":"result","subtype":"error_max_turns","is_error":true}' > "$out/run.log"
  exit 1
fi
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

describe("review: quota guards", () => {
  let scriptsDir;
  let previousWorker;

  function script(name, body) {
    const path = join(scriptsDir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  }

  function attemptsIn(result, chunk) {
    const path = join(result.dir, "chunks", String(chunk), "attempts");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").length : 0;
  }

  function threeFiles() {
    return ["src/aaa.js", "src/mmm.js", "src/zzz.js"].map((path) => fileSection(path)).join("\n");
  }

  beforeAll(() => {
    scriptsDir = mkdtempSync(join(WORK, "quota-workers-"));
    extraDirs.push(scriptsDir);
    previousWorker = process.env.DIFF_REVIEW_WORKER;
  });

  afterAll(() => {
    if (previousWorker === undefined) delete process.env.DIFF_REVIEW_WORKER;
    else process.env.DIFF_REVIEW_WORKER = previousWorker;
  });

  it("stops on 429, does not retry, and starts no further chunks", async () => {
    process.env.DIFF_REVIEW_WORKER = script("rate-limit.sh", RATE_LIMIT_WORKER);
    const previousConcurrency = process.env.DIFF_REVIEW_CONCURRENCY;
    delete process.env.DIFF_REVIEW_CONCURRENCY;
    try {
      const repo = makeRepo("rate-limit-");
      const result = await review({
        diff: threeFiles(),
        base: "main",
        rules: defaultRules(),
        outDir: join(repo, ".diff-review"),
        blocking: false,
        readRoot: repo,
        maxChars: 150,
      });
      expect(result.parsed.ok).toBe(false);
      expect(result.parsed.error).toContain("ERROR: rate limited (429) in chunk 1");
      expect(result.parsed.error).toContain("slow down please");
      // The chunk that saw the 429 ran once; the retry would spend more quota.
      expect(attemptsIn(result, 1)).toBe(1);
      // Two chunks were in flight; the third never started.
      expect(attemptsIn(result, 3)).toBe(0);
      const markdown = readFileSync(result.verdictMd, "utf8");
      expect(markdown).toContain("ERROR: rate limited (429)");
      expect(markdown).toContain("slow down please");
    } finally {
      if (previousConcurrency === undefined) delete process.env.DIFF_REVIEW_CONCURRENCY;
      else process.env.DIFF_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });

  it("makes a turn-capped chunk without a verdict an ERROR, without retrying", async () => {
    process.env.DIFF_REVIEW_WORKER = script("turn-cap.sh", TURN_CAP_WORKER);
    const repo = makeRepo("turn-cap-");
    const result = await review({
      diff: `${fileSection("src/bad.js")}\n`,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      readRoot: repo,
    });
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("turn cap");
    expect(attemptsIn(result, 1)).toBe(1);
    expect(readFileSync(result.verdictMd, "utf8")).toContain("## ERROR");
  });

  it("accepts a valid verdict even when the turn cap was reached", async () => {
    process.env.DIFF_REVIEW_WORKER = script("turn-cap-verdict.sh", TURN_CAP_WITH_VERDICT_WORKER);
    const repo = makeRepo("turn-cap-verdict-");
    const result = await review({
      diff: `${fileSection("src/good.js")}\n`,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      readRoot: repo,
    });
    expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
    expect(readFileSync(result.verdictMd, "utf8")).toContain("turn cap reached, but verdict.json is valid");
  });

  describe("a 52K chunk (planted: the old fixed 40-turn cap)", () => {
    // 52 hunks of about 1000 characters in one file: one chunk of about 52K.
    function bigDiff() {
      const hunks = Array.from(
        { length: 52 },
        (_, i) => `@@ -${i * 2 + 1} +${i * 2 + 1} @@\n-a\n+${"x".repeat(960)}`,
      );
      return `${fileSection("src/big.js", hunks)}\n`;
    }

    async function run(prefix, extra) {
      process.env.DIFF_REVIEW_WORKER = script("turn-need.sh", TURN_NEED_WORKER);
      const repo = makeRepo(prefix);
      return review({
        diff: bigDiff(),
        base: "main",
        rules: defaultRules(),
        outDir: join(repo, ".diff-review"),
        blocking: false,
        readRoot: repo,
        ...extra,
      });
    }

    it("is an ERROR under the old settings (one 60K chunk, fixed cap of 40)", async () => {
      process.env.DIFF_REVIEW_MAX_TURNS = "40";
      try {
        const result = await run("old-settings-", { maxChars: 60000 });
        expect(bigDiff().length).toBeGreaterThan(50000);
        expect(result.parsed.ok).toBe(false);
        expect(readFileSync(result.verdictMd, "utf8")).toContain("## ERROR");
      } finally {
        delete process.env.DIFF_REVIEW_MAX_TURNS;
      }
    });

    it("passes with the new settings on the same single chunk (derived cap)", async () => {
      delete process.env.DIFF_REVIEW_MAX_TURNS;
      const result = await run("new-cap-", { maxChars: 60000 });
      expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
    });

    it("passes with the default chunk size, split into several chunks", async () => {
      delete process.env.DIFF_REVIEW_MAX_TURNS;
      delete process.env.DIFF_REVIEW_CHUNK_CHARS;
      const result = await run("new-default-", {});
      expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
      expect(existsSync(join(result.dir, "chunks", "2"))).toBe(true);
    });
  });

  it("passes the turn cap and no-retry-429 settings to the worker, with env overrides", async () => {
    const worker = script("env.sh", ENV_WORKER);
    process.env.DIFF_REVIEW_WORKER = worker;
    const previousTurns = process.env.DIFF_REVIEW_MAX_TURNS;
    const previousNoRetry = process.env.ECO_WORKER_NO_RETRY_429;
    const repo = makeRepo("env-worker-");
    const diff = `${fileSection("src/good.js")}\n`;
    try {
      delete process.env.DIFF_REVIEW_MAX_TURNS;
      delete process.env.ECO_WORKER_NO_RETRY_429;
      let result = await review({
        diff,
        base: "main",
        rules: defaultRules(),
        outDir: join(repo, ".diff-review"),
        blocking: false,
        readRoot: repo,
      });
      expect(readFileSync(join(result.dir, "chunks", "1", "env.txt"), "utf8").trim().split("\n")).toEqual(["41", "1"]);

      process.env.DIFF_REVIEW_MAX_TURNS = "7";
      process.env.ECO_WORKER_NO_RETRY_429 = "0";
      result = await review({
        diff,
        base: "main",
        rules: defaultRules(),
        outDir: join(repo, ".diff-review"),
        blocking: false,
        readRoot: repo,
      });
      expect(readFileSync(join(result.dir, "chunks", "1", "env.txt"), "utf8").trim().split("\n")).toEqual(["7", "0"]);
    } finally {
      if (previousTurns === undefined) delete process.env.DIFF_REVIEW_MAX_TURNS;
      else process.env.DIFF_REVIEW_MAX_TURNS = previousTurns;
      if (previousNoRetry === undefined) delete process.env.ECO_WORKER_NO_RETRY_429;
      else process.env.ECO_WORKER_NO_RETRY_429 = previousNoRetry;
    }
  });
});

/** A verdict.md as renderVerdictMarkdown writes it, for delta fixtures. */
function earlierVerdict({ head, result = "PASS", covered = [], findings = [] }) {
  return [
    `# diff-review: ${result} (advisory) second reader, never acceptance`,
    "",
    "- at: 2000-01-01T00:00:00.000Z",
    `- head: ${head}`,
    "- base: main",
    "- chunks: 1",
    "",
    `## Files covered (${covered.length})`,
    "",
    ...(covered.length === 0 ? ["None."] : covered.map((file) => `- ${file} (chunk 1)`)),
    "",
    "## Findings",
    "",
    ...(findings.length === 0
      ? ["None."]
      : findings.map(
          (finding) =>
            `- \`${finding.file}:${finding.line ?? "-"}\` ${finding.rule}${finding.why === undefined ? "" : ` — ${finding.why}`}`,
        )),
    "",
  ].join("\n");
}

describe("prepareDelta", () => {
  it("collects only the changes since the earlier head and reads its coverage", () => {
    const repo = makeRepo("delta-prep-");
    writeFileSync(join(repo, "src-one.js"), "export const one = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    const earlierHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "src-one.js"), "export const one = 2;\n");
    writeFileSync(join(repo, "src-two.js"), "export const two = 1;\n");
    execFileSync("git", ["commit", "-q", "-am", "two"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const verdictDir = mkdtempSync(join(WORK, "delta-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "verdict.md");
    writeFileSync(
      earlierPath,
      earlierVerdict({ head: earlierHead, covered: ["src-one.js", "src-old.js"] }),
    );
    const prepared = prepareDelta(repo, earlierPath, head);
    expect(prepared.ok).toBe(true);
    expect(prepared.earlier.head).toBe(earlierHead);
    expect(prepared.earlier.result).toBe("PASS");
    expect(prepared.earlier.coveredFiles).toEqual(["src-one.js", "src-old.js"]);
    expect(prepared.diff).toContain("src-one.js");
    expect(prepared.diff).toContain("src-two.js");
    expect(prepared.diff).not.toContain("src-old.js");
  });

  it("refuses an ERROR verdict", () => {
    const repo = makeRepo("delta-error-");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const verdictDir = mkdtempSync(join(WORK, "delta-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "verdict.md");
    writeFileSync(earlierPath, earlierVerdict({ head, result: "ERROR" }));
    const prepared = prepareDelta(repo, earlierPath, head);
    expect(prepared.ok).toBe(false);
    expect(prepared.error).toContain("ERROR verdict");
  });

  it("refuses a head that is not an ancestor of HEAD", () => {
    const repo = makeRepo("delta-side-");
    execFileSync("git", ["checkout", "-q", "-b", "side"], { cwd: repo });
    writeFileSync(join(repo, "side.js"), "export const side = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "side"], { cwd: repo });
    const sideHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
    writeFileSync(join(repo, "main.js"), "export const main = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "main"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const verdictDir = mkdtempSync(join(WORK, "delta-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "verdict.md");
    writeFileSync(earlierPath, earlierVerdict({ head: sideHead }));
    const prepared = prepareDelta(repo, earlierPath, head);
    expect(prepared.ok).toBe(false);
    expect(prepared.error).toContain("not an ancestor");
  });

  it("refuses a missing verdict file", () => {
    const repo = makeRepo("delta-missing-");
    expect(prepareDelta(repo, join(repo, "nope.md"), "a".repeat(40)).ok).toBe(false);
  });
});

describe("CLI: delta mode", () => {
  const PROMPT_WORKER = `#!/usr/bin/env bash
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
for last in "$@"; do task="$last"; done
printf '%s\\n' "$task" > "$out/prompt.txt"
printf '%s\\n' '{"verdict":"PASS","findings":[],"untested":[]}' > "$out/verdict.json"
`;

  let worker;
  let scriptsDir;

  function latestVerdict(repo) {
    const runs = readdirSync(join(repo, ".diff-review")).filter((name) => name !== ".gitignore").sort();
    return join(repo, ".diff-review", runs[runs.length - 1], "verdict.md");
  }

  function deltaRepo(prefix) {
    const repo = makeRepo(prefix);
    execFileSync("git", ["branch", "origin/main", "main"], { cwd: repo });
    writeFileSync(join(repo, "one.js"), "export const one = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    const earlierHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    writeFileSync(join(repo, "one.js"), "export const one = 2;\n");
    writeFileSync(join(repo, "two.js"), "export const two = 1;\n");
    execFileSync("git", ["commit", "-q", "-am", "two"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    return { repo, earlierHead, head };
  }

  function runCli(repo, earlierPath) {
    return spawnSync(
      "node",
      [
        resolve(import.meta.dirname, "..", "diff-review", "diff-review.mjs"),
        "--base",
        "main",
        "--since-verdict",
        earlierPath,
      ],
      { cwd: repo, encoding: "utf8", env: { ...process.env, DIFF_REVIEW_WORKER: worker } },
    );
  }

  beforeAll(() => {
    scriptsDir = mkdtempSync(join(WORK, "delta-cli-worker-"));
    extraDirs.push(scriptsDir);
    worker = join(scriptsDir, "prompt-worker.sh");
    writeFileSync(worker, PROMPT_WORKER);
    chmodSync(worker, 0o755);
  });

  it("writes the head, the delta line and the unchanged files, and reviews only the delta", () => {
    const { repo, earlierHead, head } = deltaRepo("delta-cli-");
    const verdictDir = mkdtempSync(join(WORK, "delta-cli-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "earlier.md");
    writeFileSync(
      earlierPath,
      earlierVerdict({ head: earlierHead, covered: ["one.js", "old.js"] }),
    );
    const result = runCli(repo, earlierPath);
    expect(result.status).toBe(0);
    const markdown = readFileSync(latestVerdict(repo), "utf8");
    expect(markdown).toContain(`- head: ${head}`);
    expect(markdown).toContain("- base: main");
    expect(markdown).toContain(
      `- delta since ${earlierHead}, earlier verdict ${resolve(earlierPath)} (PASS)`,
    );
    expect(markdown).toContain("## Files unchanged since");
    expect(markdown).toContain("- old.js");
    // The reviewer saw only the delta; the unchanged file is not in its prompt.
    const prompt = readFileSync(
      join(repo, ".diff-review", readdirSync(join(repo, ".diff-review")).filter((n) => n !== ".gitignore").sort().pop(), "chunks", "1", "prompt.txt"),
      "utf8",
    );
    expect(prompt).toContain("delta review since");
    expect(prompt).toContain("one.js");
    expect(prompt).toContain("two.js");
    expect(prompt).not.toContain("old.js");
  });

  it("is FAIL overall when an earlier finding's file was not re-reviewed", () => {
    const { repo, earlierHead } = deltaRepo("delta-cli-fail-");
    const verdictDir = mkdtempSync(join(WORK, "delta-cli-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "earlier.md");
    writeFileSync(
      earlierPath,
      earlierVerdict({
        head: earlierHead,
        result: "FAIL",
        covered: ["one.js", "old.js"],
        findings: [{ file: "old.js", line: 4, rule: "No stubs", why: "left a stub" }],
      }),
    );
    const result = runCli(repo, earlierPath);
    // The delta itself is clean, but the earlier finding was not re-reviewed.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("diff-review: FAIL (advisory) 1 finding");
    expect(readFileSync(latestVerdict(repo), "utf8")).toContain("left a stub");
  });

  it("refuses an ERROR earlier verdict with a non-zero exit", () => {
    const { repo, earlierHead } = deltaRepo("delta-cli-error-");
    const verdictDir = mkdtempSync(join(WORK, "delta-cli-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "earlier.md");
    writeFileSync(earlierPath, earlierVerdict({ head: earlierHead, result: "ERROR" }));
    const result = runCli(repo, earlierPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERROR verdict");
  });

  it("is an ERROR at an unchanged head instead of a PASS over zero chunks", () => {
    // Everything committed: the tree at HEAD is exactly the tree the verdict covers.
    const repo = makeRepo("delta-cli-same-");
    writeFileSync(join(repo, "one.js"), "export const one = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const verdictDir = mkdtempSync(join(WORK, "delta-cli-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "earlier.md");
    writeFileSync(earlierPath, earlierVerdict({ head, covered: ["one.js"] }));
    const result = runCli(repo, earlierPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`nothing changed since the earlier verdict at ${head}`);
    expect(result.stderr).toContain("reuse that verdict instead of a new one");
  });

  it("names the earlier verdict's head, not a new empty-commit HEAD, when the delta is empty", () => {
    const repo = makeRepo("delta-cli-empty-");
    writeFileSync(join(repo, "one.js"), "export const one = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    const earlierHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    // An empty commit moves HEAD without changing the tree the verdict covers.
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "empty"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    expect(head).not.toBe(earlierHead);
    const verdictDir = mkdtempSync(join(WORK, "delta-cli-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "earlier.md");
    writeFileSync(earlierPath, earlierVerdict({ head: earlierHead, covered: ["one.js"] }));
    const result = runCli(repo, earlierPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`nothing changed since the earlier verdict at ${earlierHead}`);
    expect(result.stderr).not.toContain(head);
  });

  it("carries a why-less earlier finding without inventing a reason", () => {
    const { repo, earlierHead } = deltaRepo("delta-cli-nowhy-");
    const verdictDir = mkdtempSync(join(WORK, "delta-cli-verdict-"));
    extraDirs.push(verdictDir);
    const earlierPath = join(verdictDir, "earlier.md");
    writeFileSync(
      earlierPath,
      earlierVerdict({
        head: earlierHead,
        result: "FAIL",
        covered: ["one.js", "old.js"],
        findings: [{ file: "old.js", line: 4, rule: "No stubs" }],
      }),
    );
    const result = runCli(repo, earlierPath);
    expect(result.status).toBe(0);
    const markdown = readFileSync(latestVerdict(repo), "utf8");
    expect(markdown).toContain("- `old.js:4` No stubs\n");
    expect(markdown).not.toContain("carried from the earlier verdict");
    expect(markdown).not.toContain("No stubs — ");
  });
});

describe("repoState", () => {
  it("changes when an already-modified or an untracked file is edited again", () => {
    const repo = makeRepo("state-");
    writeFileSync(join(repo, "app.js"), "export const marker = 'edited-once';\n");
    writeFileSync(join(repo, "notes.txt"), "first\n");
    const before = repoState(repo);
    expect(before.ok).toBe(true);
    // git status stays " M app.js" and "?? notes.txt"; only the contents move.
    writeFileSync(join(repo, "app.js"), "export const marker = 'edited-twice';\n");
    const afterTracked = repoState(repo);
    expect(afterTracked.ok).toBe(true);
    expect(afterTracked.state).not.toBe(before.state);
    writeFileSync(join(repo, "notes.txt"), "second\n");
    const afterUntracked = repoState(repo);
    expect(afterUntracked.state).not.toBe(afterTracked.state);
    expect(repoState(repo).state).toBe(afterUntracked.state);
  });

  it("records an untracked symlink to a directory by its target instead of failing", () => {
    const repo = makeRepo("state-link-");
    mkdirSync(join(repo, "real"));
    symlinkSync("real", join(repo, "link"));
    const before = repoState(repo);
    expect(before.ok).toBe(true);
    rmSync(join(repo, "link"));
    symlinkSync("elsewhere", join(repo, "link"));
    expect(repoState(repo).state).not.toBe(before.state);
  });

  it("records an untracked nested repository by name instead of failing", () => {
    const repo = makeRepo("state-nested-");
    mkdirSync(join(repo, "inner"));
    execFileSync("git", ["init", "-q"], { cwd: join(repo, "inner") });
    writeFileSync(join(repo, "inner", "a.txt"), "a\n");
    const before = repoState(repo);
    expect(before.ok).toBe(true);
    expect(before.state).toContain("?? inner/");
  });

  it("is not ok where git cannot read the repository", () => {
    const notRepo = mkdtempSync(join(WORK, "state-none-"));
    extraDirs.push(notRepo);
    writeFileSync(join(notRepo, ".git"), "gitdir: ./missing\n");
    expect(repoState(notRepo).ok).toBe(false);
  });
});

describe("loadReviewerCommands", () => {
  it("lists the shipped file's commands", () => {
    const loaded = loadReviewerCommands();
    expect(loaded.ok).toBe(true);
    expect(loaded.commands).toContain("git diff");
  });

  it("is not ok for a missing, unparsable or allow-less permissions file", () => {
    const dir = mkdtempSync(join(WORK, "perms-"));
    extraDirs.push(dir);
    const missing = loadReviewerCommands(join(dir, "missing.json"));
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("could not read");
    writeFileSync(join(dir, "broken.json"), "{");
    expect(loadReviewerCommands(join(dir, "broken.json")).ok).toBe(false);
    writeFileSync(join(dir, "empty.json"), "{}");
    const empty = loadReviewerCommands(join(dir, "empty.json"));
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("no permissions.allow list");
  });
});
