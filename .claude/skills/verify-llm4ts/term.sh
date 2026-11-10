#!/usr/bin/env bash
# Drives the built llm4ts CLI on a real terminal: a detached tmux session whose
# shell has a clean environment, the sandbox HOME and the sandbox repository
# as its working directory. Screens are saved beside the run's other evidence.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$here/../../.." && pwd)
tmux_bin=${TMUX_BIN:-tmux}
session=llm4ts
mux() { "$tmux_bin" -L llm4ts-verify "$@"; }

usage() {
  cat <<'USAGE'
term.sh start <run>            open the session; `llm4ts` in it is the built CLI
term.sh keys <tmux keys...>    send keys (text, Enter, Down, C-c, C-u), then wait
term.sh shot <run> <label>     save the screen to <label>.screen.txt and print it
term.sh stop                   kill the session
USAGE
}

command=${1:-help}
[ $# -gt 0 ] && shift
case "$command" in
  start)
    sandbox=$(cd "$("$here/verify.sh" path "$1" sandbox)" && pwd -P)
    node_dir=$(dirname "$(command -v node)")
    mux kill-server 2>/dev/null || true
    printf '#!/bin/sh\nexec node %q "$@"\n' "$repo_root/packages/shell/dist/cli-main.js" >"$sandbox/bin/llm4ts"
    chmod +x "$sandbox/bin/llm4ts"
    mux new-session -d -s "$session" -x 120 -y 36 -c "$sandbox/repo" \
      "env -i PATH=$sandbox/bin:$node_dir:/usr/bin:/bin HOME=$sandbox/home TERM=xterm-256color LANG=en_US.UTF-8 PS1='\$ ' /bin/sh"
    sleep 0.5
    ;;
  keys)
    mux send-keys -t "$session" "$@"
    sleep 0.8
    ;;
  shot)
    evidence="$repo_root/.llm4ts/verify/$1"
    mux capture-pane -p -t "$session" >"$evidence/$2.screen.txt"
    cat "$evidence/$2.screen.txt"
    ;;
  stop)
    mux kill-server 2>/dev/null || true
    ;;
  *)
    usage
    ;;
esac
