#!/usr/bin/env bash
# Put eco-worker and diff-review on PATH and check what they need. Safe to run again.
# Usage: ./install.sh            (links into ${INSTALL_BIN_DIR:-$HOME/.local/bin})
# Prints one PASS or FAILED line per check and exits non-zero if any check failed.
set -uo pipefail
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
bin="${INSTALL_BIN_DIR:-$HOME/.local/bin}"
failed=0
pass() { echo "PASS   $*"; }
fail() { echo "FAILED $*"; failed=1; }

mkdir -p "$bin" || { echo "FAILED cannot create $bin"; exit 1; }
for link in "eco-worker:eco-worker/eco-worker.sh" "diff-review:diff-review/diff-review.mjs"; do
  name="${link%%:*}"; target="$here/${link#*:}"
  if chmod +x "$target" && ln -sfn "$target" "$bin/$name"; then pass "linked $bin/$name -> $target"; else fail "could not link $bin/$name"; fi
done

for dep in claude timeout jq python3 node git setsid; do
  if type -P "$dep" > /dev/null; then pass "found $dep"; else fail "missing $dep (install it and run ./install.sh again)"; fi
done
if type -P node > /dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 20 ]; then pass "node $major is 20 or newer"; else fail "node $major is older than 20"; fi
fi
case ":$PATH:" in *":$bin:"*) pass "$bin is on PATH";; *) fail "$bin is not on PATH (add: export PATH=\"$bin:\$PATH\")";; esac
if [ -n "${ECO_WORKER_API_KEY:-}" ]; then pass "ECO_WORKER_API_KEY is set"; else fail "ECO_WORKER_API_KEY is not set (the API key for ${ECO_WORKER_BASE_URL:-https://api.synthetic.new/anthropic})"; fi

if [ "$failed" = 0 ]; then echo "install: PASS"; else echo "install: FAILED (see the lines above)"; fi
exit "$failed"
