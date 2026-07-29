# @llm4ts/core

Effect-native LLM contracts: backend-neutral messages, responses, streaming
chunks, usage, health, structured output, tools, evaluation, and the connector
registry. This is the foundation package of [llm4ts](https://github.com/riccardomerolla/llm4ts).

## Install

```bash
npm install @llm4ts/core effect
```

Requires Node.js >= 22. `effect` is a peer dependency pinned to the Effect 4
beta line.

## Usage

The package exposes explicit subpath exports — import the module you need:

```ts
import { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Message, LlmResponse, ConnectorIds } from "@llm4ts/core/Models"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { collect } from "@llm4ts/core/Streaming"
```

Connectors for OpenAI, Anthropic, Gemini, LM Studio, Ollama, and CLI coding
agents (Claude, Codex, Gemini CLI, and more) live under
`@llm4ts/core/providers/*`. A deterministic mock connector
(`@llm4ts/core/providers/MockProvider`) works with zero configuration and no
credentials.

Most applications should start from
[`@llm4ts/runner`](https://www.npmjs.com/package/@llm4ts/runner) (Node
composition and flows) or
[`@llm4ts/js`](https://www.npmjs.com/package/@llm4ts/js) (Promise-based facade)
rather than wiring core services directly.

## Documentation

- [Repository and full documentation](https://github.com/riccardomerolla/llm4ts)
- [API overview](https://github.com/riccardomerolla/llm4ts/blob/main/docs/api.md)
- [Provider capabilities](https://github.com/riccardomerolla/llm4ts/blob/main/docs/provider-capabilities.md)

## License

MIT
