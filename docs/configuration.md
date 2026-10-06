# Configuration

## JavaScript facade

`createClient` validates a plain object:

| Field            | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `provider`       | `mock`, `openai`, `anthropic`, `gemini`, `lm-studio`, `ollama`, or `mlx-lm` |
| `model`          | Provider model identifier                                                   |
| `baseUrl`        | Optional endpoint override                                                  |
| `apiKey`         | Optional secret; converted immediately to `Redacted`                        |
| `timeoutSeconds` | Optional request timeout                                                    |
| `temperature`    | Optional sampling temperature                                               |
| `maxTokens`      | Optional completion limit                                                   |

API keys are sent in provider headers and are not placed in URLs, process
arguments, events, or persisted flow artifacts.

## Judgment seat

Typed judgments (ADR 0017) run on their own seat, which defaults to the
reasoning seat:

| Variable                   | Meaning                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_JUDGMENT_PROVIDER` | An API provider name as for `LLM4TS_PROVIDER`; unset keeps the reasoning seat                                                                |
| `LLM4TS_JUDGMENT_MODEL`    | Its model                                                                                                                                    |
| `LLM4TS_JUDGMENT_BACKEND`  | `llm` (default) or `typesafe` for the hosted Jev model                                                                                       |
| `LLM4TS_JUDGMENT_BATCHING` | `independent` (default, one call per question) or `shared-prefix` (one call per request, state sent once, each answer read as its own label) |
| `TYPESAFE_API_KEY`         | Required by the `typesafe` backend; header only, never logged                                                                                |

A small non-thinking model served by `mlx-lm` is the intended judgment seat:
one forward pass and one output token per question.

## CLI connectors

The Node runner exports presets for Claude, Codex, Gemini, Pi, Antigravity, Grok,
Cursor, and OpenCode. Their native CLIs own authentication. `LLM4TS_CODER`
selects `claude`, `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`, or
`opencode`. The llm4zio-era `LLM4ZIO_CODER` name is no longer read (2.0).

`LLM4TS_VERBOSITY` accepts `quiet`, `normal`, `verbose`, or `debug`.
`LLM4TS_UI=tree` (what `llm4ts run --ui tree` sets) draws the full-screen
agent tree instead of the classic view (ADR 0022). `LLM4TS_IDLE_AFTER`
(`90s`, `5m`, `1h`; default `2m`) is how long a story may go without an
event before the tree marks it: **quiet** while a model call is open,
**idle** when nothing is under way. A gate, setup command, git step, merge
or wait the story said it began shows as running however long it takes.
`LLM4TS_STORY_CONTEXT_CHARS` (default `40000`, `0` to turn it off) is how much
of the code a story starts from goes into its coder's system prompt in
`epic-stories`. `LLM4TS_ORIENTATION_CHARS` (default `8000`, `0` to turn it
off) is how much of the repository orientation digest (folders with counts,
scripts, where tests live) the planner and every coder see (ADR 0025).
`LLM4TS_TRANSCRIPT=on` (what `llm4ts run --transcript` sets) records each
seat's input and output under `.llm4ts/transcripts/`, for `llm4ts watch
--tail`; `epic-stories` records them by default (`off` to stop) — a `--plan-only` or
refine-planning run therefore leaves a small transcript of the planner's call
too — and `--land` compacts them to their shape (calls, tools, timings; no
content).

With a Google Cloud project and a **Vertex AI service-account key** as the
only model access, see `vertex-service-account.md`: which harnesses accept
the key (Claude Code, Gemini CLI, opencode, pi; not Codex), the variables
each reads, and a roster that combines them.

### Gemini ACP bridge (for `pi` without a model credential)

When `pi` is the coder and the only paid model access available is a
`gemini-cli` OAuth subscription (no `GEMINI_API_KEY`, no Vertex key), a
`pi`-coding flow run can start a local bridge that lets `pi` draw its
inference from that subscription instead. Set `LLM4TS_GEMINI_BRIDGE` (any
truthy value) to start it, scoped to that flow run; `LLM4TS_GEMINI_BRIDGE_PORT`
overrides the fixed port (default `8731`) the bridge binds. Concurrent flow
runs sharing one bridge are unsupported — a run that finds the port already
bound fails fast rather than sharing an unowned server.

The run starts the bridge only when a seat actually uses `pi` (the reasoning
seat defaults to the coder, so a `pi` coder is enough), and points every such
seat at the resolved bridge model. A seat that already names a model keeps it
— an explicit choice outranks the default. If the bridge is requested but no
model can be resolved, the run fails there with the reason rather than
letting pi fail later with `No API key found for selected model`.

The bridge does not configure `pi` for you: add a custom provider to
`~/.pi/agent/models.json` with `baseUrl` set to `http://127.0.0.1:<port>`
(`api: "anthropic-messages"`) once, outside any flow run — `llm4ts doctor`
reports whether that file already points at the configured port but never
writes it (that file belongs to `pi`, not llm4ts).

```json
{
  "providers": {
    "gemini-bridge": {
      "baseUrl": "http://127.0.0.1:8731",
      "api": "anthropic-messages",
      "apiKey": "bridge-unused",
      "models": [{ "id": "gemini-2.5-pro" }]
    }
  }
}
```

Two details pi enforces and llm4ts cannot relax:

- Each `models` entry is an **object** carrying a string `id`, never a bare
  `"gemini-2.5-pro"` string. A wrong entry fails validation with
  `providers.<name>.models.0: must be object`, and pi then loads _nothing_
  from the file — including providers that were fine.
- `apiKey` must be present, though its value is never used. pi keeps a
  provider's models out of `--model` and `--list-models` until auth is
  configured, so a keyless bridge entry loads and stays invisible. Any
  placeholder works; the real credential is gemini's own OAuth session,
  which the bridge holds and pi never sees. (`pi /login` for that provider
  does the same job.)

`pi --list-models` is the final word on what pi accepts — check there when a
`--model` value is rejected.

Pointing that file at the bridge is necessary but not sufficient: `pi`
selects a provider per invocation, so the run must also be told to use this
one with `--model <provider>/<model>` (`gemini-bridge/gemini-2.5-pro` for
the entry above). The two ways to get that wrong fail differently — no
`--model` at all uses pi's own default and fails with `No API key found for
selected model`, while a name absent from the provider's `models` list
fails with `Model not found`. Both mean the bridge is up and nothing is
routed to it.

`llm4ts doctor` resolves the file and prints every pair pi will accept,
marking the bridged ones:

```sh
LLM4TS_GEMINI_BRIDGE=1 llm4ts doctor
```

From a source checkout, `pnpm build && LLM4TS_GEMINI_BRIDGE=1 pnpm llm4ts
doctor` runs the working tree's CLI instead of the installed release.

```text
prerequisites:
  ✔ pi-gemini-bridge: a provider in ~/.pi/agent/models.json points at 127.0.0.1:8731
      bridge models — pass one as LLM4TS_GEMINI_BRIDGE_MODEL (pi's --model):
        gemini-bridge/gemini-2.5-pro
```

The ADR 0016 smoke test (`examples/gemini-acp-bridge-smoke.ts`) reads the
same list rather than assuming a name: with exactly one bridged pair it uses
it, and otherwise asks for `LLM4TS_GEMINI_BRIDGE_MODEL`. That value only
routes pi — the bridge echoes it back and never forwards it, so gemini
reasons with `LLM4TS_GEMINI_MODEL` instead.

See ADR 0016 for the full design.

## API connectors

The runner exports `openAI`, `anthropic`, `geminiApi`, `lmStudio`, `ollama`, `mlxLm`, and
`mock` presets. Before registry resolution it fills a missing provider base URL
and reads a missing cloud credential from:

| Connector  | Environment credential                             |
| ---------- | -------------------------------------------------- |
| OpenAI     | `OPENAI_API_KEY`                                   |
| Anthropic  | `ANTHROPIC_API_KEY`                                |
| Gemini API | `GEMINI_API_KEY`, falling back to `GOOGLE_API_KEY` |

Explicit `baseUrl` and redacted `apiKey` values always win. LM Studio and Ollama
use their local default endpoints and require no credential. See the
[real examples](../examples/README.md) for runnable commands.

## Kits and packs

The modernization and conversion flows read a pack selected by `LLM4TS_PACK`
(or `llm4ts run --pack`; default `cobol-springboot`): a bare pack name
resolved across the kits discovered in the project (`./.llm4ts/kits/`),
global (`~/.config/llm4ts/kits/`, honouring `XDG_CONFIG_HOME`), and built-in
tiers; `kit/pack` to name one kit; or a directory holding `pack.md`, relative
to the launch directory or absolute, for a pack not yet in a kit. Two kits of
one tier shipping the same pack name is an error naming both. `llm4ts kits`
lists the kits with their packs and flows (ADR 0014).

Estate reading is bounded by `LLM4TS_MAX_READ_BYTES` (per file, 8 MiB in the
estate-reading phases), `LLM4TS_MAX_DISCOVER_RESULTS` (20 000 there, 1 000
elsewhere), and `LLM4TS_EXCLUDE_DIRS` (replaces the pruned directory list).

## Usage estimates

Every seat the runner resolves is metered, so a run always accounts for its
tokens even when the backend reports none (Antigravity, Copilot, and Cursor on
the [capability matrix](provider-capabilities.md)). The estimate counts
characters on both sides of a request and is published under the model label
`estimated:<model>`, which keeps it in its own column of `llm4ts costs` and out
of any measured total. Measured usage always wins: the estimate only fills a
gap the backend left.

| Variable                          | Effect                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| `LLM4TS_ESTIMATE_MODEL`           | Pricing reference for the estimate. Default `claude-sonnet-4`       |
| `LLM4TS_ESTIMATE_CHARS_PER_TOKEN` | Characters per estimated token. Default 4                           |
| `LLM4TS_ESTIMATE_USAGE`           | `0`, `false`, `no`, or `off` leaves the seats raw, accruing nothing |

`FlowRunnerOptions.estimateUsage: false` does the same for one run in code and
takes precedence over the environment.

## OpenTelemetry

A run can export what its agents do, their tokens and reported costs as
OpenTelemetry spans and metrics over OTLP (ADR 0026,
[observability.md](observability.md)). The standard `OTEL_*` variables are
the source of truth: `OTEL_EXPORTER_OTLP_ENDPOINT` (or the per-signal
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) sends traces and metrics to any
collector, and llm4ts defaults `OTEL_TRACES_EXPORTER` and
`OTEL_METRICS_EXPORTER` to `otlp` when an endpoint is set. `LLM4TS_OTEL=on`
(what `llm4ts run --otel` sets) with no endpoint exports traces only to a
local Arize Phoenix at `http://localhost:6006`; `LLM4TS_OTEL=off` or
`OTEL_SDK_DISABLED=true` turns everything off. `LLM4TS_OTEL_CONTENT` (what
`llm4ts run --otel-content` sets) is `off` by default; `on` adds prompts, replies and tool I/O to the spans (redacted,
capped), `full` adds the system prompt. `LLM4TS_FLOW` is set by the shell to
the flow's name for the run span. Nothing is exported while the test suite
runs.

## Gates

The target's gate commands (typecheck, lint, test, build, or `LLM4TS_GATES`)
run after every task and after every merge (ADR 0013). Since ADR 0027 a gate
has a timeout, a class and a memory: the gates' result on the code a change
started from is recorded as a baseline under the run's state folder
(`gates/baselines.json`, keyed by commit, app dir and commands), and a change
is charged only with the failing lines it added. Lines already red on the
base are listed once as inherited; a test-gate line red once and green on one
rerun is flaky; neither blocks. Gate output is written to
`stories/<id>/gates/<n>-<command>.log` in the state folder, and the fix
prompt carries its tail and, for CLI coders, its path. Without gate commands
(a flow that passes `lint` but no `baseline`) every red line blocks, as
before.

| Variable                 | Effect                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `LLM4TS_GATE_TIMEOUT`    | Seconds before a gate is killed and reported as a hang. Default `1200` |
| `LLM4TS_GATE_TAIL_CHARS` | Characters of gate output in the fix prompt. Default `4000`            |

`--land` deletes the baselines and compacts the gate logs to their failing
lines.

The **oracle guard** runs beside the gates (ADR 0027 decision 4): a change
that deletes a test file, adds a skip or focus marker (`.skip(`, `.only(`,
`xit(`, `test.todo(`, `@Ignore`, `@Disabled`, `@pytest.mark.skip`,
`#[ignore]`) or lowers the passed-test count against the baseline fails its
gate round, with the file and line, and the fix round undoes it. A story whose
job includes changing tests says so with `testsChange: true` in its plan
entry; `sdd` and `modernize-implement` declare it for the task that writes
the red tests. A pack extends what counts as a test file or a marker in a
`## Oracle` section. The count check runs only when both sides report a
summary line the guard reads (Vitest, Jest, pytest, cargo, mocha, JUnit) and
says once when they do not.

## Review

Every lens (the built-in ones, a pack's `reviewers/*.md`, the repository's
own rules) is asked with the shared review-rules preamble first (ADR 0027
decision 9): no stubbed bodies, no skipped, deleted or weakened tests, no
layering workaround, and "a paragraph-long justification means the code is
wrong". The adversarial lens, whose only job is to find why the diff does not
work, is in the minimal set. A pack extends the rules in a `## Review rules`
section (`- preamble: off` leaves the shared preamble out of that pack's
lenses); a repository without a pack puts its rules in
`.llm4ts/review-rules.md` (a reviewer file: optional `files:` frontmatter,
then the rules), which every review round loads as one extra lens. A finding
a reviewer cannot place is moved down, never dropped: a Critical with no file
becomes a Warning, a finding naming a file the diff does not touch becomes an
Info, each as a `ReviewFindingDemoted` event.

| Variable              | Effect                                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_REVIEW_VOTES` | Independent votes of the adversarial lens per round; any Critical blocks. Default `1`                                 |
| `LLM4TS_REVIEW_FIXER` | `separate`: findings go to a fresh fixer chat briefed to apply them and nothing else. Default: the implementer's chat |

Votes multiply only the adversarial lens; the concern lenses run once. With a
roster, consecutive votes take turns across executors (ADR 0019), so two
votes usually come from two models.

A loop that stops making progress ends typed, as `Stalled`, instead of
spending its rounds (ADR 0027 decision 11): a fix round that leaves the diff
byte-identical, a coder turn that repeats the same tool call with the same
arguments too many times in a row, or, when asked, a turn with no output
for too long. The story fails with the signal in its reason, dependents
hold, and the retro digest shows it.

| Variable               | Effect                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `LLM4TS_STALL_REPEATS` | Identical tool calls in a row that end the turn. Default `5`                          |
| `LLM4TS_STALL_MINUTES` | Minutes without output that end the turn. Unset: off (a slow seat looks like silence) |

The retro can edit the loop, not only the stories (ADR 0027 decision 12).
Its digest ends with a Signatures section when a pattern repeats across
stories (gaming the oracle guard caught, the same reviewer finding in two
stories, fabricated status in two stories), and the seat may answer with
`rules`: an `append-rule` line or a `replace-section` for
`.llm4ts/review-rules.md`, a pack's `reviewers/<name>.md`, `pack.md`,
`lessons.md` or a `patterns/pitfalls-*.md` card. The report renders each as
a diff; the next `epic-stories` run applies approved ones from the JSON and
marks the report, like tasks and story edits.

## Autonomy contract and evidence

Every coder's system prompt opens with one paragraph from
`@llm4ts/flow/AutonomyContract` (ADR 0027 decision 5): nobody is watching;
act, do not announce; the task is the whole scope; make the smallest change;
pre-existing bugs and wrong tests are findings, not fixes; never edit, skip
or delete a test to pass; end with the commands run, not a claim. The
built-in flows use it through `withContract(...)`; a roster entry picks a
profile per executor with `"contract": "full" | "minimal" | "off"` (`minimal`
keeps the scope and no-gaming rules for a model that over-verifies under the
full text; `off` is for a flow that writes its own rules).

A task's `## Findings` section ends with one `verified: <command>` line per
command the coder ran to check its work and a `confidence: high|medium|low`
line. With transcripts on (the default for epic-stories), each `verified:`
claim is checked against the tool calls the transcript shows for that task
(ADR 0027 decision 6): a command that never ran is a `fabricated status`
Warning in the story's findings, travels to the judge as an evidence note,
is counted in `llm4ts profile`, and is a signature the retro reads. An API
coder keeps no tool transcript, so its claims are reported as unchecked.

## Ports

The port flows (ADR 0028) port a code base file by file with a porting pack
(`LLM4TS_PACK`, e.g. the built-in `zig-rust` or `scala-ts`): `target:` (the
target path template), `comment:` (the `PORT STATUS` trailer's comment
marker), `prompts/porting.md` (the rulebook), pitfall cards, `## Diagnostics`
(`json`, `cargo` or `tsc`), `## Ledger` (what `port-ledger` classifies),
`## Differential` (the two test commands `port-tests` compares) and
`## Audit` (the dimensions `port-guide` audits). In order: `port-guide`
(`.llm4ts/port/guide-audit.md`, approved → appended to the rulebook on the
next run), `port-ledger` (`<specs-dir>/ledger.tsv`, committed), `port-files`
(`.llm4ts/port/ledger.jsonl`, `report.md`, `pilot.md`), `port-compile`
(`diagnostics-<round>.md`), `port-tests` (`.llm4ts/port/tests/`: a
`.baseline.json` and a `.diag.md` per test file, `report-<round>.md`).

| Variable                     | Effect                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `LLM4TS_PORT_PILOT`          | Port this many files, write the pilot report, stop behind `- [ ] Approved`. Unset: all |
| `LLM4TS_PORT_CONCURRENCY`    | Files or units worked at once. Default `4`                                             |
| `LLM4TS_PORT_BATCH`          | Files per batch (6 when the batch's first file is over 2200 lines). Default `100`      |
| `LLM4TS_PORT_SOURCE_CHARS`   | Characters of one source file in the implementer's prompt. Default `120000`            |
| `LLM4TS_PORT_COMPILE_ROUNDS` | Rebuild rounds before `port-compile` stops with diagnostics left. Default `6`          |
| `LLM4TS_PORT_TEST_ROUNDS`    | Differential rounds before `port-tests` stops with red files left. Default `4`         |
| `LLM4TS_PORT_GUIDE_SAMPLE`   | Sample sources `port-guide` audits and trial-ports. Default `3`                        |
| `LLM4TS_PORT_GUIDE_TRIAL`    | `off` skips the trial port (auditors and refuters only)                                |
| `LLM4TS_REVIEW_VOTES`        | Adversarial votes per unit; the port flows default to `2`                              |

## Capabilities

Filesystem, process, network, Git, and forge operations require explicit
capability grants at the flow boundary. Connector capabilities describe what a
backend supports; grants describe what a particular run may do. They are
separate checks.

## Modernization

The phases persist their own artifacts under `docs/modernization/` of the
repository they run in. The source-compatible approval marker is
`- [x] Approved`:

- approve `docs/modernization/wave-plan.md` before extraction;
- approve `docs/modernization/README.md` before seeding.

Phase bodies receive their LLM, repository, workspace, and forge dependencies
through `runNode`; no provider is selected inside the flow package.

`epic-design` reads an extract pack from a second repository:
`LLM4TS_LEGACY_REPO=<path>` is the legacy repository holding
`docs/modernization/` (required). The flow itself runs rooted at the target
repository (`--repo <target>`), writes `.llm4ts/epics/<epic-id>/brief.md`
there, and takes `LLM4TS_PACK` only to describe a target that is still empty.

### mlx-lm

`mlx-lm` serves MLX models on Apple Silicon over the OpenAI wire format and
returns token log-probabilities, which the `Judgment` service uses for
one-token label scoring. Start it against a text-only MLX model directory
(the ones LM Studio downloads work when they are text-only, for example
`Qwen3-4B-Instruct-2507-4bit`; Qwen 3.5+ community conversions are
multimodal and do not load):

```bash
python3 -m venv ~/.mlxenv && ~/.mlxenv/bin/pip install mlx-lm
```

```bash
~/.mlxenv/bin/python -m mlx_lm.server --model ~/.lmstudio/models/mlx-community/Qwen3-4B-Instruct-2507-4bit --port 8080
```

Then `LLM4TS_PROVIDER=mlx-lm LLM4TS_MODEL=<the same path>`; the default base
URL is `http://localhost:8080`. The model id must be the path the server
lists at `/v1/models`.
