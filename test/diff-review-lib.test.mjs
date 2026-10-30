import { describe, expect, it } from "vitest";

import {
  DIFF_REVIEW_CHUNK_CHARS,
  blockingFromEnv,
  buildPrompt,
  concurrencyFromEnv,
  coverageProblems,
  decide,
  fileRank,
  filesInDiff,
  mergeVerdicts,
  parseConfig,
  parseVerdict,
  ruleCopies,
  runPool,
  runsToPrune,
  splitDiff,
  splitFileSections,
  workerTimeoutSeconds,
} from "../diff-review/diff-review-lib.mjs";

const finding = { file: "src/a.js", line: 3, rule: '"No secrets" (rules.md)', why: "adds a key" };

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

describe("parseVerdict", () => {
  it("accepts a PASS with no findings", () => {
    expect(parseVerdict('{"verdict":"PASS","findings":[],"untested":[]}')).toEqual({
      ok: true,
      verdict: "PASS",
      findings: [],
      untested: [],
    });
  });

  it("accepts a FAIL with a finding", () => {
    const parsed = parseVerdict(JSON.stringify({ verdict: "FAIL", findings: [finding], untested: ["x"] }));
    expect(parsed).toEqual({ ok: true, verdict: "FAIL", findings: [finding], untested: ["x"] });
  });

  it.each([
    ["not JSON", "nope"],
    ["an array", "[]"],
    ["an unknown verdict", '{"verdict":"OK","findings":[],"untested":[]}'],
    ["missing findings", '{"verdict":"PASS","untested":[]}'],
    ["missing untested", '{"verdict":"PASS","findings":[]}'],
    ["FAIL without findings", '{"verdict":"FAIL","findings":[],"untested":[]}'],
    ["PASS with findings", JSON.stringify({ verdict: "PASS", findings: [finding], untested: [] })],
    ["a finding without a rule", JSON.stringify({ verdict: "FAIL", findings: [{ ...finding, rule: " " }], untested: [] })],
    ["a string line", JSON.stringify({ verdict: "FAIL", findings: [{ ...finding, line: "3" }], untested: [] })],
    ["a non-string untested entry", '{"verdict":"PASS","findings":[],"untested":[1]}'],
  ])("rejects %s", (_name, text) => {
    expect(parseVerdict(text).ok).toBe(false);
  });
});

describe("decide", () => {
  const pass = { ok: true, verdict: "PASS", findings: [], untested: [] };
  const fail = { ok: true, verdict: "FAIL", findings: [finding], untested: [] };

  it("exits 0 on PASS", () => {
    expect(decide({ parsed: pass, blocking: false }).exitCode).toBe(0);
    expect(decide({ parsed: pass, blocking: true }).exitCode).toBe(0);
  });

  it("exits 0 on an advisory FAIL and 1 on a blocking FAIL", () => {
    expect(decide({ parsed: fail, blocking: false })).toMatchObject({ exitCode: 0 });
    expect(decide({ parsed: fail, blocking: false }).line).toContain("FAIL (advisory) 1 finding");
    expect(decide({ parsed: fail, blocking: true })).toMatchObject({ exitCode: 1 });
  });

  it("exits 1 on an ERROR in both modes", () => {
    const parsed = { ok: false, error: "no verdict" };
    expect(decide({ parsed, blocking: false }).exitCode).toBe(1);
    expect(decide({ parsed, blocking: true }).exitCode).toBe(1);
  });

  it("refuses a PASS on a truncated diff", () => {
    const decision = decide({ parsed: pass, blocking: false, truncated: true });
    expect(decision.exitCode).toBe(1);
    expect(decision.line).toContain("ERROR");
  });
});

describe("blockingFromEnv", () => {
  it("is advisory unless DIFF_REVIEW_BLOCKING is exactly 1", () => {
    expect(blockingFromEnv({})).toBe(false);
    expect(blockingFromEnv({ DIFF_REVIEW_BLOCKING: "0" })).toBe(false);
    expect(blockingFromEnv({ DIFF_REVIEW_BLOCKING: "true" })).toBe(false);
    expect(blockingFromEnv({ DIFF_REVIEW_BLOCKING: "1" })).toBe(true);
  });
});

describe("buildPrompt", () => {
  it("names absolute rule paths, the project, the files and the chunk", () => {
    const prompt = buildPrompt({
      base: "origin/main",
      chunk: { text: "abc", files: ["src/a.js", "e2e/a.js"] },
      chunkIndex: 2,
      chunkCount: 3,
      diffPath: "/runs/1/chunks/2/diff.patch",
      verdictPath: "/runs/1/chunks/2/verdict.json",
      rulePaths: ["/runs/1/rules/1-a.md", "/runs/1/rules/2-rules.md"],
      project: "A shop",
      workdir: "/repo",
    });
    expect(prompt).toContain("- /runs/1/rules/1-a.md");
    expect(prompt).toContain("- /runs/1/rules/2-rules.md");
    expect(prompt).toContain("The project: A shop");
    expect(prompt).toContain("chunk 2 of 3");
    expect(prompt).toContain("/runs/1/chunks/2/diff.patch");
    expect(prompt).toContain("/runs/1/chunks/2/verdict.json");
    expect(prompt).toContain("Your working directory is /repo");
    expect(prompt).toContain("- src/a.js");
    expect(prompt).toContain("- e2e/a.js");
    expect(prompt).not.toContain("decided");
  });

  it("says a single diff is complete and names the decided file", () => {
    const prompt = buildPrompt({
      base: "b",
      chunk: { text: "x", files: [] },
      decided: true,
      decidedPath: "/runs/1/decided.md",
      rulePaths: ["/runs/1/rules/1-r.md"],
    });
    expect(prompt).toContain("(1 characters, complete)");
    expect(prompt).toContain("/runs/1/decided.md");
    expect(prompt).toContain("This chunk holds no file body.");
  });
});

describe("splitFileSections", () => {
  it("keeps every byte and names each file", () => {
    const diff = `${fileSection("src/a.js")}\n${fileSection("docs/b.md")}\n`;
    const sections = splitFileSections(diff);
    expect(sections.map((section) => section.path)).toEqual(["src/a.js", "docs/b.md"]);
    expect(sections.map((section) => section.text).join("\n")).toBe(diff);
    expect(filesInDiff(diff)).toEqual(["src/a.js", "docs/b.md"]);
  });

  it("does not mistake a removed line that looks like a header for a new file", () => {
    const diff = fileSection("src/a.js", ["@@ -1,2 +1,1 @@\n context\n--- not a header"]);
    expect(filesInDiff(diff)).toEqual(["src/a.js"]);
  });

  it("names a binary/rename section from the diff --git header", () => {
    const binary =
      "diff --git a/assets/logo.png b/assets/logo.png\nindex 1111111..2222222 100644\nBinary files a/assets/logo.png and b/assets/logo.png differ\n";
    expect(filesInDiff(binary)).toEqual(["assets/logo.png"]);
    const split = splitDiff(binary);
    expect(split.chunks[0].files).toEqual(["assets/logo.png"]);
    expect(coverageProblems(binary, split.chunks)).toEqual([]);
  });
});

describe("fileRank", () => {
  it("puts source and tests first, docs and beads last", () => {
    expect(fileRank("src/a.js")).toBe(0);
    expect(fileRank("e2e/flow.js")).toBe(0);
    expect(fileRank("scripts/build.mjs")).toBe(0);
    expect(fileRank("config/vite.ts")).toBe(0);
    expect(fileRank("test/a.test.js")).toBe(0);
    expect(fileRank("package.json")).toBe(1);
    expect(fileRank("docs/guide.md")).toBe(2);
    expect(fileRank(".beads/issue.md")).toBe(2);
  });
});

describe("splitDiff", () => {
  const diff = [
    fileSection("docs/guide.md"),
    fileSection("zzz/app.js"),
    fileSection("src/a.js"),
    fileSection("e2e/flow.js"),
    fileSection(".beads/issue.md"),
    fileSection("package.json"),
  ].join("\n");

  it("orders source and tests first and docs/.beads last", () => {
    const split = splitDiff(diff);
    expect(split.chunks).toHaveLength(1);
    expect(split.chunks[0].files).toEqual([
      "e2e/flow.js",
      "src/a.js",
      "package.json",
      "zzz/app.js",
      ".beads/issue.md",
      "docs/guide.md",
    ]);
    expect([...split.files].sort()).toEqual(
      ["src/a.js", "e2e/flow.js", ".beads/issue.md", "docs/guide.md", "package.json", "zzz/app.js"].sort(),
    );
  });

  it("packs whole files under the limit and covers all of them", () => {
    const split = splitDiff(diff, { maxChars: 260 });
    expect(split.chunks.length).toBeGreaterThan(1);
    for (const chunk of split.chunks) expect(chunk.text.length).toBeLessThanOrEqual(260);
    expect(coverageProblems(diff, split.chunks)).toEqual([]);
  });

  it("reports a planted dropped file as a coverage problem", () => {
    const split = splitDiff(diff, { maxChars: 260 });
    const planted = split.chunks.map((chunk) => ({
      ...chunk,
      files: chunk.files.filter((file) => file !== "src/a.js"),
    }));
    expect(coverageProblems(diff, planted)).toContain(
      "file src/a.js is in the diff but no chunk covers it",
    );
  });

  it("reports coverage when a whole chunk is dropped", () => {
    const split = splitDiff(diff, { maxChars: 260 });
    const problems = coverageProblems(diff, split.chunks.slice(1));
    expect(problems.length).toBeGreaterThan(0);
  });

  it("splits one oversized file by hunk without losing a hunk", () => {
    const hunks = Array.from(
      { length: 6 },
      (_, index) => `@@ -${index * 10 + 1},3 +${index * 10 + 1},3 @@\n context\n-old${index}\n+new${index}`,
    );
    const big = fileSection("src/big.js", hunks);
    const split = splitDiff(big, { maxChars: 230 });
    expect(split.chunks.length).toBeGreaterThan(1);
    for (const chunk of split.chunks) {
      expect(chunk.files).toEqual(["src/big.js"]);
      expect(chunk.text.startsWith("diff --git a/src/big.js b/src/big.js")).toBe(true);
    }
    const combined = split.chunks.map((chunk) => chunk.text).join("\n");
    for (let index = 0; index < hunks.length; index += 1) expect(combined).toContain(`+new${index}`);
    expect(coverageProblems(big, split.chunks)).toEqual([]);
  });

  it("cannot verify coverage when the diff has no file headers", () => {
    expect(coverageProblems("not a diff\n", splitDiff("not a diff\n").chunks)).toEqual([
      "the diff has no recognizable file headers, so file coverage cannot be verified",
    ]);
  });
});

describe("DIFF_REVIEW_CHUNK_CHARS", () => {
  it("defaults review chunks to 60,000 characters, below the old 200,000 limit", () => {
    expect(DIFF_REVIEW_CHUNK_CHARS).toBe(60000);
    // Three ~24k files: 72k total, so one chunk under the old 200k default and
    // two chunks under the review target. The worker timeout grows with a chunk.
    const big = () => `@@ -1 +1 @@\n-${"x".repeat(24000)}\n+${"y".repeat(24000)}`;
    const diff = ["src/a.js", "src/b.js", "src/c.js"].map((path) => fileSection(path, [big()])).join("\n");
    expect(diff.length).toBeGreaterThan(DIFF_REVIEW_CHUNK_CHARS);
    expect(diff.length).toBeLessThan(200000);
    const split = splitDiff(diff);
    expect(split.chunks.length).toBeGreaterThan(1);
    for (const chunk of split.chunks)
      expect(chunk.text.length).toBeLessThanOrEqual(DIFF_REVIEW_CHUNK_CHARS);
    expect(coverageProblems(diff, split.chunks)).toEqual([]);
  });
});

describe("workerTimeoutSeconds", () => {
  it("scales 600s base by 600s per started 50,000 characters", () => {
    expect(workerTimeoutSeconds(0, {})).toBe(600);
    expect(workerTimeoutSeconds(1, {})).toBe(1200);
    expect(workerTimeoutSeconds(50000, {})).toBe(1200);
    expect(workerTimeoutSeconds(50001, {})).toBe(1800);
    expect(workerTimeoutSeconds(200000, {})).toBe(3000);
  });

  it("caps at 3600s however large the chunk", () => {
    expect(workerTimeoutSeconds(1000000, {})).toBe(3600);
  });

  it("lets DIFF_REVIEW_TIMEOUT_SECONDS override the formula and the cap", () => {
    expect(workerTimeoutSeconds(200000, { DIFF_REVIEW_TIMEOUT_SECONDS: "900" })).toBe(900);
    expect(workerTimeoutSeconds(1000000, { DIFF_REVIEW_TIMEOUT_SECONDS: "900" })).toBe(900);
  });

  it("ignores a malformed override instead of passing it to the worker", () => {
    expect(workerTimeoutSeconds(50001, { DIFF_REVIEW_TIMEOUT_SECONDS: "0" })).toBe(1800);
    expect(workerTimeoutSeconds(50001, { DIFF_REVIEW_TIMEOUT_SECONDS: "abc" })).toBe(1800);
    expect(workerTimeoutSeconds(50001, { DIFF_REVIEW_TIMEOUT_SECONDS: "1.5" })).toBe(1800);
  });
});

describe("mergeVerdicts", () => {
  const pass = { ok: true, verdict: "PASS", findings: [], untested: [] };
  const fail = { ok: true, verdict: "FAIL", findings: [finding], untested: ["could not check"] };

  it("passes only when every chunk passes", () => {
    expect(mergeVerdicts([{ index: 1, parsed: pass }, { index: 2, parsed: pass }])).toEqual({
      ok: true,
      verdict: "PASS",
      findings: [],
      untested: [],
    });
  });

  it("fails when any chunk fails and keeps findings and untested", () => {
    expect(mergeVerdicts([{ index: 1, parsed: pass }, { index: 2, parsed: fail }])).toEqual({
      ok: true,
      verdict: "FAIL",
      findings: [finding],
      untested: ["chunk 2: could not check"],
    });
  });

  it("is an ERROR when any chunk errored, even if another failed", () => {
    const error = { ok: false, error: "worker exited 3" };
    expect(mergeVerdicts([{ index: 1, parsed: fail }, { index: 2, parsed: error }])).toEqual({
      ok: false,
      error: "chunk 2: worker exited 3",
    });
  });

  it("is an ERROR with no chunk verdicts", () => {
    expect(mergeVerdicts([]).ok).toBe(false);
  });
});

describe("ruleCopies", () => {
  it("numbers copies so equal names never collide", () => {
    expect(ruleCopies(["a/rules.md", "b/rules.md"])).toEqual(["./rules/1-rules.md", "./rules/2-rules.md"]);
  });
});

describe("runsToPrune", () => {
  it("keeps the newest runs", () => {
    expect(runsToPrune(["2026-03", "2026-01", "2026-02"], 2)).toEqual(["2026-01"]);
    expect(runsToPrune(["a"], 2)).toEqual([]);
  });
});

describe("parseConfig", () => {
  it("accepts rules with optional project and decided", () => {
    expect(parseConfig('{"rules":["docs/rules.md"]}')).toEqual({
      ok: true,
      project: null,
      rules: ["docs/rules.md"],
      decided: null,
    });
    expect(parseConfig('{"project":"P","rules":["r.md"],"decided":"d.md"}')).toMatchObject({
      ok: true,
      project: "P",
      decided: "d.md",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an unknown key", '{"rules":["r.md"],"rule":"x"}'],
    ["no rules", "{}"],
    ["empty rules", '{"rules":[]}'],
    ["an absolute rule path", '{"rules":["/etc/passwd"]}'],
    ["a rule path leaving the repo", '{"rules":["../r.md"]}'],
    ["an empty project", '{"project":" ","rules":["r.md"]}'],
    ["a bad decided path", '{"rules":["r.md"],"decided":"../d.md"}'],
  ])("rejects %s", (_name, text) => {
    expect(parseConfig(text).ok).toBe(false);
  });
});

describe("runPool", () => {
  it("runs at most n at a time and returns results in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    // Finish times are deliberately out of order: a later item finishes first.
    const items = [40, 5, 30, 1, 20, 10];
    const results = await runPool(items, 2, async (ms, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
      return `item-${index}`;
    });
    expect(peak).toBe(2);
    expect(results).toEqual(items.map((_ms, index) => `item-${index}`));
  });

  it("never runs more than one when the limit is 1 or below", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = [3, 1, 2];
    const results = await runPool(items, 0, async (ms, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
      return index;
    });
    expect(peak).toBe(1);
    expect(results).toEqual([0, 1, 2]);
  });

  it("runs everything at once when the limit exceeds the item count", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runPool([5, 5, 5], 10, async (ms) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
      return "done";
    });
    expect(peak).toBe(3);
    expect(results).toEqual(["done", "done", "done"]);
  });

  it("returns an empty list for no items", async () => {
    expect(await runPool([], 4, async () => "never")).toEqual([]);
  });
});

describe("concurrencyFromEnv", () => {
  it("defaults to 4 and never goes below 1", () => {
    expect(concurrencyFromEnv({})).toBe(4);
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "6" })).toBe(6);
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "0" })).toBe(1);
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "-2" })).toBe(1);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "many" })).toBe(4);
  });
});
