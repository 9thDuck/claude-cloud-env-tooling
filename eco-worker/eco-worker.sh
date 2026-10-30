#!/usr/bin/env bash
# eco-worker: run one headless Claude Code job on a cheaper Anthropic-compatible model, so routine work does not
# spend the main model's quota. See README.md for setup and every environment variable.
# Default timeout 1800 s; override with ECO_WORKER_TIMEOUT_S or -t. A leg with no log output for ECO_WORKER_STALL_S (600) s is killed.
# Usage: eco-worker [-m model-id] [-t secs] [-d dir] [-b] [-a rule]... "<task>"
#        eco-worker -r <run> [-t secs] [-d dir] [-b] [-a rule]... "<answers or path to answers file>"
#   -m  model id sent to the endpoint (default ECO_WORKER_MODEL).
#   -a  allow one more tool rule for this leg only, e.g. -a "Bash(make:*)" after a RESULT=blocked run.
#   -b  detach: survives the caller's shell/turn ending; prints the run's log and status paths and returns.
#   -r  resume: continue run <run> (same Claude session, same log) with the answers to its questions or plan.
# Allowed and denied tools come from permissions.json next to this script, or ECO_WORKER_PERMISSIONS.
# A worker in doubt writes <logdir>/<run>.questions.md (max 3, each with its proposed reading) and stops; on
# anything beyond a one-file fix it writes a <=15-line <logdir>/<run>.plan.md first and stops.
# Each leg ends with exactly one line
# "eco-worker: RESULT=<ok|blocked|error|timeout|killed|no-result|plan-skipped> exit=<n> run=<id> ... asked=<none|plan|questions> files=<n>"
# appended to the log and replacing the status file. Exit is nonzero unless RESULT=ok: 3 rejected key, 4 blocked,
# 5 plan-skipped, 6 result without permission_denials, 7 guardrails edited, 124 timeout, 143 killed.
# A refused tool call is never silent: the run ends RESULT=blocked exit=4 (or, if the leg also failed another way, that
# result with denied= and blocked= on the line), and <logdir>/<run>.blocked.md lists each refused
# command. The caller either adds the rule to permissions.json (real tasks need it) or resumes with -a.
# Rule forms: prefix rules match the command text only; a rule on an interpreter wrapper (Bash(bash x:*)) never matches,
# and acceptEdits mode allows file edits and rm inside the workdir. The lists stop direct commands only: node, pnpm, npx,
# bun, find -exec, sed e and awk system() run child processes, so the lists are not a security boundary (that needs an OS
# sandbox). For the same reason the RESULT is read from the run log, which the worker could rewrite.
# What follows are speed bumps for direct spellings, not defences: git push from the worker defaults to a dead URL for
# https, http, ssh, git and scp-style remotes (pushInsteadOf env, which a child can undo); GH_TOKEN is not forwarded, but
# HOME is, so a gh spawned through node could still use an auth file there; ECO_WORKER=1 is set in the worker so your own
# scripts can refuse to run under it; a leg that changes the wrapper, permissions.json or .claude/ settings or hooks ends
# exit 7. Git that discards work or moves the shared worktree (restore, rm, checkout/switch to a branch, branch renames)
# is not allowed, and deny-hook.sh refuses destructive flags anywhere in a command (--amend, -f, --discard-changes, rm -R, gh).
set -uo pipefail
model="${ECO_WORKER_MODEL:-hf:deepseek-ai/DeepSeek-V4.1-Flash-1017}"; timeout_s="${ECO_WORKER_TIMEOUT_S:-1800}"
base_url="${ECO_WORKER_BASE_URL:-https://api.synthetic.new/anthropic}"
workdir="$PWD"; detach=0; resume=""; extra=()
while getopts "m:t:d:br:a:" o; do case "$o" in
  m) model="$OPTARG";; t) timeout_s="$OPTARG";; d) workdir="$OPTARG";; b) detach=1;; r) resume="$OPTARG";; a) extra+=("$OPTARG");;
  *) echo "usage: eco-worker [-m model-id] [-t secs] [-d dir] [-b] [-r run] [-a rule]... \"task|answers\"" >&2; exit 2;; esac; done
shift $((OPTIND-1)); task="${1:-}"
[ -n "$task" ] || { echo "eco-worker: FAILED no task given" >&2; exit 2; }
[ -n "${ECO_WORKER_API_KEY:-}" ] || { echo "eco-worker: FAILED ECO_WORKER_API_KEY not set (the API key for $base_url)" >&2; exit 2; }
case "$timeout_s" in ''|*[!0-9]*) echo "eco-worker: FAILED -t needs whole seconds" >&2; exit 2;; esac
case "${ECO_WORKER_STALL_S:-600}" in ''|*[!0-9]*) echo "eco-worker: FAILED ECO_WORKER_STALL_S needs whole seconds" >&2; exit 2;; esac
case "$model" in ''|*[[:space:]]*) echo "eco-worker: FAILED bad model id '$model'" >&2; exit 2;; esac
for b in claude timeout jq python3 git setsid; do bp="$(type -P "$b")"; [ -n "$bp" ] || { echo "eco-worker: FAILED '$b' not found" >&2; exit 2; }; done
[ -d "$workdir" ] || { echo "eco-worker: FAILED -d dir does not exist" >&2; exit 2; }
perms="${ECO_WORKER_PERMISSIONS:-$(dirname "$(readlink -f "$0")")/permissions.json}"
[ "$(jq '(.permissions.allow | length > 0) and ([.permissions.deny[] | select(. == "Bash(git push:*)")] | length == 1)' "$perms")" = true ] || { echo "eco-worker: FAILED $perms missing or not a permissions file (needs a non-empty allow list and a Bash(git push:*) deny)" >&2; exit 2; }
perms="$(readlink -f "$perms")"
fwd=()
for v in ${ECO_WORKER_FORWARD_ENV:-}; do
  [[ "$v" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "eco-worker: FAILED ECO_WORKER_FORWARD_ENV holds '$v', which is not a variable name" >&2; exit 2; }
  fwd+=("$v")
done
workdir="$(cd "$workdir" && pwd)"
run="$(date +%Y%m%dT%H%M%S)-$$-$RANDOM$RANDOM"
logdir="${ECO_WORKER_LOG_DIR:-$workdir/.eco-worker}"; mkdir -p "$logdir" || { echo "eco-worker: FAILED cannot create $logdir" >&2; exit 2; }
logdir="$(cd "$logdir" && pwd)"
# Run files must not show up in git status, diffs or the changed-file count, without touching the repo's own .gitignore.
[ -f "$logdir/.gitignore" ] || echo '*' > "$logdir/.gitignore"
sid=""
if [ -n "$resume" ]; then
  case "$resume" in */*|.*|'') echo "eco-worker: FAILED -r needs a run id, not a path" >&2; exit 2;; esac
  run="$resume"
  [ -f "$logdir/$run.log" ] || { echo "eco-worker: FAILED no log for run $run in $logdir" >&2; exit 2; }
  sid="$(grep -o '"session_id":"[^"]*"' "$logdir/$run.log" | head -1 | cut -d'"' -f4)"
  [ -n "$sid" ] || { echo "eco-worker: FAILED no session id in $logdir/$run.log; cannot resume" >&2; exit 2; }
  case "$task" in */*.md|*.txt) [ -f "$task" ] || { echo "eco-worker: FAILED answers file $task not found (relative to $PWD)" >&2; exit 2; };; esac
  [ -f "$task" ] && task="$(cat "$task")"
fi
log="$logdir/$run.log"; status="$logdir/$run.status"
if [ "$detach" = 1 ]; then
  args=(-m "$model" -t "$timeout_s" -d "$workdir"); [ -n "$resume" ] && args+=(-r "$resume")
  for a in "${extra[@]}"; do args+=(-a "$a"); done
  echo "starting" > "$status"
  # the child writes everything to $log and its final line to $status
  ECO_WORKER_LOG_DIR="$logdir" ECO_WORKER_DETACHED_RUN="$run" setsid nohup "$(readlink -f "$0")" "${args[@]}" "$task" >>"$log.detach" 2>&1 < /dev/null &
  echo "eco-worker: detached run=$run log=$log status=$status"; exit 0
fi
[ -n "${ECO_WORKER_DETACHED_RUN:-}" ] && { run="$ECO_WORKER_DETACHED_RUN"; log="$logdir/$run.log"; status="$logdir/$run.status"; }
hook="$(dirname "$(readlink -f "$0")")/deny-hook.sh"; hlog="$logdir/$run.hookdenied"
qfile="$logdir/$run.questions.md"; pfile="$logdir/$run.plan.md"; bfile="$logdir/$run.blocked.md"
progress="$logdir/$run.progress.md"
cfg="$logdir/$run.cfg"; gfile="$logdir/$run.guard"
# Hashes the source rules, the wrapper, the leg's effective settings in $cfg and .claude/ settings and hooks.
# guard src skips $cfg, which every leg rebuilds, so a tampered $cfg never outlives its leg.
guard() { { sha256sum "$perms" "$(readlink -f "$0")" "$hook"; [ "${1:-}" != src ] && [ -f "$cfg/permissions.json" ] && sha256sum "$cfg/permissions.json" "$cfg/settings.json"; [ -d "$workdir/.claude" ] && find "$workdir/.claude" -type f \( -path '*/settings*.json' -o -path '*/hooks/*' \) | sort | xargs -r sha256sum; ghd=$(git -C "$workdir" rev-parse --path-format=absolute --git-path hooks 2>/dev/null); [ -d "$ghd" ] && find "$ghd" -type f ! -name "*.sample" | sort | xargs -r sha256sum; } | sha256sum; }
# Baseline per leg, so the caller may add a rule between legs. After an exit-7 leg the baseline it saved stays in
# force: a resume is refused until the caller reverts the worker's guardrail edits.
if [ -n "$resume" ] && [ -f "$gfile" ] && grep -q ' exit=7 ' "$status"; then
  [ "$(guard src)" = "$(cat "$gfile")" ] || { echo "eco-worker: FAILED run $run ended exit=7 (guardrails edited) and they still differ; revert the worker's edits to the wrapper, $perms, .claude/ or .git/hooks, then resume" >&2; exit 7; }
fi
guard0=""; nodenials=0; guardedit=0
rc=""; denyhit=0; finished=0; autherr=0; cpid=""; stalled=0; stall_s="${ECO_WORKER_STALL_S:-600}"
off=0; [ -f "$log" ] && off=$(stat -c %s "$log")
hcount() { [ -f "$hlog" ] && awk '/^- DENIED /{n++} END{print n+0}' "$hlog" || echo 0; }
leg() { [ -f "$log" ] && tail -c +$((off+1)) "$log"; }
# shellcheck disable=SC2120  # finish takes an optional result; the EXIT trap and the normal end call it bare.
finish() {
  [ "$finished" = 1 ] && return; finished=1
  local r="${1:-$rc}" result legtxt res denied=""
  legtxt="$(leg)"
  res="$(printf '%s\n' "$legtxt" | jq -cR 'fromjson? | select(type == "object" and .type == "result")' | tail -1)"
  if [ "$autherr" = 1 ]; then result=error; r=3
  elif [ "$stalled" = 1 ]; then result=timeout; r=124
  elif [ "$r" = 124 ]; then result=timeout
  elif [ "$r" = killed ]; then result=killed; r=143
  elif [ -z "$res" ]; then result=no-result; { [ -z "$r" ] || [ "$r" = 0 ]; } && r=1
  elif [ "$(printf '%s' "$res" | jq -r '.is_error')" = true ]; then result=error; [ "$r" = 0 ] && r=1
  elif [ "$(printf '%s' "$res" | jq 'has("permission_denials")')" != true ]; then result=error; r=6; nodenials=1
  else result=ok; r=0; fi
  # The worker can write its own guardrails; a changed wrapper or permissions file fails the run.
  [ -n "$guard0" ] && [ "$(guard)" != "$guard0" ] && { result=error; r=7; guardedit=1; echo "$gsrc0" > "$gfile"; }
  # A refused tool call is a question for the caller, never a silent ok: headless -p has nobody to ask.
  # Refusals come from three places: the result's permission_denials, the deny hook's log, and, when the leg died
  # before a result (timeout, stall, kill), the refusal messages in the stream itself.
  local pd=0 hd=0 sd=0
  [ -n "$res" ] && pd=$(printf '%s' "$res" | jq '.permission_denials | length')
  # The result usually lists hook refusals too, so take the larger count rather than the sum when there is one.
  hd=$(hcount)  # the log is emptied at leg start (below), so it holds only this leg
  [ -z "$res" ] && sd=$(printf '%s\n' "$legtxt" | grep -c -e 'This command requires approval' -e 'Permission to use [A-Za-z]* with command .* has been denied')
  if [ -n "$res" ]; then denied=$(( pd > hd ? pd : hd )); else denied=$((hd + sd)); fi
  if [ "$denied" -gt 0 ]; then
    # Deny beats allow, so -a cannot lift a refusal a deny rule or the hook caused; mark those.
    { echo "# Refused tool calls in run $run"; echo "Rules come from $perms and $hook. A NOT ALLOWED call: add an allow rule there if real tasks need it, or resume with -a. A DENIED call matched a deny rule or the hook: -a cannot lift it; only changing that rule can."
      [ "$pd" -gt 0 ] && printf '%s' "$res" | jq -r --slurpfile p "$cfg/permissions.json" --slurpfile hk "$hlog.json" '[$hk[].command] as $hc | [$p[0].permissions.deny[] | capture("^Bash\\((?<x>.*):\\*\\)$").x] as $dp | .permission_denials[] | (.tool_input.command // "") as $c | [$c | splits("&&|\\|\\||;|\\|") | ltrimstr(" ") ] as $seg | "- \(if any($dp[]; . as $x | any($seg[]; startswith($x))) then "DENIED" elif any($hc[]; . == $c) then "DENIED (hook)" else "NOT ALLOWED" end) \(.tool_name): `\(.tool_input.command // .tool_input.file_path // (.tool_input | tostring))`"'
      [ "$hd" -gt 0 ] && cat "$hlog"
      [ "$sd" -gt 0 ] && echo "- $sd refused call(s) found in $log; the leg ended without a result, so the commands are only in the log (search 'requires approval' / 'has been denied')."
    } > "$bfile"
    denyhit=$(grep -c '^- DENIED ' "$bfile")
    [ "$result" = ok ] && { result=blocked; r=4; }
  fi
  local retries; retries="$(printf '%s\n' "$legtxt" | awk '/"subtype":"api_retry"/{n++} END{print n+0}')"
  local asked=none
  [ -f "$pfile" ] && [ "$pfile" -nt "$status" ] && asked=plan
  [ -f "$qfile" ] && [ "$qfile" -nt "$status" ] && asked=questions
  # Mechanical plan stop: >1 changed file with no plan and no resume means the plan step was skipped.
  local files=0
  if [ -f "$logdir/$run.prehead" ]; then
    # Count only files this run changed: lines not in the porcelain snapshot taken before the model started.
    # Committed work counts too: diff against the HEAD taken before the model started, plus new untracked files.
    files="$({ git -C "$workdir" diff --name-only "$(cat "$logdir/$run.prehead")"; git -C "$workdir" ls-files -o --exclude-standard --full-name; } | sort -u | grep -vxF -f <(cut -c4- "$logdir/$run.pre" | sed "s/.* -> //") -c)"
  fi
  if [ "$result" = ok ] && [ "$asked" = none ] && [ -z "$resume" ] && [ "$files" -gt 1 ]; then
    result=plan-skipped; r=5
  fi
  local line="eco-worker: RESULT=$result exit=$r run=$run api_retries=$retries denied=${denied:-0} asked=$asked files=$files"
  [ "$autherr" = 1 ] && line="$line error=api-auth-rejected(401/403): check ECO_WORKER_API_KEY and ECO_WORKER_BASE_URL"
  [ "${denied:-0}" -gt 0 ] && [ -n "$res" ] && line="$line denied_tools=$(printf '%s' "$res" | jq -r '[.permission_denials[].tool_name] | join(",")') blocked=$bfile"
  [ "$result" != ok ] && [ "$result" != blocked ] && [ -n "$res" ] && line="$line error=$(printf '%s' "$res" | jq -r '.result // .subtype' | head -c 300 | tr '\n' ' ')"
  [ "$nodenials" = 1 ] && line="$line error=result-has-no-permission_denials(cannot prove no refusals)"
  [ "$guardedit" = 1 ] && line="$line error=guardrails-edited: this leg changed the wrapper, $perms or .claude/ settings or hooks; review and revert"
  [ "$result" = plan-skipped ] && line="$line plan_skipped=files:$files"
  echo "$line" | tee -a "$log"; echo "$line" > "$status"; rc="$r"
  # A failed leg is the caller's problem to fix, not to absorb: redoing the task on the main model spends the quota eco-worker exists to save.
  if [ "$result" != ok ]; then
    local fix
    case "$result" in
      blocked) fix="read $bfile; add each NOT ALLOWED rule real tasks need to $perms (then resume) or resume once with -a '<rule>'"
               [ "${denyhit:-0}" -gt 0 ] && fix="$fix; $denyhit DENIED call(s) matched a deny rule, which -a cannot lift: leave them refused unless you decide to remove that deny entry";;
      timeout) fix="the run hit ${timeout_s}s or stalled; resume with -r $run and a larger -t, or split the task";;
      plan-skipped) fix="the worker changed $files files without a plan; review the diff, then resume with -r $run";;
      *) fix="read the last lines of $log; fix the cause, then resume with -r $run"
         [ "$guardedit" = 1 ] && fix="this leg edited its own guardrails; revert those edits first (a resume is refused until they match the saved baseline), then resume with -r $run";;
    esac
    [ "$result" != blocked ] && [ "${denied:-0}" -gt 0 ] && fix="$fix; this leg also refused commands, listed in $bfile"
    echo "eco-worker: CALLER ACTION REQUIRED ($result): $fix. Do not redo this task on the main model; if the cause cannot be fixed, report it with this line." | tee -a "$log" >&2
  fi
}
trap '[ -n "$cpid" ] && { kill "$cpid"; wait "$cpid"; }; finish killed; exit 143' TERM INT HUP
mkdir -p "$cfg"
: > "$logdir/$run.pre"; rm -f "$logdir/$run.prehead"
git -C "$workdir" rev-parse --git-dir >> "$logdir/$run.pre.err" 2>&1 && git -C "$workdir" -c core.quotePath=false status --porcelain > "$logdir/$run.pre" && git -C "$workdir" rev-parse HEAD > "$logdir/$run.prehead" 2>> "$logdir/$run.pre.err"
[ -x "$hook" ] || { echo "eco-worker: FAILED $hook missing or not executable" | tee -a "$log" >&2; exit 2; }
: > "$hlog"; : > "$hlog.json"
jq -n --arg h "$hook" '{attribution: false, hooks: {PreToolUse: [{matcher: "Bash", hooks: [{type: "command", command: $h}]}]}}' > "$cfg/settings.json"
xa="$(printf '%s\n' "${extra[@]}" | jq -R 'select(length>0)' | jq -s .)"
jq --argjson xa "$xa" '.permissions.allow += $xa' "$perms" > "$cfg/permissions.json" || { echo "eco-worker: FAILED cannot build $cfg/permissions.json" | tee -a "$log" >&2; exit 2; }
gsrc0="$(guard src)"; guard0="$(guard)"  # after $cfg is built, so the leg's own -a rules are the baseline
if [ -n "$resume" ]; then
  task="ANSWERS from the caller to your questions or plan. Apply them, continue the task, and finish under the same WORKER RULES. Do not ask again; if something is still unclear take the safer reading and list it under 'Assumed' in $progress using the Edit or Write tool. A refused command is final for this run: do not retry it or rephrase it (another path, bash -c, a copy in /tmp); carry on with what you can and name it under 'Blocked' in $progress. The caller sees every refusal. For the web use Bash \`eco-web search \"query\"\` and \`eco-web fetch URL\` (WebSearch and WebFetch do not work on this endpoint).

$task"
else
  task="WORKER RULES: ~$((timeout_s/60)) min, may be killed. After every step append one line to $progress using the Edit or Write tool. Never push. A refused command is final for this run: do not retry it or rephrase it (another path, bash -c, a copy in /tmp); carry on with what you can and name it under 'Blocked' in $progress. The caller sees every refusal. For the web use Bash \`eco-web search \"query\"\` and \`eco-web fetch URL\` (WebSearch and WebFetch do not work on this endpoint). Stop when the outcome is met; list extras instead of doing them.
ASKING: never guess on a point that changes acceptance or where you see two readings. Write at most 3 questions, each with the reading you would take and why, to $qfile and stop immediately; the caller answers and resumes you. If the task touches more than one file, first write a plan of at most 15 lines (files, the existing code you will copy from, tests you will add) to $pfile and stop before any code change. One plan stop and one question stop per task at most; if nothing is in doubt, write neither file.

$task"
fi
echo "eco-worker: model=$model run=$run log=$log${sid:+ resume=$sid}"; echo "running" > "$status"
cd "$workdir" || { echo "eco-worker: FAILED cannot cd to $workdir" | tee -a "$log" >&2; exit 2; }
# Installed after the last pre-flight exit, so a pre-flight failure never writes a RESULT line for a leg that never ran.
trap 'finish' EXIT
envargs=(PATH="$(dirname "$(readlink -f "$0")"):$PATH" HOME="$HOME")
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS NODE_OPTIONS \
         REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO LANG LC_ALL TERM TMPDIR USER SHELL \
         NODE_PATH PLAYWRIGHT_BROWSERS_PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD GH_NO_UPDATE_NOTIFIER ${fwd[@]+"${fwd[@]}"}; do
  [ -n "${!v:-}" ] && envargs+=("$v=${!v}")
done
# eco-web lives next to this script and needs the same key; env -i would otherwise leave it without either.
envargs+=(ECO_WORKER_API_KEY="$ECO_WORKER_API_KEY")
[ -n "${ECO_WORKER_SEARCH_URL:-}" ] && envargs+=("ECO_WORKER_SEARCH_URL=$ECO_WORKER_SEARCH_URL")
# A push the worker starts goes to a URL that cannot exist, unless a child process rewrites its own environment.
envargs+=(ECO_WORKER=1 ECO_WORKER_HOOK_LOG="$hlog" GIT_CONFIG_COUNT=5 GIT_CONFIG_KEY_0=url.eco-worker-no-push:/.pushInsteadOf GIT_CONFIG_VALUE_0=https://
          GIT_CONFIG_KEY_1=url.eco-worker-no-push:/.pushInsteadOf GIT_CONFIG_VALUE_1=http://
          GIT_CONFIG_KEY_2=url.eco-worker-no-push:/.pushInsteadOf GIT_CONFIG_VALUE_2=git@
          GIT_CONFIG_KEY_3=url.eco-worker-no-push:/.pushInsteadOf GIT_CONFIG_VALUE_3=ssh://
          GIT_CONFIG_KEY_4=url.eco-worker-no-push:/.pushInsteadOf GIT_CONFIG_VALUE_4=git://)
# The worker runs under its own config dir, so your user MCP config never reaches it: pass one explicitly if you need it.
mcp=(); [ -n "${ECO_WORKER_MCP_CONFIG:-}" ] && mcp=(--mcp-config "$ECO_WORKER_MCP_CONFIG")
env -i "${envargs[@]}" \
CLAUDE_CONFIG_DIR="$cfg" ANTHROPIC_BASE_URL="$base_url" ANTHROPIC_AUTH_TOKEN="$ECO_WORKER_API_KEY" \
ANTHROPIC_DEFAULT_OPUS_MODEL="$model" ANTHROPIC_DEFAULT_SONNET_MODEL="$model" \
ANTHROPIC_DEFAULT_HAIKU_MODEL="$model" CLAUDE_CODE_SUBAGENT_MODEL="$model" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
timeout "$timeout_s" claude -p --model "$model" --permission-mode acceptEdits ${sid:+--resume "$sid"} ${mcp[@]+"${mcp[@]}"} \
  --settings "$(jq -s '.[0] * .[1]' "$cfg/settings.json" "$cfg/permissions.json")" \
  --output-format stream-json --verbose -- "$task" >> "$log" 2>&1 < /dev/null &
cpid=$!
while [ -d "/proc/$cpid" ]; do
  lt="$(leg)"
  if [[ "$lt" == *'"error_status":401'* || "$lt" == *'"error_status":403'* ]]; then autherr=1; kill "$cpid"; break; fi
  # Stall watchdog: a log with no new line for $stall_s seconds means a hung call; end the run loudly.
  m="$(stat -c %Y "$log")"
  if [ -n "$m" ] && [ "$(( $(date +%s) - m ))" -gt "$stall_s" ]; then stalled=1; echo "eco-worker: STALLED no log output for ${stall_s}s, killing run $run" | tee -a "$log" >&2; kill "$cpid"; break; fi
  sleep 2
done
wait "$cpid"; rc=$?
finish
grep -v "^eco-worker: \(RESULT\|CALLER\)" "$log" | tail -n 5; exit "$rc"
