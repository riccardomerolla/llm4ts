# Pi gate tools: plan

Status: draft, not built · Date: 2026-11-15 · Becomes an ADR (the next free number) when accepted

## Problem

A customer runs the `pi` coder on `google-vertex/gemini-3.8-flash` with a
service account. The only Pro model they may use is `gemini-2.5-pro`, which
is older, so a stronger model is not the fix. The coder runs lint, compile
and tests itself (`pnpm`, `mvn`) through pi's `bash` tool. In practice it
writes a new command line or throwaway script each time, and often the wrong
one. There is no profile output for this run, so the symptom comes from the
operator's own observation.

Today a coder seat gets pi's default tools. `piExtraArgs`
(`packages/core/src/providers/PiConnector.ts`) restricts tools only for
read-only seats (`--tools read --no-mcp`) and toolless calls (`--no-tools`).

## Idea

The pack already names every check the coder needs, in `## Gates`:

```text
## Gates
- compile: mvn -q -B -DskipTests compile
- test: mvn -q -B test
```

Give the coder those gates as named tools (`compile`, `test`) with no
command-line argument, and take `bash` away. The model picks a name and
llm4ts runs the exact command the pack declares. The model can still check
its own work mid-turn, but it can't write a command.

## Data shape

```ts
interface GateTool {
  readonly name: string // the `## Gates` key, e.g. "compile"
  readonly command: ReadonlyArray<string> // argv, as `Pack.gates[name]`
}
```

One new optional field on `CliConnectorConfig`:
`gateTools?: ReadonlyArray<GateTool>`. Absent or empty, pi gets the argv it
gets today. Present, the pi argv becomes:

```text
--tools read,edit,write,<gate names> -e <generated extension file>
```

`bash` is left out of the allowlist. `-e` still loads under `isolated`,
which passes `--no-extensions`, because pi's help says explicit `-e` paths
still work.

## The extension

A pure function in core, `piGateToolsExtension(tools): string`, returns the
source of a pi extension. The gate list is embedded as a
`JSON.stringify` literal, so no command text is ever spliced into code. For
each gate the extension calls `pi.registerTool` with:

- the gate's name and a one-line description ("Runs the project's compile
  gate: mvn -q -B -DskipTests compile");
- an empty parameter object. A flat schema is the safest shape for Vertex
  function calling, which accepts only a subset of JSON Schema;
- `execute`, which spawns the argv in the session's working directory with no
  shell, honours the abort signal and a timeout, and returns the exit code
  plus the last N lines of combined output.

The runner writes the source to a temporary file for each turn through
`TemporaryFiles`, the same way `NodeGeminiCliExecutor` writes the Gemini
harness policy, and passes its path with `-e`.

Gate commands come from the pack, never from the model, and carry no
secrets. The child inherits the seat's `envVars`, as gates do today.

## Setting

`LLM4TS_CODER_TOOLS` (settings registry, ADR 0049) takes two values.
`default` keeps today's tools. `gates` turns on gate tools for coder seats on
`pi`, when the flow has a pack with at least one gate. Other harnesses ignore
it, and `llm4ts doctor` says so when a non-pi coder runs with `gates`. It can
also be set per seat with `--set`.

The default stays `default` until the measurement below says otherwise.

## Steps

Each step ends in a check.

1. **Find the seam.** Confirm where a story's coder `CliConnectorConfig` is
   built with the pack in scope (`ExecutorRoster.ts`, `Connectors.ts`,
   `Stories.ts`), and that `gateTools` can be set there without the runner
   learning about packs. Check: a written note naming the function, in this
   file.
2. **Core: shape and argv.** Add `GateTool` and `gateTools` to
   `CliConnectorConfig`, and update `piExtraArgs`. Check: `@effect/vitest`
   tests on argv for the three cases (no gates, gates, gates with
   `isolated`).
3. **Core: the extension source.** Add `piGateToolsExtension`. Check: a test
   imports the generated module, calls its factory with a fake `pi` object
   that records `registerTool`, and runs one tool against
   `node -e "process.exit(1)"` to assert the exit code and output tail. A
   gate name or command containing quotes or backticks still produces source
   that parses.
4. **Runner: write the file per turn.** Writes it through `TemporaryFiles`
   in the pi executor path. Check: a test with the in-src process and
   temporary-file fakes shows the `-e` path exists while pi runs and is gone
   after.
5. **Flow: pass the gates.** At the seam from step 1, map `Pack.gates` to
   `gateTools` when `LLM4TS_CODER_TOOLS=gates`. Check: a flow test with
   `makeMemoryWorkspace` and a stub coder sees the gate names in its config.
6. **Setting and doctor.** Register `LLM4TS_CODER_TOOLS` and add the doctor
   line. Check: `llm4ts config` lists it, and doctor prints the non-pi
   warning.
7. **Drive the real CLI.** Use the `verify-llm4ts` skill with a stub `pi`
   that records its argv and loads the extension. Check: a captured run
   whose argv has no `bash` and has the gate tools.
8. **The ADR (the next free number), docs, changelog.**
9. **Prove it on the customer's model.** This is the gate for changing the
   default, and only the operator can run it.

## Proof on the customer's run

Same pack, same stories, same model, two runs: `LLM4TS_CODER_TOOLS=default`
and `gates`. A small script, `scripts/pi-tool-usage.mjs`, reads pi's
transcripts from both runs and reports, for each run:

- tool calls by name;
- `bash` calls that exited non-zero, and distinct `bash` command lines (the
  "different command each time" symptom);
- scripts the coder wrote outside the story's owned paths;
- tasks that failed or restarted, from the run state.

This gives numbers without `llm4ts profile`. If `gates` doesn't clearly
reduce failed commands and restarted tasks, keep the default and record the
result in the ADR.

## Deferred

- **A test filter argument** (one test class or pattern). The syntax differs
  per tool (`-Dtest=X` for Maven, `-- X` for pnpm), so the pack would need a
  way to declare it. Add it only if the proof run shows the coder needs to
  run single tests.
- **`## Tools` presets as tools.** The `llm4ts tool` presets (ADR 0048)
  could be registered the same way. Wait until gates alone are measured.
- **A bash guard** for commands the pack doesn't declare. It would be a
  `tool_call` handler that blocks commands outside a pack allowlist and
  lists the gate tools in its reason. Build it only if stories turn out to
  need commands beyond the gates.
- **Other harnesses.** Claude and Codex have their own allowlists. Not in
  scope.

## Risks

- **Fewer tools, more rounds.** Without `bash` the coder can't run `git`,
  `ls` or one-off checks. `read` covers most exploration. The proof run
  shows whether stories stall.
- **Gate setup.** A pack's `setup` step runs before gates in the flow. If a
  gate needs setup that hasn't run yet in the worktree, the tool fails. The
  tool's output says so and the flow's own gates still decide the story.
- **pi extension API drift.** `registerTool` and `-e` are documented in pi
  1.5.0. `piVersionProbe` can set a floor, as it does for `--no-mcp`.
