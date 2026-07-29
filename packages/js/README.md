# @llm4ts/js

The fastest way to try [llm4ts](https://github.com/riccardomerolla/llm4ts):
a Promise-based client for plain JavaScript and TypeScript consumers — no
Effect knowledge required.

## Install

```bash
npm install @llm4ts/js
```

Requires Node.js >= 22.

## Usage

Works out of the box with the built-in mock provider — no credentials needed:

```js
import { createClient } from "@llm4ts/js"

const client = createClient({ provider: "mock", model: "mock" })
const response = await client.complete("Say hello")
console.log(response.content)
```

Swap in a real provider by name (`openai`, `anthropic`, `gemini`,
`lm-studio`, `ollama`) — API keys are read from the standard environment
variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`):

```js
const client = createClient({
  provider: "anthropic",
  model: "claude-sonnet-4-5"
})
const answer = await client.complete("Summarize the Effect library in one line")
```

The client also exposes `health()` for checking provider availability and
credentials.

For full flows — plans, review loops, Git integration, CLI coding agents —
use [`@llm4ts/runner`](https://www.npmjs.com/package/@llm4ts/runner).

## License

MIT
