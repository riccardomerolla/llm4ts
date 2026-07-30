#!/usr/bin/env bash
#
# Seed a runnable repository for an llm4ts example.
#
#   examples/seed.sh implement
#   examples/seed.sh sdd /path/to/project
#   examples/seed.sh implement --run
#   examples/seed.sh issue-pr /path/to/project --prompt "owner/repo#42" --run
#
# The flow stays outside the seeded repository. Only the small starter project
# is copied and committed, so coding agents do not inspect llm4ts itself.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: examples/seed.sh <implement|issue-pr|sdd|local> [dest] [--prompt <text>] [--run]
EOF
  exit 2
}

[ "${1:-}" != "--" ] || shift
EXAMPLE="${1:-}"
[ -n "$EXAMPLE" ] || usage
shift

DEST=""
PROMPT_OVERRIDE=""
RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --run)
      RUN=1
      shift
      ;;
    --prompt)
      [ "$#" -ge 2 ] || usage
      PROMPT_OVERRIDE="$2"
      shift 2
      ;;
    --prompt=*)
      PROMPT_OVERRIDE="${1#--prompt=}"
      shift
      ;;
    --*)
      echo "unknown flag: $1" >&2
      usage
      ;;
    *)
      [ -z "$DEST" ] || {
        echo "only one destination may be supplied" >&2
        usage
      }
      DEST="$1"
      shift
      ;;
  esac
done

case "$EXAMPLE" in
  implement)
    STARTER="calculator-rs"
    SCRIPT="implement"
    DEFAULT_PROMPT="Add a multiply function to the calculator crate, including focused tests."
    TOOLCHAIN="Rust and cargo"
    ;;
  local)
    STARTER="calculator-rs"
    SCRIPT="local"
    DEFAULT_PROMPT="Add a multiply function to the calculator crate, including focused tests."
    TOOLCHAIN="Rust, cargo, LM Studio, and pi"
    ;;
  issue-pr)
    STARTER="calculator-scala"
    SCRIPT="issue-pr"
    DEFAULT_PROMPT=""
    TOOLCHAIN="JDK 21+, sbt, gh, a GitHub remote, and an issue reference"
    ;;
  sdd)
    STARTER="todo-java"
    SCRIPT="sdd"
    DEFAULT_PROMPT="Add due dates: 'add <text> --due YYYY-MM-DD', mark overdue items in 'list', and a 'due' command showing items due today."
    TOOLCHAIN="JDK 21+ and Maven"
    ;;
  *)
    echo "unknown example: $EXAMPLE" >&2
    usage
    ;;
esac

if [ -z "$DEST" ]; then
  TEMP_ROOT="${TMPDIR:-/tmp}"
  DEST="$(mktemp -d "${TEMP_ROOT%/}/llm4ts-$EXAMPLE.XXXXXXXX")"
else
  mkdir -p "$DEST"
  if [ -n "$(find "$DEST" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "destination is not empty: $DEST" >&2
    exit 2
  fi
  DEST="$(cd "$DEST" && pwd)"
fi

STARTER_DIR="$SCRIPT_DIR/starters/$STARTER"
[ -d "$STARTER_DIR" ] || {
  echo "missing starter: $STARTER_DIR" >&2
  exit 1
}

cp -R "$STARTER_DIR/." "$DEST/"
(
  cd "$DEST"
  git init -q -b main
  git add -A
  git -c user.email=seed@llm4ts.dev -c user.name=llm4ts \
    commit -q -m "Seed $EXAMPLE starter"
)

PROMPT="${PROMPT_OVERRIDE:-$DEFAULT_PROMPT}"

echo
echo "Test project ready at: $DEST"
echo "Starter:              $STARTER"
echo "Example:              $SCRIPT"
echo

if [ "$RUN" -eq 1 ]; then
  if [ -z "$PROMPT" ]; then
    echo "The issue-pr flow needs a real owner/repository#number."
    echo "Rerun with --prompt \"owner/repository#42\" --run."
    exit 2
  fi
  echo "Running the flow from the llm4ts workspace..."
  cd "$REPO_ROOT"
  exec pnpm --filter @llm4ts/flows "$SCRIPT" -- --repo "$DEST" "$PROMPT"
fi

if [ -z "$PROMPT" ]; then
  PROMPT="owner/repository#42"
fi

printf 'Run:\n  cd %q\n  pnpm --dir %q --filter @llm4ts/flows %q -- --repo %q %q\n' \
  "$DEST" "$REPO_ROOT" "$SCRIPT" "$DEST" "$PROMPT"
echo
echo "Requirements: $TOOLCHAIN; Git and an authenticated coding CLI."
echo "Select the agent with LLM4TS_CODER=claude|codex|gemini|pi|agy|grok|cursor|opencode."
