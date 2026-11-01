import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Bead iyux9: the image shipped chromium_headless_shell-1243 while the repo's
// Playwright 1.59.1 wanted -1217, and nothing said so until a gate failed.
// The check reads the revisions the repo's Playwright expects and fails on drift.
const CHECK = resolve(import.meta.dirname, "..", "browsers", "pw-browser-check.mjs");
const WORK = resolve(import.meta.dirname, "..", ".work");
let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

/** A repo whose playwright (pnpm layout) expects `rev`, and a browsers dir holding `have`. */
function fixture(rev, have) {
  mkdirSync(WORK, { recursive: true });
  root = mkdtempSync(join(WORK, "pw-check-"));
  const repo = join(root, "repo");
  const store = join(repo, "node_modules", ".pnpm", "playwright@1.59.1", "node_modules");
  for (const [name, extra] of [["playwright", {}], ["playwright-core", {}]]) {
    mkdirSync(join(store, name), { recursive: true });
    writeFileSync(join(store, name, "package.json"), JSON.stringify({ name, version: "1.59.1", ...extra }));
  }
  writeFileSync(join(store, "playwright-core", "browsers.json"), JSON.stringify({
    browsers: [
      { name: "chromium", revision: rev, installByDefault: true },
      { name: "chromium-headless-shell", revision: rev, installByDefault: true },
      { name: "firefox", revision: "1", installByDefault: true },
    ],
  }));
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  // pnpm links node_modules/playwright into the store
  spawnSync("ln", ["-s", join(store, "playwright"), join(repo, "node_modules", "playwright")]);
  const browsers = join(root, "browsers");
  for (const dir of have) mkdirSync(join(browsers, dir), { recursive: true });
  return { repo, browsers };
}
const run = (repo, browsers) =>
  spawnSync(process.execPath, [CHECK, repo, "--browsers-path", browsers], { encoding: "utf8" });

describe("pw-browser-check.mjs (iyux9)", () => {
  it("fails on drift and names the wanted and present builds", () => {
    const { repo, browsers } = fixture("1217", ["chromium-1243", "chromium_headless_shell-1243"]);
    const r = run(repo, browsers);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAILED");
    expect(r.stdout).toContain("chromium_headless_shell-1217");
    expect(r.stdout).toContain("chromium_headless_shell-1243");
  });

  it("passes when the expected builds are present", () => {
    const { repo, browsers } = fixture("1217", ["chromium-1217", "chromium_headless_shell-1217"]);
    const r = run(repo, browsers);
    expect(r.stdout).toContain("PASS");
    expect(r.status).toBe(0);
  });

  it("reads the browsers dir from PLAYWRIGHT_BROWSERS_PATH when no flag is given", () => {
    const { repo, browsers } = fixture("1217", ["chromium-1217", "chromium_headless_shell-1217"]);
    const r = spawnSync(process.execPath, [CHECK, repo], {
      encoding: "utf8",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    expect(r.stdout).toContain("PASS");
    expect(r.status).toBe(0);
  });

  it("fails loudly when the repo has no installed playwright", () => {
    const { browsers } = fixture("1217", []);
    const r = run(join(root, "nowhere"), browsers);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/FAILED .*playwright/);
  });
});
