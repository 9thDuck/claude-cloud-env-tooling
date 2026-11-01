#!/usr/bin/env node
/**
 * PreToolUse hook for diff-review reviewers (bead 67njw): answers "allow" for a
 * Bash call that isReadOnlyCommand accepts, and gives no decision otherwise, so
 * the reviewer's permission rules and eco-worker's deny hook decide as before.
 * Usage: readonly-hook.mjs --read <repo root> --write <run dir>
 * A missing root or unreadable input is a hard failure (exit 2), never a pass.
 */
import { readFileSync } from "node:fs";
import { isReadOnlyCommand } from "./readonly-command.mjs";

const argv = process.argv.slice(2);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const read = value("--read");
const write = value("--write");
if (read === null || write === null) {
  console.error("readonly-hook: FAILED needs --read <root> and --write <run dir>");
  process.exit(2);
}
let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (error) {
  console.error(`readonly-hook: FAILED cannot parse hook input: ${error.message}`);
  process.exit(2);
}
const command = input?.tool_input?.command;
if (input?.tool_name !== "Bash" || typeof command !== "string") process.exit(0);
const verdict = isReadOnlyCommand(command, {
  readRoots: [read, write],
  writeRoot: write,
  cwd: typeof input.cwd === "string" ? input.cwd : write,
});
if (verdict.ok) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "read-only command (diff-review readonly-hook)",
      },
    }),
  );
}
process.exit(0);
