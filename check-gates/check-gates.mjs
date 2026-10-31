#!/usr/bin/env node
/**
 * check-gates: may this PR merge? Reads the PR's verdict files and fails unless
 * every gate its class needs read PASS on the PR head.
 *
 *   check-gates --dir <verdict dir> [--head <sha>] [--base <ref>] [--require <gate>]...
 *   check-gates --dir <verdict dir> --head <sha> --changed-file <list>   # paths, one per line
 *
 * --head defaults to `git rev-parse HEAD`; the changed paths default to
 * `git diff --name-only <base>...<head>` with --base defaulting to origin/main.
 * Every *.md file in --dir is read as a verdict (format: check-gates-lib.mjs).
 * Prints one FAILED line per problem and exits 1, PASS and exit 0, or exit 2 on
 * a usage or I/O error. A gate that could not be read never passes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkGates } from "./check-gates-lib.mjs";

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
  console.error(`check-gates: FAILED ${message}`);
  process.exit(2);
}

/**
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) die(`git ${args.join(" ")} could not run: ${result.error.message}`);
  if (result.status !== 0) die(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const options = { dir: "", head: "", base: "origin/main", changedFile: "", require: /** @type {string[]} */ ([]) };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  const value = argv[index + 1];
  const flags = { "--dir": "dir", "--head": "head", "--base": "base", "--changed-file": "changedFile" };
  if (arg === "--require" || (arg !== undefined && arg in flags)) {
    if (value === undefined || value.startsWith("--")) die(`${arg} needs a value`);
    if (arg === "--require") options.require.push(value);
    else options[flags[/** @type {keyof typeof flags} */ (arg)]] = value;
    index += 1;
  } else die(`unknown argument ${arg} (usage: check-gates --dir <verdict dir> [--head <sha>] [--base <ref> | --changed-file <list>] [--require <gate>]...)`);
}
if (options.dir === "") die("--dir is required");
if (!existsSync(options.dir)) die(`--dir ${options.dir} does not exist`);

const head = options.head || git(["rev-parse", "HEAD"]);
const changed = (
  options.changedFile ? readFileSync(options.changedFile, "utf8") : git(["diff", "--name-only", `${options.base}...${head}`])
)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
if (changed.length === 0) die("the PR changes no files");

const files = readdirSync(options.dir)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(options.dir, name), "utf8") }));

const result = checkGates({ files, head, changed, require: options.require });
for (const problem of result.problems) console.log(`FAILED ${problem}`);
const summary = `class=${result.prClass} gates=${result.gates.join(",")} head=${head} files=${changed.length}`;
console.log(result.ok ? `check-gates: PASS ${summary}` : `check-gates: FAILED ${result.problems.length} problem(s) ${summary}`);
process.exit(result.ok ? 0 : 1);
