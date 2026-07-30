# llm4ts

Effect-native LLM workflows for TypeScript: typed connectors for API providers
and CLI coding agents, streaming, structured output, tools, plans and review
loops, repository automation, trace replay, and a Node runner. `llm4ts` is the
TypeScript implementation of [`llm4zio`](https://github.com/riccardomerolla/llm4zio).

## Try it in one minute

No Effect knowledge and no credentials required — the built-in mock provider
works offline:

```js
import { createClient } from "@llm4ts/js"

const client = createClient({ provider: "mock", model: "mock" })
const response = await client.complete("Hello")
console.log(response.content)
```

Swap `provider` for `openai`, `anthropic`, `gemini`, `lm-studio`, or `ollama`;
API keys are read from the standard environment variables
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). Secrets stay
redacted end to end — they never appear in argv, logs, traces, or error
messages.

## Run a flow from the terminal

`@llm4ts/shell` ships the `llm4ts` CLI. With no arguments it opens an
interactive menu; with arguments it is a subcommand CLI over the flows it
discovers across three tiers — your project's `.llm4ts/flows/`, your global
`~/.config/llm4ts/flows/`, and the built-ins shipped with the shell:

```bash
npx -y @llm4ts/shell list
```

```bash
LLM4TS_CODER=codex npx -y @llm4ts/shell run implement "add a health endpoint"
```

`llm4ts view <flow>` prints a flow's source, `llm4ts ask "<prompt>"` streams
a one-shot prompt to your coding agent (Claude Code, Codex, Gemini CLI, and
friends), and `llm4ts doctor` reports which connectors and credentials are
available on your machine. `llm4ts --help` shows all options.

Your coding agent can delegate work to llm4ts too: the
[using-llm4ts skill](skills/using-llm4ts/README.md) teaches Claude Code, Pi,
OpenCode, and Codex when and how to hand a task to `llm4ts run`.

## Author a flow in TypeScript

`runNode` wires every Node boundary (HTTP, processes, temp files, persistence,
connector registry) for you — you never assemble Effect layers:

```ts
import { runNode } from "@llm4ts/runner/FlowRunner"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"

const program = runNode(
  {
    workDir: process.cwd(),
    workspace: process.cwd(),
    userPrompt: "Draft a small implementation plan",
    coder: ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock })
  },
  (context) => collect(context.coder.executeStream(context.userPrompt))
)
```

From there the [examples](examples/README.md) and [flows](flows/README.md)
form a ladder: mock completion → HTTP provider → CLI coding agent →
persistent resumable plan → issue-to-PR → spec-driven development.
`examples/seed.sh implement` seeds a disposable
repository so you can watch a full plan/implement/review flow safely:

```sh
examples/seed.sh implement
LLM4TS_CODER=codex examples/seed.sh implement --run
```

## Packages

| Package             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `@llm4ts/js`        | Promise-based client — the fastest way to try llm4ts          |
| `@llm4ts/shell`     | `llm4ts` CLI and interactive menu over discovered flows       |
| `@llm4ts/runner`    | Node runner, terminal rendering, MCP stdio                    |
| `@llm4ts/flow`      | Plans, events, persistence, repositories, review, replay      |
| `@llm4ts/core`      | Models, connectors, providers, tools, eval, observability     |
| `@llm4ts/modernize` | Resumable survey/extract/seed/implement/verify/review product |

## Configuration

Everything is environment-driven; nothing is required for the mock provider.

| Variable                                                | Effect                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `LLM4TS_CODER`                                          | Coding agent: `claude` (default), `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`, `opencode` |
| `LLM4TS_PROVIDER` / `LLM4TS_MODEL`                      | API provider and model for provider-driven entry points                                        |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Provider credentials, applied automatically                                                    |
| `LLM4TS_VERBOSITY`                                      | Terminal verbosity                                                                             |

See the [configuration guide](docs/configuration.md) for the full list.

## Working on this repository

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm build
node scripts/pack-smoke.mjs   # verifies the published artifacts
```

Run the credential-free example from the workspace (requires `pnpm build`
first, since examples resolve the built package exports):

```sh
pnpm --filter @llm4ts/examples basic -- "Draft a small implementation plan"
```

Releases are tag-driven: bump all package versions to `X.Y.Z`, tag `vX.Y.Z`,
and push — the release workflow verifies, builds, smoke-tests the packed
tarballs, and publishes with provenance.

## Documentation

- [Flow authoring guide](docs/flow-authoring.md)
- [API guide](docs/api.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Provider capability matrix](docs/provider-capabilities.md)
- [Migration from llm4zio](docs/migration-from-llm4zio.md)

Internal engineering references: [source parity ledger](docs/parity.md),
[Clean Specification Pack](docs/csp/00-overview.md), [plan](plan.md).

## Status

Initial `0.1.0` release. The implementation targets the owned `llm4zio` v4.2.0
behavior and uses Effect 4 (beta line). Public subpath exports are intentional;
importing package-private files is unsupported.

Licensed under MIT.
