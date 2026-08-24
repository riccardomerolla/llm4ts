# @llm4ts/flow

Flow orchestration for [llm4ts](https://github.com/riccardomerolla/llm4ts):
`FlowContext`, plans and plan execution, review cycles, workflow events,
plain-file persistence, Git/GitHub/Azure DevOps tools, trace recording and
replay, cost tracking, and benchmarking.

The forge tools drive vendor CLIs rather than REST APIs — `gh` for
`GitHubTool`, `az` (with the `azure-devops` extension) for
`AzureDevOpsTool`, `basecamp` for `BasecampTool` — so each CLI owns its own
credential and no token is passed to, or held by, this package.

## Install

```bash
npm install @llm4ts/flow @llm4ts/core effect
```

Requires Node.js >= 22. `effect` is a peer dependency pinned to the Effect 4
beta line.

## Usage

The package exposes explicit subpath exports:

```ts
import { FlowContext } from "@llm4ts/flow/FlowContext"
import { Plan, planFrom } from "@llm4ts/flow/Plan"
import { AssistantMessage } from "@llm4ts/flow/FlowEvents"
import { reviewAndFixLoop } from "@llm4ts/flow/Review"
```

Flows are usually run through
[`@llm4ts/runner`](https://www.npmjs.com/package/@llm4ts/runner), which wires
the Node boundaries (HTTP, processes, filesystem) and hands your flow body a
ready `FlowContext` — no manual layer assembly required.

## Documentation

- [Repository and full documentation](https://github.com/riccardomerolla/llm4ts)
- [Architecture guide](https://github.com/riccardomerolla/llm4ts/blob/main/docs/architecture.md)
- [Runnable examples](https://github.com/riccardomerolla/llm4ts/tree/main/examples)

## License

MIT
