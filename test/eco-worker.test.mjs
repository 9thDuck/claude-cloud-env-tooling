import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORK = resolve(import.meta.dirname, "..", ".work");

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

/**
 * A temporary directory holding a fake `claude` on PATH, and a workdir. The
 * fake prints the given stream lines and then sleeps or exits.
 * @param {string} body the fake claude script body.
 * @returns {{ root: string, workdir: string, env: Record<string, string> }}
 */
function fakeClaude(body) {
  mkdirSync(WORK, { recursive: true });
  const root = mkdtempSync(join(WORK, "eco-worker-test-"));
  const bin = join(root, "bin");
  const workdir = join(root, "work");
  mkdirSync(bin);
  mkdirSync(workdir);
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(claude, 0o755);
  return {
    root,
    workdir,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ECO_WORKER_API_KEY: "test-key",
      ECO_WORKER_LOG_DIR: join(root, "logs"),
    },
  };
}

/** The one status file a fakeClaude run leaves in its log dir. */
function statusText(root) {
  const dir = join(root, "logs");
  const name = readdirSync(dir).find((entry) => entry.endsWith(".status"));
  return readFileSync(join(dir, name), "utf8");
}

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

  it("exits 2 for a malformed ECO_WORKER_MAX_TURNS", () => {
    const { root, env } = fakeClaude("exit 0");
    try {
      const result = spawnSync(tool("eco-worker.sh"), ["do a thing"], {
        encoding: "utf8",
        env: { ...env, ECO_WORKER_MAX_TURNS: "many" },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("ECO_WORKER_MAX_TURNS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ends the leg at the first 429 when ECO_WORKER_NO_RETRY_429=1", () => {
    const { root, workdir, env } = fakeClaude(
      `printf '%s\\n' '{"type":"system","subtype":"api_retry","error_status":429,"error":{"type":"rate_limit_error","message":"slow down"}}'\nsleep 30`,
    );
    try {
      const result = spawnSync(tool("eco-worker.sh"), ["-t", "20", "-d", workdir, "do a thing"], {
        encoding: "utf8",
        env: { ...env, ECO_WORKER_NO_RETRY_429: "1" },
      });
      expect(result.status).not.toBe(0);
      const status = statusText(root);
      expect(status).toContain("RESULT=error");
      expect(status).toContain("api_error_status=429");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not end the leg on 429 text echoed in a user event", () => {
    const echo = '{"type":"user","api_error_status":429,"message":{"content":[{"type":"tool_result","content":"api_error_status=429 \\"error_status\\":429 \\"rate_limit_error\\""}]}}';
    const { root, workdir, env } = fakeClaude(
      `printf '%s\\n' '${echo}'\nsleep 4\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"done","permission_denials":[]}'`,
    );
    try {
      const result = spawnSync(tool("eco-worker.sh"), ["-t", "20", "-d", workdir, "do a thing"], {
        encoding: "utf8",
        env: { ...env, ECO_WORKER_NO_RETRY_429: "1" },
      });
      expect(result.status).toBe(0);
      const status = statusText(root);
      expect(status).toContain("RESULT=ok");
      expect(status).not.toContain("api_error_status=429");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the API client retry a 429 when ECO_WORKER_NO_RETRY_429=0", () => {
    const { root, workdir, env } = fakeClaude(
      `printf '%s\\n' '{"type":"system","subtype":"api_retry","error_status":429}'\nsleep 1\nprintf '%s\\n' '{"type":"result","is_error":false,"result":"done","permission_denials":[]}'`,
    );
    try {
      const result = spawnSync(tool("eco-worker.sh"), ["-t", "20", "-d", workdir, "do a thing"], {
        encoding: "utf8",
        env: { ...env, ECO_WORKER_NO_RETRY_429: "0" },
      });
      expect(result.status).toBe(0);
      const status = statusText(root);
      expect(status).toContain("RESULT=ok");
      expect(status).not.toContain("api_error_status=429");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ends the leg past ECO_WORKER_MAX_TURNS and reports error_max_turns", () => {
    const turns = `for i in 1 2 3 4 5; do printf '%s\\n' '{"type":"assistant","message":{}}'; done`;
    const { root, workdir, env } = fakeClaude(`${turns}\nsleep 30`);
    try {
      const result = spawnSync(tool("eco-worker.sh"), ["-t", "20", "-d", workdir, "do a thing"], {
        encoding: "utf8",
        env: { ...env, ECO_WORKER_MAX_TURNS: "2" },
      });
      expect(result.status).not.toBe(0);
      const status = statusText(root);
      expect(status).toContain("RESULT=error");
      expect(status).toContain("error_max_turns(turn-cap)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
