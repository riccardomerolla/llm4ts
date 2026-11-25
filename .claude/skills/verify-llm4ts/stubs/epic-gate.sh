#!/bin/sh
# A gate for the epic stub: red in the worktree of story `add` while the flag file exists.
# usage (as LLM4TS_GATES): sh epic-gate.sh <flag-file>
if [ -f "$1" ]; then
  case "$PWD" in
    */add)
      echo "gate: add is red"
      exit 1
      ;;
  esac
fi
exit 0
