import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
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

/** Serve one JSON response and return the full search URL to point ECO_WORKER_SEARCH_URL at. */
async function searchServer(payload) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${server.address().port}/v2/search` };
}

/** Run eco-web asynchronously so a local server in this process can answer it. */
function runEcoWeb(args, env) {
  return new Promise((done) => {
    const child = spawn(tool("eco-web"), args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

describe("eco-web", () => {
  it("fails loudly without ECO_WORKER_API_KEY", () => {
    const env = { ...process.env };
    delete env.ECO_WORKER_API_KEY;
    const result = spawnSync(tool("eco-web"), ["search", "astro"], { encoding: "utf8", env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("eco-web: FAILED");
  });

  it("fails on zero results instead of reporting success", async () => {
    const { server, url } = await searchServer({ results: [] });
    try {
      const result = await runEcoWeb(["search", "astro"], {
        ...process.env,
        ECO_WORKER_API_KEY: "test-key",
        ECO_WORKER_SEARCH_URL: url,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("eco-web: FAILED");
      expect(result.stdout).toBe("");
    } finally {
      server.close();
    }
  });

  it("prints the title and url of each result", async () => {
    const { server, url } = await searchServer({
      results: [{ url: "https://astro.build/", title: "Astro", text: "A web framework" }],
    });
    try {
      const result = await runEcoWeb(["search", "astro"], {
        ...process.env,
        ECO_WORKER_API_KEY: "test-key",
        ECO_WORKER_SEARCH_URL: url,
      });
      expect(result.status, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Astro");
      expect(result.stdout).toContain("https://astro.build/");
    } finally {
      server.close();
    }
  });

  it("permissions.json allows eco-web", () => {
    const perms = JSON.parse(readFileSync(resolve(ECO, "permissions.json"), "utf8")).permissions;
    expect(perms.allow).toContain("Bash(eco-web:*)");
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
