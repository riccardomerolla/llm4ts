#!/usr/bin/env bash
# Drives the locally built llm4ts CLI in an isolated sandbox and records proof.
# Usage is in SKILL.md next to this file; `verify.sh help` prints the commands.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
cli="$repo_root/packages/shell/dist/cli-main.js"
evidence_root="$repo_root/.llm4ts/verify"

die() {
  echo "verify: $*" >&2
  exit 2
}

evidence_dir() {
  local dir="$evidence_root/$1"
  [ -d "$dir" ] || die "unknown run '$1' (no $dir); start one with: verify.sh new"
  echo "$dir"
}

sandbox_dir() {
  local file
  file="$(evidence_dir "$1")/sandbox.path"
  [ -f "$file" ] || die "run '$1' has no sandbox (already cleaned up?)"
  local dir
  dir="$(cat "$file")"
  [ -d "$dir" ] || die "sandbox $dir is gone; start a new run"
  echo "$dir"
}

cmd_build() {
  (cd "$repo_root" && pnpm build)
}

cmd_doctor() {
  local failed=0
  check() {
    if [ "$1" = ok ]; then echo "ok    $2"; else
      echo "FAIL  $2"
      failed=1
    fi
  }

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -ge 22 ]; then check ok "node $(node -v) >= 22"; else check fail "node $(node -v) < 22"; fi

  if [ -f "$cli" ]; then check ok "built CLI at ${cli#"$repo_root"/}"; else
    check fail "no built CLI at ${cli#"$repo_root"/}; run: verify.sh build"
    return 1
  fi

  local want got
  want="$(node -p "require('$repo_root/packages/shell/package.json').version")"
  got="$(node "$cli" --version 2>&1 | sed 's/^llm4ts v//')"
  if [ "$want" = "$got" ]; then check ok "CLI reports v$got, as packages/shell/package.json"; else check fail "CLI reports v$got, package.json says v$want"; fi

  # Staleness is judged against tsc's build info, which is rewritten on every
  # build; emitted .js files keep their old mtime when their content is unchanged.
  local stale="" stamp pkg
  for pkg in core flow runner js shell; do
    stamp="$repo_root/packages/$pkg/.tsbuildinfo/src.tsbuildinfo"
    if [ ! -f "$stamp" ]; then
      stale="$stale packages/$pkg(never built)"
    elif [ -n "$(find "$repo_root/packages/$pkg/src" -name '*.ts' -newer "$stamp" -print -quit)" ]; then
      stale="$stale packages/$pkg"
    fi
  done
  if [ -z "$stale" ]; then check ok "dist is not older than packages/*/src"; else check fail "source newer than the build in:$stale; run: verify.sh build"; fi

  # Built-in flows run from packages/shell/flows/*.js, transpiled from flows/*.ts by the build.
  local drift="" source bundled
  while IFS= read -r source; do
    bundled="$repo_root/packages/shell/flows/${source#"$repo_root"/flows/}"
    bundled="${bundled%.ts}.js"
    if [ ! -f "$bundled" ] || [ "$source" -nt "$bundled" ]; then
      drift="$drift ${source#"$repo_root"/}"
    fi
  done < <(find "$repo_root/flows" -maxdepth 1 -name '*.ts'; find "$repo_root/flows/lib" -name '*.ts' 2>/dev/null)
  if [ -z "$drift" ]; then check ok "bundled flows are not older than flows/"; else check fail "flows edited since the build:$drift; run: verify.sh build"; fi

  return "$failed"
}

cmd_new() {
  local id="${1:-$(date +%Y%m%d-%H%M%S)-$$}"
  local evidence="$evidence_root/$id"
  [ -e "$evidence" ] && die "run '$id' already exists"
  local sandbox
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/llm4ts-verify-XXXXXX")"
  mkdir -p "$evidence" "$sandbox/home" "$sandbox/bin" "$sandbox/repo"
  echo "$sandbox" >"$evidence/sandbox.path"
  git -C "$sandbox/repo" init -q -b main
  git -C "$sandbox/repo" config user.email verify@llm4ts.test
  git -C "$sandbox/repo" config user.name "llm4ts verify"
  printf '.llm4ts/\n' >"$sandbox/repo/.gitignore"
  printf '# sandbox\n' >"$sandbox/repo/README.md"
  git -C "$sandbox/repo" add -A
  git -C "$sandbox/repo" commit -qm init
  {
    echo "run: $id"
    echo "commit: $(git -C "$repo_root" rev-parse HEAD)"
    echo "dirty: $(git -C "$repo_root" status --porcelain | wc -l | tr -d ' ') file(s)"
    echo "cli: $(node "$cli" --version 2>&1)"
    echo "node: $(node -v)"
  } >"$evidence/run.txt"
  echo "$id"
}

cmd_path() {
  case "${2:-}" in
    repo) echo "$(sandbox_dir "$1")/repo" ;;
    evidence) evidence_dir "$1" ;;
    sandbox) sandbox_dir "$1" ;;
    *) die "usage: verify.sh path <run> repo|evidence|sandbox" ;;
  esac
}

cmd_stub() {
  local sandbox responder
  sandbox="$(sandbox_dir "$1")"
  responder="${2:-}"
  [ -f "$responder" ] || [ -f "$here/stubs/$responder.cjs" ] || die "no responder '$responder' (a file, or a name under stubs/)"
  [ -f "$responder" ] || responder="$here/stubs/$responder.cjs"
  {
    echo '#!/usr/bin/env node'
    echo 'const fs = require("node:fs")'
    echo 'const path = require("node:path")'
    echo "const respond = require($(node -p 'JSON.stringify(process.argv[1])' "$responder"))"
    cat <<'EOF'
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  let text
  try {
    text = respond(prompt, { fs, path })
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error))
    process.exit(3)
  }
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n")
  emit({ type: "system", subtype: "init", model: "stub-claude-1" })
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } })
  emit({ type: "result", usage: { input_tokens: 100, output_tokens: 40 } })
})
EOF
  } >"$sandbox/bin/claude"
  chmod +x "$sandbox/bin/claude"
  cp "$responder" "$(evidence_dir "$1")/stub-$(basename "$responder")"
  echo "stub claude installed from ${responder#"$repo_root"/}"
}

cmd_cli() {
  local id="$1" label="$2"
  shift 2
  local sandbox evidence
  sandbox="$(sandbox_dir "$id")"
  evidence="$(evidence_dir "$id")"
  local extra=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    case "$1" in
      *=*) extra+=("$1") ;;
      *) die "before '--' only KEY=VALUE pairs are allowed, got '$1'" ;;
    esac
    shift
  done
  [ "${1:-}" = "--" ] || die "usage: verify.sh cli <run> <label> [KEY=VALUE ...] -- <llm4ts args>"
  shift
  [ -e "$evidence/$label.exit" ] && die "label '$label' already used in run '$id'"

  printf 'llm4ts' >"$evidence/$label.cmd"
  printf ' %q' "$@" >>"$evidence/$label.cmd"
  printf '\n' >>"$evidence/$label.cmd"
  [ ${#extra[@]} -eq 0 ] || printf 'env: %s\n' "${extra[*]}" >>"$evidence/$label.cmd"

  # A clean environment: no provider credentials, no user roster, flows or kits.
  local status=0
  (cd "$sandbox/repo" && env -i \
    PATH="$sandbox/bin:$PATH" HOME="$sandbox/home" TMPDIR="${TMPDIR:-/tmp}" \
    TERM=dumb LANG="${LANG:-en_US.UTF-8}" NO_COLOR=1 LLM4TS_CODER=claude \
    ${extra[@]+"${extra[@]}"} \
    node "$cli" "$@") >"$evidence/$label.stdout" 2>"$evidence/$label.stderr" || status=$?
  echo "$status" >"$evidence/$label.exit"

  cat "$evidence/$label.stdout"
  cat "$evidence/$label.stderr" >&2
  echo "[$label] exit $status -> ${evidence#"$repo_root"/}/$label.{cmd,stdout,stderr,exit}" >&2
  return "$status"
}

cmd_snapshot() {
  local id="$1" label="$2"
  local sandbox evidence
  sandbox="$(sandbox_dir "$id")"
  evidence="$(evidence_dir "$id")"
  {
    echo "## git log"
    git -C "$sandbox/repo" log --oneline --all --decorate
    echo "## git status"
    git -C "$sandbox/repo" status --short
    echo "## files"
    (cd "$sandbox/repo" && find . -path ./.git -prune -o -type f -print | sort)
  } >"$evidence/$label.repo.txt"
  cat "$evidence/$label.repo.txt"
}

cmd_cleanup() {
  local evidence
  evidence="$(evidence_dir "$1")"
  if [ -f "$evidence/sandbox.path" ]; then
    local sandbox
    sandbox="$(cat "$evidence/sandbox.path")"
    case "$sandbox" in
      */llm4ts-verify-*) rm -rf "$sandbox" ;;
      *) die "refusing to remove '$sandbox': not a verify sandbox" ;;
    esac
    rm "$evidence/sandbox.path"
  fi
  echo "sandbox removed; evidence kept at ${evidence#"$repo_root"/}"
}

cmd_help() {
  cat <<'EOF'
verify.sh build                      build the CLI (pnpm build)
verify.sh doctor                     read-only: is the built CLI worth driving?
verify.sh new [run-id]               create a sandbox (git repo, empty HOME); prints the run id
verify.sh path <run> repo|evidence|sandbox
verify.sh stub <run> <name|file.cjs>  install a stub `claude` that answers from a responder
verify.sh cli <run> <label> [KEY=VALUE ...] -- <llm4ts args>
                                     run the CLI in the sandbox repo; records cmd/stdout/stderr/exit
verify.sh snapshot <run> <label>     record the sandbox repo's git log, status and file list
verify.sh cleanup <run>              remove the sandbox, keep the evidence
EOF
}

command="${1:-help}"
[ $# -gt 0 ] && shift
case "$command" in
  build | doctor | new | path | stub | cli | snapshot | cleanup | help) "cmd_$command" "$@" ;;
  *) die "unknown command '$command'; see: verify.sh help" ;;
esac
