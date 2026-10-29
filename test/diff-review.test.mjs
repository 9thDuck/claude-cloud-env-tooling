import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURES,
  collectDiff,
  fixtureHashProblems,
  loadRules,
  mergeBaseOf,
  parseArgs,
  stateDir,
  workerCommand,
} from "../diff-review/diff-review.mjs";

const WORK = resolve(import.meta.dirname, "..", ".work");
let dir;

/** Run git in the temp repo. */
function git(...args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

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

afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
