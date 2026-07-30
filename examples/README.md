# Examples

The examples are executable scripts composed only from public package exports.
`basic.ts` and `plain-js.mjs` are deterministic and credential-free;
`api-provider.ts` talks to a real HTTP provider. The autonomous agent flows
live in [`flows/`](../flows/README.md).

| Script            | What it demonstrates                             | Requirements        |
| ----------------- | ------------------------------------------------ | ------------------- |
| `basic.ts`        | Embedded Effect runner with the mock connector   | none                |
| `plain-js.mjs`    | Promise/exception facade with the mock connector | none                |
| `api-provider.ts` | Streaming from a real HTTP provider              | provider server/key |

Build the packages once before running scripts from the workspace:

```sh
pnpm build
```

## Real API provider

Select a provider and model:

```sh
LLM4TS_PROVIDER=openai \
LLM4TS_MODEL=gpt-4.1-mini \
OPENAI_API_KEY=... \
pnpm --filter @llm4ts/examples api -- "Explain this repository"
```

`LLM4TS_PROVIDER` accepts `openai`, `anthropic`, `gemini`, `lm-studio`,
`ollama`, or `mock`. Cloud credentials are read from `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`. Local providers
need no key:

```sh
LLM4TS_PROVIDER=ollama \
LLM4TS_MODEL=qwen3-coder \
pnpm --filter @llm4ts/examples api -- "Suggest one refactoring"
```

## Seeding starter projects

`seed.sh` copies a minimal starter project (under `starters/`) into a new
directory and prepares it for a flow run — see
[`flows/README.md`](../flows/README.md) for the seed workflow and the flow
catalogue.

For embedded applications, return the `Effect` from `runNode` to the
application's existing runtime. Calling `Effect.runFork` belongs only at an
executable edge such as these scripts.
