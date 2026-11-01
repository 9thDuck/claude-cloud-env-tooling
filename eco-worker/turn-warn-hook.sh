#!/usr/bin/env bash
# turn-warn-hook: PostToolUse hook eco-worker registers when ECO_WORKER_MAX_TURNS is set (ay7h3).
# Counts this leg's tool calls in <counter-file>; once <left> or fewer calls remain before <max>, it hands the
# worker the text in <message-file> so it writes its result before the cap ends the leg.
# Usage: turn-warn-hook.sh <counter-file> <max> <left> <message-file>   (hook input JSON on stdin, unused)
set -uo pipefail
counter="$1"; max="$2"; left="$3"; message="$4"
cat > /dev/null
n=0
[ -s "$counter" ] && n="$(cat "$counter")"
n=$((n + 1))
printf '%s\n' "$n" > "$counter"
remaining=$((max - n))
[ "$remaining" -gt "$left" ] && exit 0
[ "$remaining" -lt 0 ] && remaining=0
unit="tool calls"; [ "$remaining" = 1 ] && unit="tool call"
jq -n --arg m "$(cat "$message")" --arg r "$remaining $unit left" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: ("TURN CAP: \($r) before this run is ended. \($m)")}}'
