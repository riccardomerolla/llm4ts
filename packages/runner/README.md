# @llm4ts/runner

Node runner for [llm4ts](https://github.com/riccardomerolla/llm4ts): the
`runNode` embedded entry point, connector presets, terminal rendering, the
`llm4ts` CLI, and the MCP stdio server.

## Install

```bash
npm install @llm4ts/runner @llm4ts/flow @llm4ts/core effect
```

Requires Node.js >= 22. `effect` is a peer dependency pinned to the Effect 4
beta line.

## Run a flow

`runNode` provides every Node boundary (HTTP client, process executor,
temporary files, file store, connector registry) with sensible defaults — you
never assemble Effect layers yourself:

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

The mock connector needs no credentials. Swap in a real provider via
`ApiConnectorConfig` (API keys are read from standard environment variables
such as `ANTHROPIC_API_KEY`) or a CLI coding agent via `coderFromEnv`
(`LLM4TS_CODER=claude|codex|gemini|...`).

## CLI

The package ships a `llm4ts` binary that streams one prompt to your configured
coder and records a trace under `.llm4ts/`:

```bash
npx llm4ts "explain this repository" --repo .
```

## Documentation

- [Repository and full documentation](https://github.com/riccardomerolla/llm4ts)
- [Configuration guide](https://github.com/riccardomerolla/llm4ts/blob/main/docs/configuration.md)
- [Runnable examples](https://github.com/riccardomerolla/llm4ts/tree/main/examples)

## License

MIT
