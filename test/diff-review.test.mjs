import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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
    expect(parseArgs([], {})).toEqual({ mode: "review", base: "origin/main", diffFile: null });
  });

  it("takes the base from DIFF_REVIEW_BASE, then --base", () => {
    expect(parseArgs([], { DIFF_REVIEW_BASE: "origin/dev" })).toMatchObject({ base: "origin/dev" });
    expect(parseArgs(["--base", "main"], { DIFF_REVIEW_BASE: "origin/dev" })).toMatchObject({ base: "main" });
  });

  it("parses the modes and rejects bad arguments", () => {
    expect(parseArgs(["--self-test"], {})).toMatchObject({ mode: "self-test" });
    expect(parseArgs(["--status"], {})).toMatchObject({ mode: "status" });
    expect(parseArgs(["--diff-file", "x.patch"], {})).toMatchObject({ diffFile: "x.patch" });
    expect(parseArgs(["--base"], {})).toHaveProperty("error");
    expect(parseArgs(["--diff-file", "--status"], {})).toHaveProperty("error");
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
    expect(markdown).toContain(`- chunks: ${chunkDirs.length}`);
    expect(markdown).toContain("## Chunks");
    for (const file of ["src/bad.js", "src/good.js", "docs/guide.md"])
      expect(markdown).toContain(file);
    expect(markdown).not.toContain("not covered");
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
