# @llm4ts/modernize

The [llm4ts](https://github.com/riccardomerolla/llm4ts) modernization workflow:
a six-phase, resumable product flow (discovery, assessment, target
architecture, migration planning, staged implementation, verification and
reporting) built entirely on the public `@llm4ts/core`, `@llm4ts/flow`, and
`@llm4ts/runner` APIs.

## Install

```bash
npm install @llm4ts/modernize effect
```

Requires Node.js >= 22. `effect` is a peer dependency pinned to the Effect 4
beta line. `@llm4ts/core`, `@llm4ts/flow`, and `@llm4ts/runner` are installed
automatically as dependencies.

## Usage

```ts
import { makeModernize } from "@llm4ts/modernize/Modernize"
```

See the [repository documentation](https://github.com/riccardomerolla/llm4ts)
for the workflow phases, artifacts, and resume behavior.

## License

MIT
