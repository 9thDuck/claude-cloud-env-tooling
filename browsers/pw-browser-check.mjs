#!/usr/bin/env node
/**
 * Fails when the Chromium builds a repo's Playwright expects are not installed
 * (bead iyux9: the image had chromium_headless_shell-1243, Playwright 1.59.1
 * wanted -1217, and nothing said so until a browser gate failed).
 * Usage: pw-browser-check.mjs <repo> [--browsers-path DIR] [--install]
 *   DIR defaults to $PLAYWRIGHT_BROWSERS_PATH, then /opt/pw-browsers.
 *   --install runs the repo's own `playwright install` for the missing builds
 *   into DIR, then checks again.
 * Exit 0 all present, 1 drift, 2 cannot tell (no installed playwright, bad args).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const WANTED = { chromium: "chromium", "chromium-headless-shell": "chromium_headless_shell" };
const argv = process.argv.slice(2);
const at = argv.indexOf("--browsers-path");
const browsers = at >= 0 ? argv[at + 1] : process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
const install = argv.includes("--install");
const repo = argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
if (!repo || browsers === undefined) {
  console.log("pw-browser-check: FAILED usage: pw-browser-check.mjs <repo> [--browsers-path DIR] [--install]");
  process.exit(2);
}

let core;
try {
  const req = createRequire(join(resolve(repo), "package.json"));
  const pw = req.resolve("playwright/package.json");
  core = createRequire(pw).resolve("playwright-core/package.json");
  // NODE_PATH (e.g. /opt/node-tools) would hand back another Playwright: only the repo's counts.
  if (!realpathSync(core).startsWith(`${realpathSync(resolve(repo))}/`)) throw new Error(`resolved ${core}, outside the repo`);
} catch (error) {
  console.log(`pw-browser-check: FAILED no installed playwright in ${repo} (run pnpm install): ${error.message.split("\n")[0]}`);
  process.exit(2);
}
const { version } = JSON.parse(readFileSync(core, "utf8"));
const want = JSON.parse(readFileSync(join(core, "..", "browsers.json"), "utf8"))
  .browsers.filter((b) => b.name in WANTED)
  .map((b) => ({ name: b.name, dir: `${WANTED[b.name]}-${b.revision}` }));

const missing = () => want.filter((b) => !existsSync(join(browsers, b.dir)));
let gone = missing();
if (gone.length > 0 && install) {
  const cli = join(core, "..", "cli.js");
  const r = spawnSync(process.execPath, [cli, "install", ...gone.map((b) => b.name)], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  if (r.status !== 0) console.log(`pw-browser-check: playwright install exited ${r.status ?? r.signal}`);
  gone = missing();
}
const wanted = want.map((b) => b.dir).join(", ");
if (gone.length === 0) {
  console.log(`pw-browser-check: PASS playwright ${version} wants ${wanted}; present in ${browsers}`);
  process.exit(0);
}
const present = existsSync(browsers) ? readdirSync(browsers).filter((d) => /^chromium/.test(d)).join(", ") : "(no such directory)";
console.log(`pw-browser-check: FAILED playwright ${version} wants ${gone.map((b) => b.dir).join(", ")}; ${browsers} has ${present || "none"}`);
process.exit(1);
