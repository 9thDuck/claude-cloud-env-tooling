# claude-cloud-env-tooling

There are two small command-line tools for people who use Claude Code, in a cloud container or on their own machine:

- **eco-worker** runs one headless Claude Code job on a cheaper model, through any Anthropic-compatible endpoint. Routine work such as a scripted edit, a test run or a review then does not use up your main model's quota. Each job ends with a single result line that a caller can rely on.
- **diff-review** gives a diff a second reader. It sends your branch's change to eco-worker together with your repository's review rules and gets back a strict JSON verdict. The verdict is PASS or FAIL, and every finding quotes the rule it breaks. The review is advisory by default.

Both tools are plain Bash and Node scripts and need no build step.

## Install

```bash
git clone https://github.com/9thDuck/claude-cloud-env-tooling.git ~/claude-cloud-env-tooling
cd ~/claude-cloud-env-tooling
export ECO_WORKER_API_KEY=...          # the API key for your endpoint (see below)
export PATH="$HOME/.local/bin:$PATH"   # where install.sh puts the links
./install.sh
```

`install.sh` puts `eco-worker` and `diff-review` on your PATH as links in `~/.local/bin`. Set `INSTALL_BIN_DIR` to link them somewhere else. That directory must already be on PATH. `install.sh` fails its PATH check until it is, so run the `export` line above first. To make it last, add that export line to your shell profile, for example `~/.bashrc`. If `INSTALL_BIN_DIR` is set, that directory must be on PATH instead. The script then checks everything the tools need. It prints one `PASS` or `FAILED` line per check and exits non-zero if any check failed, so it is safe to run from a setup script. You can run it again at any time.

The tools need:

- `claude`, the Claude Code CLI;
- Node 20 or newer;
- `git`, `jq`, `python3`, `timeout` and `setsid`. On Debian and Ubuntu, `coreutils` and `util-linux` provide the last two.

To prove that the reviewer can tell a good diff from a bad one:

```bash
diff-review --self-test    # about 2-5 minutes; makes two real eco-worker runs
diff-review --status       # one line, exit 0 when the last self-test passed and is newer than the tool
```

## eco-worker

```bash
eco-worker "Rename fetchUser to loadUser in src/ and update the tests"
eco-worker -d path/to/repo -t 900 "Run the tests and fix the one failing assertion in src/date.test.js"
eco-worker -b "Long task"          # detach: prints the log and status paths and returns
eco-worker -r <run> "answers.md"   # resume a run that stopped with questions or a plan
```

Every run ends with one line in this form:

```
eco-worker: RESULT=<ok|blocked|error|timeout|killed|no-result|plan-skipped> exit=<n> run=<id> ... files=<n>
```

The exit code is 0 only when `RESULT=ok`. When a run needs a command that its permission list does not allow, it stops with `RESULT=blocked`, and `<logdir>/<run>.blocked.md` names each command it was refused. You can add the rule to the permissions file, or resume the run with `-a "Bash(make:*)"`. When the worker is unsure about the task, it writes up to three questions and stops. When the task touches more than one file, it writes a short plan first and stops. To continue in either case, answer with `-r <run>`.

### Safety

The worker runs with an allow list and a deny list (`eco-worker/permissions.json`), plus a hook that refuses destructive git and `rm` flags anywhere in a command. Its own git pushes go to an address that does not exist. It does not receive `GH_TOKEN` or most of your environment.

These measures stop direct, obvious commands. They are not a sandbox, because a script that the worker runs, for example through `node`, can still do anything your user can do. For hostile code you need an OS-level sandbox. Run the worker on code you trust.

## diff-review

```bash
cd your-repo
diff-review                        # review origin/main...HEAD plus uncommitted and untracked files
diff-review --base origin/develop
diff-review --diff-file change.patch
diff-review --since-verdict .diff-review/<old>/verdict.md   # only what changed since that verdict's head
```

Each run writes these files to `<repo>/.diff-review/<timestamp>/`:

- `diff.patch`, the whole diff;
- `chunks/<n>/`, one per chunk even when there is only one: that chunk's `diff.patch`, `prompt.md`, worker logs and the reviewer's `verdict.json`;
- the rule files;
- `verdict.json`, the run's merged verdict: `{"verdict": "PASS" | "FAIL" | "ERROR", "head", "base", "error", "findings", "untested"}`. An ERROR run says ERROR here too, so a reader of this file can never take a failed run for a PASS;
- `verdict.md`, a readable copy of the merged verdict that records the head sha and lists every chunk and every file covered.

git ignores that folder, and only the newest 20 runs are kept.

| Outcome | Exit (default, advisory) | Exit with `DIFF_REVIEW_BLOCKING=1` |
|---|---|---|
| PASS | 0 | 0 |
| FAIL (findings printed) | 0 | 1 |
| ERROR (no valid verdict, worker failed, setup failed) | 1 | 1 |

A diff larger than `DIFF_REVIEW_CHUNK_CHARS` (20,000 characters by default; set it to change the size) is split into chunks: whole files first, ordered with source and tests before `docs/` and `.beads/`, and a single larger file split by hunk. Each chunk gets its own reviewer run, and up to `DIFF_REVIEW_CONCURRENCY` chunks (2 by default, never fewer than 1) run at the same time; the verdicts are merged in chunk order however the workers finish (any error makes the review an ERROR; any finding makes it a FAIL). Every file in the diff must be covered by a chunk, or the review is an ERROR — nothing is silently dropped. The reviewer reads the repository and must not change it. Its working directory is its chunk directory (inside the repository, and ignored by git), so plain read-only git commands work; it gets a `Read(/<repo root>/**)` rule for absolute-path reads (the run directory instead, when there is no repository, as in `--self-test`), and it runs under `diff-review/reviewer-permissions.json`, which allows only reading commands (no `sort` or `uniq`, which can write a file) and denies every git command that writes, `git -C`, `rm`, `mv`, `cp` and `tee` (`sed` only as `sed -n`); the prompt lists the allowed commands and asks for one command per call, since any refused call blocks the run. These rules are not a security boundary: an allowed command can still write through a shell redirect or `git diff --output`. The run records HEAD, `git status`, and a hash of the tracked changes (`git diff HEAD`) and of every untracked, non-ignored file before and after the reviewers; if any of it changed, or the state cannot be recorded, the review is an ERROR. Ignored paths (such as `node_modules/` and `.diff-review/` itself) and the inside of an untracked nested repository are not covered by that check. A worker that exits 4 (blocked: a call was refused) is an ERROR even if it wrote a verdict, and is not retried; its refused calls are listed. A worker that times out or stalls (exit 124: its `-t` limit or eco-worker's no-output watchdog) is an ERROR and is not retried. A missing or broken `reviewer-permissions.json` is an ERROR before any worker starts, and `--status` counts it among the tool's files. Each run's timeout grows with its chunk and its turn cap: the larger of 600 seconds plus 600 seconds per started 50,000 characters (capped at 3600 seconds) and 30 seconds per allowed turn (capped at 7200 seconds). A chunk is capped at 40 assistant turns plus 1 per started 1,000 characters of the chunk, so the cap grows with the chunk; `DIFF_REVIEW_MAX_TURNS` sets a fixed cap instead; a cap hit without a valid verdict is an ERROR. A chunk that reports an API rate limit (429) is never retried, every running chunk is cancelled, no further chunk starts, and the review is an ERROR naming the chunk and the error text.

### Delta review

`--since-verdict <path-to-earlier-verdict.md>` reviews only what changed since the head sha recorded in that verdict (`- head: <sha>`), plus any file the earlier verdict had a finding in. The new verdict records its own head, the base, `delta since <sha>, earlier verdict <path> (<result>)`, and lists the unchanged files as covered by the earlier verdict. The delta is FAIL if it has findings, and also if an earlier finding is in a file the delta did not re-review. Delta mode refuses an earlier verdict that is an ERROR or whose head is not an ancestor of HEAD.

### Your own rules

If your repository has no config, diff-review uses `diff-review/rules/default-rules.md`, which bans:

- stubs;
- swallowed errors;
- silent fallbacks;
- removing tests without a reason;
- secrets.

It also requires a test for each behaviour change, and names and comments that are accurate. To use your own rules, commit a `.diff-review.json` at the root of the repository:

```json
{
  "project": "A web shop; the checkout code handles real payments.",
  "rules": ["docs/review-rules.md", "CONTRIBUTING.md"],
  "decided": "docs/known-issues.md"
}
```

| Key | Required | Meaning |
|---|---|---|
| `rules` | yes | Files, given as paths relative to the repository, whose rules a finding must quote. |
| `project` | no | One line that tells the reviewer what the code is for. |
| `decided` | no | A file of items that the team has already decided on or is tracking. The reviewer does not raise them again. |

diff-review reads the config and every file it names **from the merge-base commit**, not from your branch. A change therefore cannot rewrite the rules it is judged by. If a file named in the config is missing at that commit, the run ends in an ERROR.

## Environment variables

Only `ECO_WORKER_API_KEY` is required. Every other variable has a default.

| Variable | Default | What it does |
|---|---|---|
| `ECO_WORKER_API_KEY` | (required) | The API key for the endpoint. It is passed to Claude Code as `ANTHROPIC_AUTH_TOKEN`. |
| `ECO_WORKER_BASE_URL` | `https://api.synthetic.new/anthropic` | Any Anthropic-compatible endpoint. |
| `ECO_WORKER_MODEL` | `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` | The model id sent to the endpoint. `-m` overrides it for one run. |
| `ECO_WORKER_TIMEOUT_S` | `1800` | The time limit for one run, in seconds. `-t` overrides it. |
| `ECO_WORKER_STALL_S` | `600` | A run that writes no log output for this many seconds is stopped. |
| `ECO_WORKER_NO_RETRY_429` | `0` | Set to `1` to end the leg at the first API 429 instead of letting the API client retry it. diff-review sets it to `1`. |
| `ECO_WORKER_MAX_TURNS` | (none) | End the leg after more than this many assistant turns; reported as `error_max_turns` on the RESULT line. diff-review passes its per-chunk cap (see `DIFF_REVIEW_MAX_TURNS`). |
| `ECO_WORKER_LOG_DIR` | `<workdir>/.eco-worker` | Where logs, status, questions and plans go. The folder ignores itself in git. |
| `ECO_WORKER_PERMISSIONS` | `eco-worker/permissions.json` | Your own allow and deny lists, in the same shape as the bundled file. |
| `ECO_WORKER_FORWARD_ENV` | (none) | Extra variable names, separated by spaces, to pass to the worker, for example `DATABASE_URL SITE_URL`. The worker gets only a minimal environment: PATH, HOME, proxy and certificate settings, and locale. |
| `ECO_WORKER_MCP_CONFIG` | (none) | An MCP config file to pass to the worker as `--mcp-config`. |
| `DIFF_REVIEW_BASE` | `origin/main` | The ref to review against. `--base` overrides it. |
| `DIFF_REVIEW_BLOCKING` | (off) | Set it to `1` to make a FAIL exit 1. |
| `DIFF_REVIEW_WORKER` | the bundled `eco-worker` | The command that runs the review. It is called as `<cmd> -t <seconds> -a "Read(/<repo root>/**)" -d <chunk dir> "<prompt>"` with `ECO_WORKER_LOG_DIR` set to the chunk directory and `ECO_WORKER_PERMISSIONS` set to `diff-review/reviewer-permissions.json`. |
| `DIFF_REVIEW_TIMEOUT_SECONDS` | computed from the chunk | A positive integer that overrides the per-chunk worker timeout. The default is the larger of 600s plus 600s per started 50,000 characters (capped at 3600s) and 30s per allowed turn (capped at 7200s). |
| `DIFF_REVIEW_CONCURRENCY` | `2` | How many chunk reviewers run at the same time. Values below 1 are treated as 1; a non-numeric value uses the default. |
| `DIFF_REVIEW_MAX_TURNS` | derived: 40 + 1 per started 1,000 chars of the chunk | Assistant turns allowed per chunk, passed to the worker. A chunk that hits the cap without a valid verdict is an ERROR. |
| `DIFF_REVIEW_CHUNK_CHARS` | `20000` | Target chunk size in characters. A value that is not an integer of at least 5000 is an ERROR before any review starts. |
| `INSTALL_BIN_DIR` | `~/.local/bin` | Where `install.sh` puts the links. |
| `XDG_STATE_HOME` | `~/.local/state` | The self-test record is kept under `diff-review/` here. |

Inside a run, the worker sets `ECO_WORKER=1`. Your own scripts can check it and refuse to run under the worker.

## In a cloud environment setup script

```bash
export PATH="$HOME/.local/bin:$PATH"   # where install.sh puts the links
git clone --depth 1 https://github.com/9thDuck/claude-cloud-env-tooling.git "$HOME/claude-cloud-env-tooling" \
  && "$HOME/claude-cloud-env-tooling/install.sh" --no-key-check
```

Store `ECO_WORKER_API_KEY` as an environment secret, not in the script. A setup script may run before secrets are visible, so `--no-key-check` skips that one check and says so; every other check still runs.

## Development

```bash
npm install
npm test               # vitest: verdict parsing, config, rule loading from the merge-base, deny hook
npm run self-test      # real end-to-end run (needs ECO_WORKER_API_KEY)
```
