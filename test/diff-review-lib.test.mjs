import { describe, expect, it } from "vitest";

import {
  DIFF_REVIEW_CHUNK_CHARS,
  allowedBashCommands,
  blockingFromEnv,
  buildPrompt,
  concurrencyFromEnv,
  coverageProblems,
  decide,
  deltaReview,
  fileRank,
  filesInDiff,
  maxTurnsFor,
  chunkCharsError,
  chunkCharsFromEnv,
  DIFF_REVIEW_CHUNK_CHARS_MIN,
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
  splitFileSections,
  turnCapDetail,
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

  it("refuses a PASS when a chunk is larger than the chunk limit", () => {
    const decision = decide({ parsed: pass, blocking: false, oversize: true });
    expect(decision.exitCode).toBe(1);
    expect(decision.line).toContain("ERROR");
  });

  it("names the run's verdict, so verdict.json follows the exit decision", () => {
    expect(decide({ parsed: pass, blocking: false }).verdict).toBe("PASS");
    expect(decide({ parsed: fail, blocking: false }).verdict).toBe("FAIL");
    expect(decide({ parsed: pass, blocking: false, oversize: true }).verdict).toBe("ERROR");
    expect(decide({ parsed: { ok: false, error: "no verdict" }, blocking: false }).verdict).toBe("ERROR");
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

describe("allowedBashCommands", () => {
  it("lists the Bash commands of the allow list, with or without :*", () => {
    expect(
      allowedBashCommands({
        permissions: { allow: ["Read(/x/**)", "Bash(git show:*)", "Bash(ls)", 3], deny: ["Bash(rm:*)"] },
      }),
    ).toEqual(["git show", "ls"]);
    expect(allowedBashCommands({ permissions: { allow: [] } })).toEqual([]);
    expect(allowedBashCommands({})).toBeNull();
  });
});

describe("reviewerPermissionsFor", () => {
  it("throws when permissions.allow is missing", () => {
    expect(() => reviewerPermissionsFor({ permissions: { deny: [] } }, "/repo")).toThrow(
      /permissions\.allow/,
    );
  });

  it("throws when permissions.deny is missing", () => {
    expect(() => reviewerPermissionsFor({ permissions: { allow: [] } }, "/repo")).toThrow(
      /permissions\.deny/,
    );
  });

  it("adds git -C twins without mutating its input", () => {
    const input = {
      permissions: { allow: ["Bash(git show:*)", "Bash(ls)"], deny: ["Bash(push:*)"] },
    };
    const result = reviewerPermissionsFor(input, "/repo");
    expect(result.permissions.allow).toContain("Bash(git -C /repo show:*)");
    expect(input.permissions.allow).toEqual(["Bash(git show:*)", "Bash(ls)"]);
    expect(input.permissions.deny).toEqual(["Bash(push:*)"]);
  });
});

describe("buildPrompt", () => {
  it("names the allowed commands and says a refused call is an ERROR", () => {
    const prompt = buildPrompt({ base: "main", allowedCommands: ["git show", "grep"] });
    expect(prompt).toContain("Bash is limited to these commands: git show, grep.");
    expect(prompt).toContain("a refused call makes the whole review an ERROR");
    expect(prompt).toContain("Run one command per Bash call");
    expect(prompt).toContain("no cd");
  });

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
      workdir: "/runs/1/chunks/2",
      readRoot: "/repo",
    });
    expect(prompt).toContain("- /runs/1/rules/1-a.md");
    expect(prompt).toContain("- /runs/1/rules/2-rules.md");
    expect(prompt).toContain("The project: A shop");
    expect(prompt).toContain("chunk 2 of 3");
    expect(prompt).toContain("/runs/1/chunks/2/diff.patch");
    expect(prompt).toContain("/runs/1/chunks/2/verdict.json");
    expect(prompt).toContain("Your working directory is /runs/1/chunks/2");
    expect(prompt).toContain("The repository is at /repo");
    expect(prompt).toContain("plain git show");
    expect(prompt).toContain("Your working directory is /runs/1/chunks/2, this chunk's directory");
    expect(prompt).toContain("any change makes the review an ERROR");
    expect(prompt).not.toContain("Bash is limited to");
    expect(prompt).toContain("git -C /repo");
    expect(prompt).toContain("any other git -C path is refused");
    expect(prompt).toContain("- src/a.js");
    expect(prompt).toContain("- e2e/a.js");
    expect(prompt).not.toContain("decided");
  });

  it("states the delta it builds on", () => {
    const prompt = buildPrompt({
      base: "main",
      chunk: { text: "x", files: ["src/a.js"] },
      rulePaths: ["/r/rules.md"],
      delta: { since: "a".repeat(40), path: "/runs/old/verdict.md", result: "PASS" },
    });
    expect(prompt).toContain(`delta review since ${"a".repeat(40)}`);
    expect(prompt).toContain("/runs/old/verdict.md");
    expect(prompt).toContain("returned PASS");
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
  it("splits a plain diff -u patch with several files after each file's hunks", () => {
    const diff = "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n--- a/y.txt\n+++ b/y.txt\n@@ -1,2 +1 @@\n-c\n-d\n+e\n";
    expect(splitFileSections(diff).map((section) => section.path)).toEqual(["x.txt", "y.txt"]);
    expect(filesInDiff(diff)).toEqual(["x.txt", "y.txt"]);
  });

  it("decodes git's octal-quoted non-ASCII paths", () => {
    const quoted = '"a/caf\\303\\251.txt" "b/caf\\303\\251.txt"';
    const diff = `diff --git ${quoted}\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(filesInDiff(diff)).toEqual(["café.txt"]);
    expect(splitFileSections(diff).map((section) => section.path)).toEqual(["café.txt"]);
  });

  it("reports a quoted path it cannot decode instead of guessing", () => {
    expect(() => filesInDiff('diff --git "a/x\\q" "b/x\\q"\n')).toThrow(/cannot unquote git path/);
  });

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
  it("defaults review chunks to 20,000 characters, below the old 200,000 limit", () => {
    expect(DIFF_REVIEW_CHUNK_CHARS).toBe(20000);
    // Three ~18k files: 54k total, so one chunk under the old 200k default and
    // several chunks under the review target. The worker timeout grows with a chunk.
    const big = () => `@@ -1 +1 @@\n-${"x".repeat(9000)}\n+${"y".repeat(9000)}`;
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
    // maxTurns 1 keeps the turn-derived floor (30s) out of the way.
    expect(workerTimeoutSeconds(0, {}, 1)).toBe(600);
    expect(workerTimeoutSeconds(1, {}, 1)).toBe(1200);
    expect(workerTimeoutSeconds(50000, {}, 1)).toBe(1200);
    expect(workerTimeoutSeconds(50001, {}, 1)).toBe(1800);
    expect(workerTimeoutSeconds(200000, {}, 1)).toBe(3000);
  });

  it("caps the size formula at 3600s however large the chunk", () => {
    expect(workerTimeoutSeconds(1000000, {}, 1)).toBe(3600);
  });

  it("allows 30s per turn of the cap when the turn-derived timeout is larger", () => {
    // 20K default chunk: 60 turns = 1800s beats the 1200s size formula.
    expect(workerTimeoutSeconds(20000, {})).toBe(1800);
    // 52K chunk (the P1a case): 92 turns = 2760s beats 1800s.
    expect(workerTimeoutSeconds(52000, {})).toBe(2760);
    // A raised DIFF_REVIEW_MAX_TURNS raises the timeout with it.
    expect(workerTimeoutSeconds(20000, { DIFF_REVIEW_MAX_TURNS: "200" })).toBe(6000);
  });

  it("caps the turn-derived timeout at 7200s", () => {
    expect(workerTimeoutSeconds(20000, { DIFF_REVIEW_MAX_TURNS: "100000" })).toBe(7200);
  });

  it("lets DIFF_REVIEW_TIMEOUT_SECONDS override the formula and the cap", () => {
    expect(workerTimeoutSeconds(200000, { DIFF_REVIEW_TIMEOUT_SECONDS: "900" })).toBe(900);
    expect(workerTimeoutSeconds(1000000, { DIFF_REVIEW_TIMEOUT_SECONDS: "900" })).toBe(900);
  });

  it("ignores a malformed override instead of passing it to the worker", () => {
    expect(workerTimeoutSeconds(50001, { DIFF_REVIEW_TIMEOUT_SECONDS: "0" }, 1)).toBe(1800);
    expect(workerTimeoutSeconds(50001, { DIFF_REVIEW_TIMEOUT_SECONDS: "abc" }, 1)).toBe(1800);
    expect(workerTimeoutSeconds(50001, { DIFF_REVIEW_TIMEOUT_SECONDS: "1.5" }, 1)).toBe(1800);
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

describe("parseEarlierVerdict", () => {
  const head = "b".repeat(40);
  const verdictMd = (result) =>
    [
      `# diff-review: ${result} (advisory) second reader, never acceptance`,
      "",
      `- at: 2026-01-01T00:00:00.000Z`,
      `- head: ${head}`,
      "- base: origin/main",
      "- chunks: 1",
      "",
      "## Files covered (2)",
      "",
      "- src/a.js (chunk 1)",
      "- src/old.js (chunk 1)",
      "",
      "## Findings",
      "",
      "- `src/a.js:3` No secrets — adds a key",
      "",
    ].join("\n");

  it("reads the head, result, covered files and findings", () => {
    expect(parseEarlierVerdict(verdictMd("FAIL"))).toEqual({
      ok: true,
      head,
      result: "FAIL",
      coveredFiles: ["src/a.js", "src/old.js"],
      findings: [{ file: "src/a.js", line: 3, rule: "No secrets", why: "adds a key" }],
    });
    expect(parseEarlierVerdict(verdictMd("PASS"))).toMatchObject({
      ok: true,
      result: "PASS",
    });
  });

  it("refuses an earlier verdict without a head sha or with no readable result", () => {
    const noHead = verdictMd("PASS").replace(`- head: ${head}\n`, "");
    expect(parseEarlierVerdict(noHead).ok).toBe(false);
    expect(parseEarlierVerdict(noHead).error).toContain("- head:");
    expect(parseEarlierVerdict("nothing here").ok).toBe(false);
  });

  it("refuses a FAIL that lists no readable findings", () => {
    const noFindings = verdictMd("FAIL").replace("- `src/a.js:3` No secrets — adds a key\n", "");
    const parsed = parseEarlierVerdict(noFindings);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("no readable findings");
  });

  it("keeps an absent why empty instead of inventing one", () => {
    const noWhy = verdictMd("FAIL").replace("- `src/a.js:3` No secrets — adds a key", "- `src/a.js:3` No secrets");
    const parsed = parseEarlierVerdict(noWhy);
    expect(parsed.ok).toBe(true);
    expect(parsed.findings).toEqual([{ file: "src/a.js", line: 3, rule: "No secrets", why: "" }]);
  });
});

describe("deltaReview", () => {
  const pass = { ok: true, verdict: "PASS", findings: [], untested: [] };
  const fail = { ok: true, verdict: "FAIL", findings: [finding], untested: [] };
  const earlier = {
    coveredFiles: ["src/a.js", "src/old.js"],
    findings: [{ ...finding, file: "src/old.js" }],
  };

  it("lists the files the earlier verdict still covers", () => {
    const result = deltaReview({
      parsed: pass,
      reviewedFiles: ["src/a.js"],
      earlier: { ...earlier, findings: [] },
    });
    expect(result.unchangedFiles).toEqual(["src/old.js"]);
    expect(result.parsed).toBe(pass);
    expect(result.unreviewedFindings).toEqual([]);
  });

  it("is FAIL when an earlier finding's file was not re-reviewed", () => {
    const result = deltaReview({ parsed: pass, reviewedFiles: ["src/a.js"], earlier });
    // src/old.js is unchanged, so its finding was not re-reviewed and survives.
    expect(result.parsed).toMatchObject({ ok: true, verdict: "FAIL" });
    expect(result.parsed.findings).toEqual([earlier.findings[0]]);
    expect(result.unreviewedFindings).toEqual([earlier.findings[0]]);
  });

  it("drops an earlier finding once its file is re-reviewed and the delta passes", () => {
    const result = deltaReview({ parsed: pass, reviewedFiles: ["src/a.js", "src/old.js"], earlier });
    expect(result.parsed).toBe(pass);
    expect(result.unreviewedFindings).toEqual([]);
    expect(result.unchangedFiles).toEqual([]);
  });

  it("keeps a delta FAIL and adds unreviewed earlier findings", () => {
    const result = deltaReview({ parsed: fail, reviewedFiles: ["src/a.js"], earlier });
    expect(result.parsed.verdict).toBe("FAIL");
    expect(result.parsed.findings).toEqual([finding, earlier.findings[0]]);
  });

  it("leaves an ERROR untouched", () => {
    const error = { ok: false, error: "rate limited (429)" };
    expect(deltaReview({ parsed: error, reviewedFiles: [], earlier }).parsed).toBe(error);
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
  it("defaults to 2 and never goes below 1", () => {
    expect(concurrencyFromEnv({})).toBe(2);
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "6" })).toBe(6);
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "0" })).toBe(1);
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "-2" })).toBe(1);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(concurrencyFromEnv({ DIFF_REVIEW_CONCURRENCY: "many" })).toBe(2);
  });
});

describe("maxTurnsFor", () => {
  it("scales the default cap with the chunk size", () => {
    expect(maxTurnsFor(20000, {})).toBe(60);
    expect(maxTurnsFor(51844, {})).toBe(92);
    expect(maxTurnsFor(60000, {})).toBe(100);
    expect(maxTurnsFor(0, {})).toBe(40);
  });

  it("never gives a small chunk fewer than the old fixed 40 turns", () => {
    for (const n of [0, 1, 500, 5000, 9000]) {
      expect(maxTurnsFor(n, {})).toBeGreaterThanOrEqual(40);
    }
    expect(maxTurnsFor(5000, {})).toBe(45);
  });

  it("lets a positive integer DIFF_REVIEW_MAX_TURNS win", () => {
    expect(maxTurnsFor(51844, { DIFF_REVIEW_MAX_TURNS: "7" })).toBe(7);
  });

  it("ignores a non-positive or non-numeric override", () => {
    expect(maxTurnsFor(20000, { DIFF_REVIEW_MAX_TURNS: "0" })).toBe(60);
    expect(maxTurnsFor(20000, { DIFF_REVIEW_MAX_TURNS: "-3" })).toBe(60);
    expect(maxTurnsFor(20000, { DIFF_REVIEW_MAX_TURNS: "many" })).toBe(60);
  });
});

describe("chunkCharsFromEnv", () => {
  it("defaults to 20000 and accepts a positive integer", () => {
    expect(chunkCharsFromEnv({})).toBe(20000);
    expect(chunkCharsFromEnv({ DIFF_REVIEW_CHUNK_CHARS: "8000" })).toBe(8000);
  });

  it("defaults to 20000 when unset or empty, and falls back for a value chunkCharsError rejects", () => {
    expect(chunkCharsFromEnv({ DIFF_REVIEW_CHUNK_CHARS: "0" })).toBe(20000);
    expect(chunkCharsFromEnv({ DIFF_REVIEW_CHUNK_CHARS: "big" })).toBe(20000);
    expect(chunkCharsFromEnv({ DIFF_REVIEW_CHUNK_CHARS: "1" })).toBe(20000);
  });
});

describe("chunkCharsError", () => {
  it("accepts unset and any integer from the minimum up", () => {
    expect(chunkCharsError({})).toBeNull();
    expect(chunkCharsError({ DIFF_REVIEW_CHUNK_CHARS: "" })).toBeNull();
    expect(chunkCharsError({ DIFF_REVIEW_CHUNK_CHARS: String(DIFF_REVIEW_CHUNK_CHARS_MIN) })).toBeNull();
    expect(chunkCharsError({ DIFF_REVIEW_CHUNK_CHARS: "52000" })).toBeNull();
  });

  it("rejects 1, anything under the minimum and anything not an integer", () => {
    for (const raw of ["1", "4999", "0", "-5000", "big", "8000.5"])
      expect(chunkCharsError({ DIFF_REVIEW_CHUNK_CHARS: raw })).toContain(`DIFF_REVIEW_CHUNK_CHARS=${raw}`);
  });
});

describe("noRetry429FromEnv", () => {
  it("is on by default and only 0 turns it off", () => {
    expect(noRetry429FromEnv({})).toBe(true);
    expect(noRetry429FromEnv({ ECO_WORKER_NO_RETRY_429: "1" })).toBe(true);
    expect(noRetry429FromEnv({ ECO_WORKER_NO_RETRY_429: "0" })).toBe(false);
  });
});

describe("rateLimitDetail", () => {
  it("reads a 429 from a stream-json event and reports the nested message", () => {
    const log = [
      '{"type":"system","subtype":"init"}',
      '{"type":"system","subtype":"api_retry","error_status":429,"error":{"type":"rate_limit_error","message":"slow down"}}',
    ].join("\n");
    expect(rateLimitDetail(log)).toBe("slow down");
  });

  it("reads an api_error_status=429 status line", () => {
    expect(rateLimitDetail("eco-worker: RESULT=error exit=1 api_error_status=429 error=rate-limit-rejected(429)")).toContain(
      "api_error_status=429",
    );
  });

  it("is null without a rate-limit rejection", () => {
    expect(rateLimitDetail('{"type":"result","is_error":false,"result":"ok"}')).toBeNull();
    expect(rateLimitDetail("")).toBeNull();
  });

  it("ignores 429 text inside tool output and model text (planted: a reviewer reading this file)", () => {
    const log = [
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"/\\"rate_limit_error\\"/ and \\"error_status\\":429"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"api_error_status=429 is matched"}]}}',
    ].join("\n");
    expect(rateLimitDetail(log)).toBeNull();
    expect(rateLimitDetail(`${log}\n{"type":"result","api_error_status":429,"result":"quota gone"}`)).toBe("quota gone");
  });

  it("ignores 429 text echoed in a user/assistant event or in plain output", () => {
    const echoed = [
      '{"type":"user","api_error_status":429,"message":{"content":[{"type":"tool_result","content":"api_error_status=429"}]}}',
      '{"type":"assistant","error":{"type":"rate_limit_error","message":"quoted from a file"},"message":{}}',
      "the file says api_error_status=429 but nothing was rejected",
      'log text: "rate_limit_error"',
    ].join("\n");
    expect(rateLimitDetail(echoed)).toBeNull();
  });
});

describe("turnCapDetail", () => {
  it("reads the turn-cap marker", () => {
    expect(turnCapDetail("eco-worker: RESULT=error exit=1 turns=41 max_turns=40 error=error_max_turns(turn-cap)")).toContain(
      "error_max_turns",
    );
    expect(turnCapDetail('{"type":"result","subtype":"error_max_turns"}')).toContain("error_max_turns");
  });

  it("does not treat max_turns alone or a normal result as a cap hit", () => {
    expect(turnCapDetail("max_turns=40 turns=3")).toBeNull();
    expect(turnCapDetail('{"type":"result","is_error":false,"result":"ok"}')).toBeNull();
    expect(turnCapDetail('{"type":"user","message":{"content":"error_max_turns and the turn cap"}}')).toBeNull();
  });

  it("ignores turn-cap text echoed in a user/assistant event or in prose", () => {
    const echoed = [
      '{"type":"user","subtype":"error_max_turns","message":{"content":[{"type":"tool_result","content":"error_max_turns"}]}}',
      '{"type":"assistant","message":{"content":"the TURN CAP is 40"},"subtype":"error_max_turns"}',
      "the worker's source mentions error_max_turns and turn cap",
    ].join("\n");
    expect(turnCapDetail(echoed)).toBeNull();
  });
});
