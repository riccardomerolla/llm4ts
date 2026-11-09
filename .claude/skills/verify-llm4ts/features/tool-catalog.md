# Tool catalog

A user or a coding agent runs a named tool to validate or compare files and gets a JSON report, with exit code 1 when the tool found issues (ADR 0048).

## Sub-features

- `tool-list` lists the tools and presets the project can run.
- `tool-describe` shows one tool's purpose and arguments.
- `tool-run-pass` reports `ok: true` and exits 0 for a valid document.
- `tool-run-fail` reports each issue with its path and exits 1.
- `tool-short` runs a tool by name without the `run` word.

## How to get to it (user POV)

- Run `llm4ts tool list`.
- Run `llm4ts tool describe <name>`.
- Run `llm4ts tool run <name> <flags>`.
- Run `llm4ts tool <name> <flags>`.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds.
- The sandbox repository holds three files. `schema.json` is `{"type":"object","required":["id"],"properties":{"id":{"type":"integer"}}}`. `good.json` is `{"id":1}`. `bad.json` is `{"id":"x"}`. Write them under `$($V path $R repo)`.

- **List.** Run `$V cli $R tool-list -- tool list`. Exit code `0`. Stdout names `diff`, `http-call`, `json-validate`, `soap-call` and `xml-validate`.
- **Describe.** Run `$V cli $R tool-describe -- tool describe json-validate`. Exit code `0`. Stdout lists `--document <path> (required)`.
- **Pass.** Run `$V cli $R tool-run-pass -- tool run json-validate --document good.json --schema schema.json`. Exit code `0`. Stdout is one JSON object with `"ok":true` and `"issues":[]`.
- **Fail.** Run `$V cli $R tool-run-fail -- tool run json-validate --document bad.json --schema schema.json`. Exit code `1`. Stdout has `"ok":false` and an issue with `"path":"$.id"` and `"detail":"expected integer, found string"`.
- **Short form.** Run `$V cli $R tool-short -- tool json-validate --document good.json --schema schema.json`. Exit code `0`. Stdout equals the pass report.

## Gotchas

- Exit code `1` is the tool reporting issues, not a crash. `$V cli` returns it, so a script running under `set -e` stops there unless it expects the failure.
- `http-call` and `soap-call` reach named endpoints over the network. They are not driven here. Report them as unverified.
- Presets come from a pack's `## Tools` section. The sandbox has no pack, so `tool list` shows no presets until one is placed in the repository.
