import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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

// Proves where the worker runs: it reads ./app.js, a repo file outside the diff,
// and writes its verdict to the run directory. The old spawn used the run
// directory as cwd, where app.js does not exist.
const FAKE_WORKER = `#!/usr/bin/env bash
set -euo pipefail
out="\${ECO_WORKER_LOG_DIR:?ECO_WORKER_LOG_DIR missing}"
for last in "$@"; do :; done
prompt="$last"
value="$(cat app.js)"
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

  it("runs the worker in the repo root so it can read a file outside the diff (C1)", async () => {
    const repo = makeRepo("c1-");
    const result = await review({
      diff: `${fileSection("src/feature.js")}\n`,
      base: "main",
      rules: defaultRules(),
      outDir: join(repo, ".diff-review"),
      blocking: false,
      workdir: repo,
    });
    expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
    const proof = readFileSync(join(result.dir, "c1-read-proof.txt"), "utf8");
    expect(proof).toContain(`cwd=${repo}`);
    expect(proof).toContain("read app.js=export const marker = 'from-repo';");
    // The old spawn put cwd at the run directory; app.js is not there.
    const oldWay = spawnSync(fakeWorker, ["-t", "600", "-d", result.dir, "prompt"], {
      cwd: result.dir,
      encoding: "utf8",
      env: { ...process.env, ECO_WORKER_LOG_DIR: result.dir },
    });
    expect(oldWay.status).not.toBe(0);
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
      workdir: repo,
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
      workdir: repo,
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
        workdir: repo,
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

  it("finishes a --diff-file review with the repo as the worker cwd", () => {
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
      workdir: repo,
    });
  }

  /** How many times the fake worker ran in this review. */
  function attempts(result) {
    return readFileSync(join(result.dir, "attempts"), "utf8").trim().split("\n").length;
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

  it("accepts exit 4 when verdict.json is valid and lists the newest refused calls", async () => {
    const result = await runReview(script("blocked-ok.sh", BLOCKED_WORKER));
    expect(result.parsed).toMatchObject({ ok: true, verdict: "FAIL" });
    // Accepted on the first run: exit 4 with a verdict is not a failed review.
    expect(attempts(result)).toBe(1);
    const markdown = readFileSync(result.verdictMd, "utf8");
    expect(markdown).toContain("exit 4 (blocked): refused calls listed");
    expect(markdown).toContain("## Untested / refused calls");
    expect(markdown).toContain("git log --all");
    expect(markdown).toContain("gh pr view");
    // Only the newest *.blocked.md is carried.
    expect(markdown).not.toContain("old-command");
  });

  it("reports an unreadable blocked.md instead of listing no refused calls", async () => {
    const result = await runReview(script("blocked-unreadable.sh", BLOCKED_UNREADABLE_WORKER));
    expect(result.parsed).toMatchObject({ ok: true, verdict: "FAIL" });
    expect(attempts(result)).toBe(1);
    const markdown = readFileSync(result.verdictMd, "utf8");
    const section = markdown.slice(markdown.indexOf("## Untested / refused calls"));
    expect(section).not.toContain("None.");
    expect(section).toContain("could not read");
  });

  it("reports a blocked.md with no refused-call line instead of listing none", async () => {
    const result = await runReview(script("blocked-empty-file.sh", BLOCKED_EMPTY_FILE_WORKER));
    expect(result.parsed).toMatchObject({ ok: true, verdict: "FAIL" });
    expect(attempts(result)).toBe(1);
    const markdown = readFileSync(result.verdictMd, "utf8");
    const section = markdown.slice(markdown.indexOf("## Untested / refused calls"));
    expect(section).not.toContain("None.");
    expect(section).toContain("lists no refused call");
  });

  it("is an ERROR when exit 4 leaves no verdict, after retrying", async () => {
    const result = await runReview(script("blocked-empty.sh", BLOCKED_NO_VERDICT_WORKER));
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.error).toContain("exited 4 (blocked) twice");
    expect(attempts(result)).toBe(2);
    expect(readFileSync(result.verdictMd, "utf8")).toContain("## ERROR");
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
      workdir: repo,
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
    // A single-chunk review keeps its files in the run directory, not chunks/<n>.
    const path = join(result.dir, "chunks", String(chunk), "attempts");
    const single = join(result.dir, "attempts");
    const attempts = existsSync(path) ? path : existsSync(single) ? single : null;
    return attempts === null ? 0 : readFileSync(attempts, "utf8").trim().split("\n").length;
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
        workdir: repo,
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
      workdir: repo,
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
      workdir: repo,
    });
    expect(result.parsed).toMatchObject({ ok: true, verdict: "PASS" });
    expect(readFileSync(result.verdictMd, "utf8")).toContain("turn cap reached, but verdict.json is valid");
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
        workdir: repo,
      });
      expect(readFileSync(join(result.dir, "env.txt"), "utf8").trim().split("\n")).toEqual(["40", "1"]);

      process.env.DIFF_REVIEW_MAX_TURNS = "7";
      process.env.ECO_WORKER_NO_RETRY_429 = "0";
      result = await review({
        diff,
        base: "main",
        rules: defaultRules(),
        outDir: join(repo, ".diff-review"),
        blocking: false,
        workdir: repo,
      });
      expect(readFileSync(join(result.dir, "env.txt"), "utf8").trim().split("\n")).toEqual(["7", "0"]);
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
      join(repo, ".diff-review", readdirSync(join(repo, ".diff-review")).filter((n) => n !== ".gitignore").sort().pop(), "prompt.txt"),
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
