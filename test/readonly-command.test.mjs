import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../diff-review/readonly-command.mjs";

// Bead 67njw: the reviewer's Bash rules are prefix rules, so read-only calls
// were refused and each refusal turned a whole review into an ERROR (exit 4).
// The reviewer now accepts read-only commands as a class; writes stay refused.
const READ = "/repo";
const WRITE = "/repo/.work/diff-review/run/chunks/1";
const opts = { readRoots: [READ, WRITE], writeRoot: WRITE, cwd: WRITE };

describe("isReadOnlyCommand: refusals replayed (67njw)", () => {
  it.each([
    // every refused read-only call so far
    "jq -e . /repo/.work/diff-review/run/chunks/1/verdict.json",
    "jq -e . < /repo/.work/diff-review/run/chunks/1/verdict.json",
    "git show d9b0619e:.beads/issues.jsonl | sed -n 195p",
    "git branch -a",
    "git merge-base --is-ancestor d9b0619e HEAD",
    "git show 25e13a7e --stat | head -20",
    // the class, not only the replays
    "cat /repo/src/a.ts",
    "head -n 40 /repo/src/a.ts",
    "grep -rn foo /repo/src",
    "rg -n 'a|b' /repo/src",
    "wc -l /repo/src/a.ts",
    "git log --oneline -5",
    "git diff origin/main...HEAD --stat",
    "git --no-pager -C /repo log -3",
    "git show HEAD:package.json | jq .scripts",
    "git log --oneline | grep 67njw | wc -l",
    "sed -n 10,20p /repo/src/a.ts",
    "git diff HEAD 2>&1 | head",
    "jq . /repo/a.json > /repo/.work/diff-review/run/chunks/1/out.json",
  ])("allows %s", (command) => {
    expect(isReadOnlyCommand(command, opts)).toEqual({ ok: true });
  });

  it.each([
    // refusals that must stay refused (8etl4 and the deny list)
    "git checkout -- scripts/pagefind-indexing-runtime.mjs",
    "git checkout --detach 25e13a7e",
    "git apply .work/gates/plant-p1.patch",
    "SITE_URL=http://localhost:4321 pnpm build",
    "git check-ignore -v .work 2>&1; git show 25e13a7e --stat | head -20",
    "gi",
    // writes and redirects outside the run dir
    "jq . /repo/a.json > /repo/a.json",
    "cat /repo/a >> /repo/b",
    "git show HEAD:a > /tmp/x",
    "cat /repo/a > /repo/.work/diff-review/run/chunks/1/../../../../../src/a.ts",
    "git diff --output=/repo/x.patch",
    "git branch -D main",
    "git branch new-branch",
    "git -c core.pager=sh log",
    "git -C /elsewhere log",
    "sed -i s/a/b/ /repo/a",
    "sed -n 1w/repo/x /repo/a",
    "sort -o /repo/a /repo/a",
    "find /repo -delete",
    "find /repo -exec rm {} ;",
    "rg --pre sh foo /repo",
    "cat $(echo /repo/a)",
    "cat `echo /repo/a`",
    "echo ok && git reset --hard",
    "cat /root/.claude/credentials.json",
    "ls ../../../../../2026-11-01T03-24-10-826Z/../../../../..",
    "node -e 1",
    "GIT_PAGER=sh git log",
    "tee /repo/a",
    "git show HEAD:a | tee out.txt",
    "git branch -d main",
    "git branch -m main other",
    "git push origin HEAD",
    "git reset --hard HEAD",
    "rm /repo/a",
    "cat /repo/a; rm /repo/a",
    "cat /repo/a > out.txt; git checkout -- a",
    "sort --compress-program=sh /repo/a",
    "git log -p --textconv",
    "xxd -r /repo/a out.bin",
    "file -C -m magic",
  ])("does not allow %s", (command) => {
    expect(isReadOnlyCommand(command, opts).ok).toBe(false);
  });
});

describe("readonly-hook.mjs", () => {
  const hook = resolve(import.meta.dirname, "..", "diff-review", "readonly-hook.mjs");
  const run = (command) =>
    spawnSync(process.execPath, [hook, "--read", READ, "--write", WRITE], {
      input: JSON.stringify({ tool_name: "Bash", cwd: WRITE, tool_input: { command } }),
      encoding: "utf8",
    });

  it("answers allow for a read-only pipe", () => {
    const r = run("git show d9b0619e:.beads/issues.jsonl | sed -n 195p");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("gives no decision for a write, so the normal rules refuse it", () => {
    const r = run("git checkout --detach 25e13a7e");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails loudly without its roots", () => {
    const r = spawnSync(process.execPath, [hook], { input: "{}", encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/FAILED/);
  });
});

describe("readOnlyHookCommand (diff-review wiring)", () => {
  it("runs the hook with the repo and the chunk dir as roots, and the hook allows through it", async () => {
    const { readOnlyHookCommand } = await import("../diff-review/diff-review.mjs");
    const cmd = readOnlyHookCommand(READ, WRITE);
    const r = spawnSync("sh", ["-c", cmd], {
      input: JSON.stringify({ tool_name: "Bash", cwd: WRITE, tool_input: { command: "git branch -a" } }),
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("allow");
  });
});
