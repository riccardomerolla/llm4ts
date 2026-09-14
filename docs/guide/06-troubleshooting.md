# 6. Troubleshooting

Start with `llm4ts doctor`. Most first-run failures are visible in its
report before any flow is launched. Then find your symptom below.

## `unknown LLM4TS_CODER 'x'; expected agy|claude|codex|...`

The value is not one of the coder tokens. `LLM4TS_CODER` selects the CLI
connector; API providers are selected with `LLM4TS_PROVIDER` instead and
only by flows built on `apiConnectorFromEnvironment`, such as chapter 3's
hello flow. Exit code 2.

## The coder starts and fails at once, or hangs on a login prompt

The CLI is missing from `PATH`, or it is installed but not authenticated.
Run the CLI directly once by hand (`claude`, `codex`, `gemini`, `pi`, ...)
and complete its own login. llm4ts never enters credentials for you and
never puts secrets on the command line, in logs, or in traces.

## Gemini: `No project found`

The Gemini CLI resolves a Google Cloud project at auth setup. A personal
OAuth login works without one; a Workspace or enterprise account needs
`GOOGLE_CLOUD_PROJECT` or `GEMINI_API_KEY` exported in a file every shell
reads, not only your login shell. `llm4ts doctor` prints this as a
prerequisite when it detects the gap.

## pnpm: `No projects found in "<dir>"`

You ran `pnpm --filter @llm4ts/flows ...` from outside the llm4ts checkout.
That message is from pnpm, not a connector, and the flow did not start.
Either `cd` into the checkout, use `pnpm -C /path/to/llm4ts --filter ...`,
or use the installed CLI, which works from any directory:

```bash
llm4ts run implement --repo /path/to/target "task"
```

## `LLM4TS_MODEL is required for provider 'openai'`

Every API provider except `mock` needs a model name. Set both variables:

```bash
LLM4TS_PROVIDER=openai LLM4TS_MODEL=gpt-4.1-mini llm4ts run hello "..."
```

## `pack 'x' not found: no kit ships it (known packs: ...)`

`--pack` or `LLM4TS_PACK` names a pack no discovered kit ships. The message
lists every `kit/pack` the shell can see; `llm4ts kits` shows the same with
the tier each kit came from. A pack you are still writing is passed as a
directory holding `pack.md`, relative to where you launch. "Shipped by more
than one kit" means two kits of the same tier carry the name: pick one with
`kit/pack`.

## `unknown flow 'x' (known flows: ...)`

`llm4ts list` shows what was discovered. A project flow must be under
`.llm4ts/flows/` of the directory you launch from, end in `.ts`, and its
first non-blank line should be a `//` description. A flow that is listed but
fails to import usually has a typo in a `@llm4ts/...` subpath; `llm4ts view`
one of the built-ins to compare.

## Types resolve in the editor but the run fails, or the reverse

Your project's `node_modules` holds `@llm4ts/*` or `effect` at a version
different from the shell's. The flow resolves from the project first and
falls back to the shell only for what the project lacks, so a partial or
mismatched install mixes two versions. Keep every `@llm4ts/*` package on
the same version as `@llm4ts/shell`, and pin `effect` exactly.

## `read bytes exceeded limit` or a discovery overflow in survey

A legacy file is over the 8 MiB per-file cap, or the estate has more than
20 000 candidate files. Narrow `sources:` and `exclude:` in the pack first;
otherwise raise `LLM4TS_MAX_READ_BYTES` or `LLM4TS_MAX_DISCOVER_RESULTS`, or
replace the pruned directory list with `LLM4TS_EXCLUDE_DIRS`.

## The interactive menu prints nothing useful

`llm4ts` with no arguments needs a real terminal. From a script, a CI job,
or a coding agent, use the subcommands: `llm4ts run`, `list`, `view`, `ask`,
`doctor`.

## A run stopped halfway

Re-run the same command. Plans persist under `.llm4ts/` in the target
repository and completed tasks are not repeated. If the plan itself is
wrong, edit `.llm4ts/plan-<hash>.md` between runs, or delete it to replan.

Still stuck: [docs/configuration.md](../configuration.md) lists every
variable, and `llm4ts run <flow> --verbose` shows what the agent is doing.
