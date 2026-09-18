# Examples

The examples are executable scripts composed only from public package exports.
`basic.ts` and `plain-js.mjs` are deterministic and credential-free;
`api-provider.ts` talks to a real HTTP provider. The autonomous agent flows
live in [`flows/`](../flows/README.md).

| Script                       | What it demonstrates                                | Requirements              |
| ---------------------------- | --------------------------------------------------- | ------------------------- |
| `basic.ts`                   | Embedded Effect runner with the mock connector      | none                      |
| `plain-js.mjs`               | Promise/exception facade with the mock connector    | none                      |
| `api-provider.ts`            | Streaming from a real HTTP provider                 | provider server/key       |
| `gemini-acp-bridge-smoke.ts` | The ADR 0016 Gemini ACP bridge, end to end via `pi` | installed `gemini` + `pi` |

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

## Gemini ACP bridge smoke test

Proves the ADR 0016 chain end to end: llm4ts drives `pi` as its `pi` coder
connector, `pi` calls out to the bridge for inference instead of a model API
key, and the bridge rides a real `gemini-cli` OAuth session. Needs, on the
machine running it: an authenticated `gemini` CLI (`gemini --experimental-acp`
works on its own) and a `pi` CLI already configured — once, outside this
script — with a custom provider in `~/.pi/agent/models.json` whose `baseUrl`
points at `http://127.0.0.1:8731` (or whatever `LLM4TS_GEMINI_BRIDGE_PORT`
is set to). See [`docs/configuration.md`](../docs/configuration.md) for that
one-time setup and `llm4ts doctor` for checking it's still in place.

The script prints the bridge-backed `provider/model` pairs it finds in your
`models.json` and runs `pi --model` with the single one, so no name is
hardcoded. With several it stops and asks you to pick:

```sh
LLM4TS_GEMINI_BRIDGE_MODEL=<provider>/<model> \
  pnpm --filter @llm4ts/examples gemini-acp-bridge-smoke
```

`LLM4TS_GEMINI_BRIDGE=1 llm4ts doctor` prints the same list.

```sh
pnpm build
pnpm --filter @llm4ts/examples gemini-acp-bridge-smoke
```

A clean exit (and the final "smoke test passed" line) means pi completed a
real tool-calling turn — reading this repo's `package.json` — with gemini's
subscription supplying the reasoning, not a synthetic HTTP request against
the bridge alone. Pass `--repo <path>` to point it at a different checkout,
or a trailing `"<prompt>"` to change what pi is asked to do (same argument
convention as the built-in `llm4ts` CLI):

```sh
pnpm --filter @llm4ts/examples gemini-acp-bridge-smoke -- --repo /path/to/checkout "list the files here"
```

## Seeding starter projects

`seed.sh` copies a minimal starter project (under `starters/`) into a new
directory and prepares it for a flow run — see
[`flows/README.md`](../flows/README.md) for the seed workflow and the flow
catalogue.

For embedded applications, return the `Effect` from `runNode` to the
application's existing runtime. Calling `Effect.runFork` belongs only at an
executable edge such as these scripts.
