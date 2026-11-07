# ADR 0048: Tool Catalog — One Standard Action per Validation, Comparison and Endpoint Check

Status: Accepted · Date: 2026-11-07 · Relates to ADR 0014, ADR 0024, ADR 0025, ADR 0029, ADR 0040, ADR 0041

## Context

Watching llm4ts runs on a customer's Linux server — Gemini CLI and pi over
Vertex, Gemini Flash most of the time, Gemini 2.5 Pro sometimes — the coder
did the same job a different way each run. To check a payload against a
contract it wrote a Python one-liner in one story, a Node script in the
next, a `jq` pipeline in a third; none survived the run, none landed in the
pack, and each cost the turns to write and debug it. Python was not even
the target language. The local traces on the author's machine show the
same thing at a smaller scale: about 3% of a coder's shell calls are ad-hoc
scripts, written for the same handful of purposes — query a JSON contract,
probe behaviour with a scratch test, check a version, compare two outputs.

"Code mode" as Cloudflare and pi describe it (the model writes code against
a typed API in a sandbox) is a different answer to a different problem:
fewer round trips for an agent that owns a tool loop. llm4ts owns no such
loop — tool calling belongs to the coding agents it drives, and the loop
that once existed here was removed in 3.0.0. What the runs need is not a
place for the model to write code; it is a reason not to. The repeatable
jobs should exist once, as code a human wrote and tested, under a name the
model sees every run.

What the repository already had: an XML parser, an XSD catalog and an
instance validator in the soap-ace kit; a structural diff in `Equiv.ts`; a
CONNECT-proxy, CA-pinning transport and an `auth.<env>.json` convention for
SOAP (ADR 0024); gates and other command seams in `pack.md`; and taskforce's
declared commands, whose output is injected into a brief. Nothing exposed
any of it to a coder, and no coder could reach `llm4ts` at all: the process
executor strips every `LLM4TS_*` variable so an agent is never pointed at
the tool running it (ADR 0029), and ADR 0040 says a coder cannot call
`llm4ts graph`.

## Decision

### A tool is a module with a typed input, a typed report and an Effect run

`defineTool` (`@llm4ts/flow/tools/Tool`) takes a name, a one-line purpose,
an argument table (`--name <kind>` with description, required and default),
an input `Schema` and `run: (input) => Effect<ToolReport, ToolError,
PlainFileStore>`. The report is `{ ok, summary, issues: [{ path, detail }],
truncated, data? }`. The argument table drives `describe` and argument
parsing; the schema decodes what was parsed; a wrong call fails with the
spec quoted, never a stack trace. A tool reads files through
`PlainFileStore` and nothing else in 3.1; 3.2 adds the endpoint transport.

### One CLI entry point, the only one an agent may call

`llm4ts tool list`, `llm4ts tool describe <name>` and `llm4ts tool run
<name> [--flag value …]` (`run` may be omitted). `run` prints the report as
JSON on stdout — `--text` for a terminal — exits 0 when ok, 1 when the
report carries issues, 2 when the tool could not run; issues are capped at
50 with the rest counted, `--all` lifts the cap. Nothing is written into
the worktree.

`tool` is the one subcommand a coding agent runs inside a task. The
`LLM4TS_*` stripping and the rest of ADR 0029 stand: `run`, `graph`, `mcp`
and the others stay operator-only. Because the stripping stands, `tool`
takes no setting from the environment: from a worktree it finds the project
through `git rev-parse --git-common-dir`, which points back at the main
checkout and its `.llm4ts/`, so no pointer file is written where a coder
could commit it. Outside a repository the current directory is the project.

MCP is not the channel. The problem is a model choosing among too many
ways; a catalog of N more tool names makes it worse. One command with
`list` and `describe` is one habit, works on every harness with a shell,
and is the same entry point a pack preset or a gate uses.

### The catalog is a union: built-in, kits, packs

- Built-in tools ship in `@llm4ts/flow/tools/*` and run in the CLI's own
  process.
- A kit ships tools as `kits/<kit>/tools/<name>.ts`, discovered through the
  same three tiers as kit flows (project `.llm4ts/kits`, global, built-in;
  ADR 0014) and run as a Node child with type stripping, the way flow
  scripts run. The file ends with `runToolMain(tool)`
  (`@llm4ts/runner/ToolMain`): `--describe` prints the spec; otherwise the
  parsed arguments arrive as one JSON object on stdin and the report goes
  out on stdout. A kit tool with a built-in's name shadows it, project kits
  first. Stack-specific tools stay in their kit — `xml-validate` lives in
  soap-ace because the XSD code does — and every built-in kit ships in the
  npm package, so the home is invisible to the agent.
- A pack names presets in `## Tools`: `- validate-contract: json-validate
--openapi contracts/openapi.json --component Page`. A preset is a
  pack-level name over a catalog tool with its fixed arguments; the caller
  appends the rest. A preset never names another preset. Packs configure,
  kits code: packs still cannot ship TypeScript.

### The brief teaches the rule; nothing is installed into the repository

Neither Gemini CLI nor pi takes a system-prompt flag, and task coders never
see skill files (pi runs `--no-skills`, Gemini isolated). So the story brief
carries one paragraph (`toolBrief`, `@llm4ts/runner/Tools`): the rule —
for validating a document, comparing two outputs or checking a contract,
run the project's tool instead of writing a script — and this pack's
presets with the command to run and the tool's purpose. epic-stories adds
it to the coder's system prompt beside the orientation digest (ADR 0025).
`LLM4TS_TOOL_BRIEF=off` drops the paragraph, for a run without the catalog
to compare against.

### Flows reach a tool through the command seams that exist

A preset is a command, so a pack puts it where commands already go:
`## Gates` runs it after every coder turn and feeds the findings to the fix
prompt; `## Diagnostics` makes its output a per-unit report; taskforce's
`commands.md` injects its output into a brief. No new flow seam.

### The measure is a count, not a feeling

`llm4ts profile` gains a `script` category: a shell command that is an
interpreter with inline code (`python3 -c`, `node -e`, `python3 -`), a
heredoc, a redirect into a script file, or an interpreter on a scratch
file. The per-story table shows it, `--against` compares it, and a story
with three or more gets a hint naming this ADR. Only the category is kept,
never the command.

### Two releases

- **3.1.0**: `defineTool`, the CLI, `json-validate` (an in-house JSON
  Schema subset: `type`, `properties`, `required`, `enum`, `const`, `items`,
  `additionalProperties`, bounds, `pattern`, `allOf`/`anyOf`/`oneOf`/`not`,
  local `$ref`, `nullable`; formats ignored), `diff` (a structural JSON
  compare with ordered, per-key and unordered matching and ignore paths),
  `xml-validate` (the soap-ace XSD pipeline over a standalone schema),
  presets, the brief, the profile count.
- **3.2.0**: `Transport` and `Auth` promoted from the soap-ace kit into
  `@llm4ts/flow`, named endpoints with `auth.<env>.json` and pinned trust
  under `.llm4ts/endpoints/<name>/`, `http-call` and `soap-call` as
  read-and-probe tools with redacted responses, and kit-level `tools/*.ts`
  as the documented place for a user's own tool code.

### Acceptance

Deterministic tests and one local rehearsal before 3.1.0. After it, a
profile on the customer server: the `script` count falling toward zero on
stories that validate or compare, at an equal green rate. Token savings are
the second number.

## Consequences

- A coder has one way to validate, compare or check, and the pack decides
  what that way is called. The same story reads the same brief every run.
- Tools are reviewed, committed code with the trust of a gate command.
  Nothing a model writes at run time is executed by this feature.
- The word "tool" now means a catalog entry. The forge services (`GitTool`,
  `GitHubTool`) and the operator server's `effect/ai` tools keep their
  names; the model tool loop removed in 3.0.0 is not coming back.
- `core` and `flow` keep zero npm dependencies: the JSON Schema and tree
  diff code is in-house, and the XML code was already here. When a
  customer's schema uses a keyword the subset ignores, the tool reports
  nothing for it rather than failing; `xmllint` can be offered as a
  fallback later, never required.
- The `LLM4TS_*` guardrail is unchanged; `llm4ts tool` must stay useful
  without any of those variables, which is why the project is found
  through git and the pack through `--pack` or the brief.
- A kit tool costs a child process per `describe` and per run; `list`
  describes every kit tool, so it is slower than `describe <name>`. The
  brief quotes built-in purposes directly and leaves a kit tool's to
  `describe`.

## Not decided here

- YAML OpenAPI documents (`json-validate` reads JSON; the soap-ace YAML
  reader can serve it once promoted).
- An XML `diff`, once the XML parser is promoted with the transport in 3.2.
- A `## Before` pack section that runs presets ahead of a story and injects
  their output into the brief; the gate and diagnostics seams cover the
  known cases.
- MCP exposure of the catalog for a harness without a shell.
- Harvesting scripts an agent wrote into proposed tools; people write
  tools, after a profile shows the need.
