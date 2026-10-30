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

The worker reaches the web only through `eco-web`: `eco-web search "query" [n]` prints up to n results with a snippet, and `eco-web fetch <url>` prints a page's text (20000 chars at most).
Both print `eco-web: FAILED <reason>` and exit non-zero when anything goes wrong, including a search that returns zero results.
`WebSearch` and `WebFetch` stay enabled (unchanged behaviour) but do not work here: they are Anthropic server tools that this endpoint ignores (empty search, run still reports ok) or rejects (WebFetch 400). Use eco-web instead. `eco-web --probe-web` runs one live search and one live fetch and reports PASS or FAILED for each.

### Safety

The worker runs with an allow list and a deny list (`eco-worker/permissions.json`), plus a hook that refuses destructive git and `rm` flags anywhere in a command. Its own git pushes go to an address that does not exist. It does not receive `GH_TOKEN` or most of your environment.

These measures stop direct, obvious commands. They are not a sandbox, because a script that the worker runs, for example through `node`, can still do anything your user can do. For hostile code you need an OS-level sandbox. Run the worker on code you trust.

## diff-review

```bash
cd your-repo
diff-review                        # review origin/main...HEAD plus uncommitted and untracked files
diff-review --base origin/develop
diff-review --diff-file change.patch
```

Each run writes these files to `<repo>/.diff-review/<timestamp>/`:

- `diff.patch`;
- `prompt.md`;
- the rule files;
- the reviewer's `verdict.json`;
- `verdict.md`, a readable copy of the verdict.

git ignores that folder, and only the newest 20 runs are kept.

| Outcome | Exit (default, advisory) | Exit with `DIFF_REVIEW_BLOCKING=1` |
|---|---|---|
| PASS | 0 | 0 |
| FAIL (findings printed) | 0 | 1 |
| ERROR (no valid verdict, worker failed, setup failed) | 1 | 1 |

A diff larger than 200,000 characters is cut to that length before the reviewer sees it. A PASS on a cut diff counts as an ERROR, so split such a change into smaller pieces.

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
| `ECO_WORKER_LOG_DIR` | `<workdir>/.eco-worker` | Where logs, status, questions and plans go. The folder ignores itself in git. |
| `ECO_WORKER_PERMISSIONS` | `eco-worker/permissions.json` | Your own allow and deny lists, in the same shape as the bundled file. |
| `ECO_WORKER_FORWARD_ENV` | (none) | Extra variable names, separated by spaces, to pass to the worker, for example `DATABASE_URL SITE_URL`. The worker gets only a minimal environment: PATH, HOME, proxy and certificate settings, and locale. |
| `ECO_WORKER_MCP_CONFIG` | (none) | An MCP config file to pass to the worker as `--mcp-config`. |
| `DIFF_REVIEW_BASE` | `origin/main` | The ref to review against. `--base` overrides it. |
| `DIFF_REVIEW_BLOCKING` | (off) | Set it to `1` to make a FAIL exit 1. |
| `DIFF_REVIEW_WORKER` | the bundled `eco-worker` | The command that runs the review. It is called as `<cmd> -t 600 -d <dir> "<prompt>"`. |
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
