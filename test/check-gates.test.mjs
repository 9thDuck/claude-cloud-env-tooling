import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkGates, prClass } from "../check-gates/check-gates-lib.mjs";

const DIR = resolve(import.meta.dirname, "..", "check-gates");
const CLEAN = join(DIR, "fixtures", "clean");
const HEAD = "1".repeat(40);
const CHANGED = readFileSync(join(CLEAN, "changed.txt"), "utf8").trim().split("\n");

/** The clean fixture set, as checkGates takes it. */
function cleanFiles() {
  return readdirSync(CLEAN)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(CLEAN, name), "utf8") }));
}

/**
 * The clean set with one file changed.
 * @param {string} name
 * @param {(text: string) => string | null} edit null drops the file.
 */
function planted(name, edit) {
  return cleanFiles().flatMap((file) => {
    if (file.name !== name) return [file];
    const text = edit(file.text);
    return text === null ? [] : [{ name, text }];
  });
}

describe("checkGates", () => {
  it("passes the clean fixture set", () => {
    expect(checkGates({ files: cleanFiles(), head: HEAD, changed: CHANGED })).toMatchObject({ ok: true, problems: [] });
  });

  it.each([
    ["missing verdict", planted("blind-review.md", () => null), "blind-review: verdict file missing"],
    ["ERROR chunk", planted("diff-review.md", (t) => `${t}\n## ERROR\n\nchunk 2 timed out\n`), "an ERROR chunk is recorded"],
    ["stale head", planted("diff-review.md", (t) => t.replace(HEAD, "2".repeat(40))), "(stale verdict)"],
    ["placeholder", planted("process-audit.md", (t) => `${t}\nConfidence: <fill by lead>\n`), "placeholder text left"],
    ["coverage 29/30", planted("diff-review.md", (t) => t.replace("Coverage: 3/3", "Coverage: 2/3")), "Coverage 2/3 does not cover all 3"],
    ["refused call", planted("diff-review.md", (t) => t.replace("Refused calls: 0", "Refused calls: 1")), "1 refused call(s)"],
    ["no acceptance", planted("acceptance.md", (t) => t.replace(/## Acceptance[\s\S]*/, "")), "no Acceptance section"],
    ["status FAIL", planted("blind-review.md", (t) => t.replace("Status: PASS", "Status: FAIL")), "Status is FAIL, not PASS"],
    ["three rounds", planted("blind-review.md", (t) => t.replace("Rounds: 1", "Rounds: 3")), "Rounds 3 is more than 2"],
    ["bare pre-existing", planted("blind-review.md", (t) => `${t}\nThe lint error is pre-existing.\n`), '"pre-existing" without a bead id'],
  ])("fails on %s with its own message", (_name, files, message) => {
    const result = checkGates({ files, head: HEAD, changed: CHANGED });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(message);
  });

  it("accepts pre-existing with a bead and a main-run file", () => {
    const files = planted("blind-review.md", (t) => `${t}\nLint error is pre-existing: bead 6c3bv, main run in docs/evidence/main-lint.txt\n`);
    expect(checkGates({ files, head: HEAD, changed: CHANGED }).ok).toBe(true);
  });

  it("adds gates the scenario author named", () => {
    const result = checkGates({ files: cleanFiles(), head: HEAD, changed: CHANGED, require: ["walk-buyer-goal"] });
    expect(result.problems).toEqual(["walk-buyer-goal: verdict file missing"]);
  });
});

describe("prClass", () => {
  it("is small only when every path is beads, docs or Markdown", () => {
    expect(prClass([".beads/issues.jsonl", "docs/a.txt", "README.md"])).toBe("small");
    expect(prClass(["README.md", "src/a.ts"])).toBe("big");
    expect(prClass([])).toBe("big");
  });
});

describe("check-gates CLI", () => {
  /** @type {string[]} */
  const temps = [];
  afterEach(() => temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  /** @param {string} dir */
  function run(dir) {
    return spawnSync("node", [join(DIR, "check-gates.mjs"), "--dir", dir, "--head", HEAD, "--changed-file", join(CLEAN, "changed.txt")], {
      encoding: "utf8",
    });
  }

  it("exits 0 with PASS on the clean set", () => {
    const result = run(CLEAN);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check-gates: PASS class=big");
  });

  it("exits 1 and names the gate on a stale verdict", () => {
    const dir = mkdtempSync(join(DIR, "fixtures", "tmp-"));
    temps.push(dir);
    cpSync(CLEAN, dir, { recursive: true });
    const path = join(dir, "diff-review.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(HEAD, "2".repeat(40)));
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED diff-review (diff-review.md): Head");
  });

  it("exits 2 when the verdict dir is missing", () => {
    const result = run(join(DIR, "no-such-dir"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not exist");
  });
});
