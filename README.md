# llm4ts

`llm4ts` is an Effect-native TypeScript implementation of
[`llm4zio`](https://github.com/riccardomerolla/llm4zio). It provides typed LLM
connectors, streaming, tools, evaluation, workflow orchestration, repository
automation, replay/equivalence, a Node runner, and the six-phase modernization
product.

The implementation targets the owned `llm4zio` v4.2.0 behavior at commit
`adf23e11` and uses Effect 4 patterns verified against local Effect commit
`504343b0cdf9a0306191c069c31b7d569eba0ed7`.

## Packages

| Package             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `@llm4ts/core`      | Models, connectors, providers, tools, eval, observability     |
| `@llm4ts/flow`      | Plans, events, persistence, repositories, review, replay      |
| `@llm4ts/runner`    | Node boundaries, terminal, CLI, MCP stdio, embedded runner    |
| `@llm4ts/modernize` | Resumable survey/extract/seed/implement/verify/review product |
| `@llm4ts/js`        | Promise/exception facade for ordinary JavaScript consumers    |

## Quick start

Install dependencies and verify the workspace:

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the credential-free example:

```sh
pnpm --filter @llm4ts/examples basic -- "Draft a small implementation plan"
pnpm --filter @llm4ts/examples plain-js -- "Hello"
```

Plain JavaScript consumers can use the facade without handling Effect values:

```js
import { createClient } from "@llm4ts/js"

const client = createClient({ provider: "mock", model: "mock" })
const response = await client.complete("Hello")
console.log(response.content)
```

The `mock` provider performs no network calls and requires no credentials.
Real HTTP-provider, coding-agent, fully local, and judge examples are documented
in [examples/README.md](examples/README.md).

Seed a disposable repository for a complete persistent workflow:

```sh
examples/seed.sh implement
LLM4TS_CODER=codex examples/seed.sh implement --run
```

## Documentation

- [API guide](docs/api.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Provider capability matrix](docs/provider-capabilities.md)
- [Migration from llm4zio](docs/migration-from-llm4zio.md)
- [Source parity ledger](docs/parity.md)
- [Clean Specification Pack](docs/csp/00-overview.md)

## Status

This repository is an initial `0.1.0` release candidate. Public subpath exports
are intentional; importing package-private files is unsupported.

Licensed under MIT.
