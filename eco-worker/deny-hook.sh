#!/usr/bin/env bash
# PreToolUse hook for eco-worker legs. Prefix rules see only the start of a command, so a destructive flag placed later
# (git commit -m x --amend, git checkout -b x -f, rm -fr) slips past them; this checks each command segment. The command is split
# with a shell tokenizer and heredoc bodies are dropped. Exit 2 refuses the call, and each refusal is appended
# to $ECO_WORKER_HOOK_LOG so the wrapper reports it like a permission denial.
# Like the lists, it sees only the command text: node and other interpreters can still run anything.
set -uo pipefail
cmd="$(jq -r '.tool_input.command // empty')"
[ -n "$cmd" ] || exit 0
# Split with a shell tokenizer, so quotes are removed as the shell would ('--amend' is --amend) and a quoted
# message stays one word. A newline separates commands; a heredoc body is skipped. Long options match any unambiguous abbreviation.
why="$(printf '%s' "$cmd" | python3 -I -c '
import shlex, sys
cmd = sys.stdin.read()
lines, toks, buf, i = cmd.split("\n"), [], "", 0
# Tokenize line by line: a newline separates commands, an open quote joins the next line, and a heredoc body is data.
while i < len(lines):
    buf = (buf + "\n" if buf else "") + lines[i]; i += 1
    try:
        lx = shlex.shlex(buf, posix=True, punctuation_chars=True); lx.whitespace_split = True; lt = list(lx)
    except ValueError as e:
        if i < len(lines): continue
        print("command could not be parsed (%s)" % e); sys.exit()
    toks += lt + [";"]; buf = ""
    for k, t in enumerate(lt[:-1]):
        if t in ("<<", "<<-"):
            d = lt[k + 1]
            while i < len(lines) and (lines[i].lstrip("\t") if t == "<<-" else lines[i]) != d: i += 1
            i += 1
segs, cur = [], []
for t in toks:
    if t and set(t) <= set(";&|()<>"):
        segs.append(cur); cur = []
    else:
        cur.append(t)
segs.append(cur)
def has(args, short, longs):
    for a in args:
        if a == "--": break
        if a.startswith("--"):
            n = a.split("=", 1)[0]
            if len(n) > 2 and any(l.startswith(n) for l in longs): return True
        elif a.startswith("-") and len(a) > 1 and short and any(c in a[1:] for c in short): return True
    return False
def check(w):
    while w and "=" in w[0] and not w[0].startswith("-"): w = w[1:]
    while w and w[0] in ("env", "command", "exec", "nohup", "time"): w = w[1:]
    if not w: return ""
    h = w[0].rsplit("/", 1)[-1]
    if h == "git":
        j = 1
        while j < len(w) and w[j].startswith("-"):
            j += 2 if w[j] in ("-c", "-C") else 1
        if j >= len(w): return ""
        sub, rest = w[j], w[j+1:]
        if sub in ("push","reset","stash","clean","rebase","restore","filter-branch","update-ref","send-pack"): return "git %s is not allowed for eco-worker" % sub
        if sub == "commit" and has(rest, "", ["--amend"]): return "git commit --amend rewrites a commit"
        if sub in ("checkout","switch") and has(rest, "f", ["--force","--discard-changes"]): return "git %s with a force flag discards work" % sub
        if sub in ("fetch","pull","clone") and has(rest, "u", ["--upload-pack"]): return "git %s with --upload-pack runs a program" % sub
        if sub == "grep" and has(rest, "O", ["--open-files-in-pager"]): return "git grep -O runs a program"
    elif h == "rm":
        if has(w[1:], "rR", ["--recursive"]): return "recursive rm"
    elif h == "gh": return "gh is not allowed for eco-worker"
    return ""
for s in segs:
    r = check(s)
    if r: print(r); break
')" || { echo "eco-worker: deny hook failed to run python3" >&2; exit 2; }
[ -z "$why" ] && exit 0
# shellcheck disable=SC2016  # literal backticks, as in blocked.md
[ -n "${ECO_WORKER_HOOK_LOG:-}" ] && jq -cn --arg c "$cmd" --arg w "$why" '{command: $c, why: $w}' >> "$ECO_WORKER_HOOK_LOG.json" && printf -- '- DENIED (hook: %s) Bash: `%s`\n' "$why" "$cmd" >> "$ECO_WORKER_HOOK_LOG"
echo "eco-worker refused this command: $why. This refusal is final; do not retry or rephrase it, and name it under Blocked in progress.md." >&2
exit 2
