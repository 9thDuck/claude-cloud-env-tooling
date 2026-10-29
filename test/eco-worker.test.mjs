import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ECO = resolve(import.meta.dirname, "..", "eco-worker");

/** Feed one Bash command to the deny hook. */
function hook(command) {
  return spawnSync(tool("deny-hook.sh"), {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, ECO_WORKER_HOOK_LOG: "" },
  });
}

/** @param {string} name a script in eco-worker/ */
function tool(name) {
  return resolve(ECO, name);
}

describe("deny-hook.sh", () => {
  it.each([
    "git push origin main",
    "git commit -m x --amend",
    "git commit -m 'msg' '--amend'",
    "echo ok && git reset --hard",
    "git checkout -f main",
    "rm -fr build",
    "gh pr list",
  ])("refuses %s", (command) => {
    const result = hook(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("eco-worker refused this command");
  });

  it.each(["git status", "git commit -m 'mention --amend in text'", "rm file.txt", "ls -la"])("allows %s", (command) => {
    expect(hook(command).status).toBe(0);
  });
});

describe("eco-worker.sh", () => {
  it("exits 2 without ECO_WORKER_API_KEY", () => {
    const env = { ...process.env };
    delete env.ECO_WORKER_API_KEY;
    const result = spawnSync(tool("eco-worker.sh"), ["do a thing"], { encoding: "utf8", env });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ECO_WORKER_API_KEY not set");
  });

  it("exits 2 without a task", () => {
    const result = spawnSync(tool("eco-worker.sh"), [], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no task given");
  });
});
