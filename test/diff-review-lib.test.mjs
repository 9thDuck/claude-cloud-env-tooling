import { describe, expect, it } from "vitest";

import {
  MAX_DIFF_CHARS,
  blockingFromEnv,
  gateHeader,
  buildPrompt,
  decide,
  parseConfig,
  parseVerdict,
  ruleCopies,
  runsToPrune,
} from "../diff-review/diff-review-lib.mjs";

const finding = { file: "src/a.js", line: 3, rule: '"No secrets" (rules.md)', why: "adds a key" };

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
    expect(decide({ parsed: fail, blocking: false }).line).toContain("FAIL (required gate, not acceptance) 1 finding");
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
  it("names each rule copy, the project and a complete diff", () => {
    const prompt = buildPrompt({ diff: "abc", base: "origin/main", rules: ["docs/a.md", "b.md"], project: "A shop" });
    expect(prompt).toContain("- ./rules/1-a.md");
    expect(prompt).toContain("- ./rules/2-b.md");
    expect(prompt).toContain("The project: A shop");
    expect(prompt).toContain("(3 characters, complete)");
    expect(prompt).not.toContain("decided.md");
  });

  it("says when the diff is cut and when a decided file exists", () => {
    const prompt = buildPrompt({ diff: "x".repeat(MAX_DIFF_CHARS + 1), base: "b", rules: ["r.md"], decided: true });
    expect(prompt).toContain(`only the first ${MAX_DIFF_CHARS}`);
    expect(prompt).toContain("./decided.md");
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

describe("gateHeader", () => {
  const diff = "diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n";
  it("writes the header check-gates reads", () => {
    expect(gateHeader({ decision: { line: "diff-review: PASS (required gate, not acceptance) 0 findings" }, head: "abc", diff, refused: 0 })).toEqual([
      "Gate: diff-review",
      "Head: abc",
      "Status: PASS",
      "Coverage: 2/2",
      "Runner: eco-worker",
      "Refused calls: 0",
    ]);
  });
  it("reports unknown refusals and ERROR status", () => {
    const header = gateHeader({ decision: { line: "diff-review: ERROR (x) y" }, head: "abc", diff, refused: null });
    expect(header).toContain("Status: ERROR");
    expect(header).toContain("Refused calls: unknown");
  });
});
