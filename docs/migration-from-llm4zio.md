# Migrating from llm4zio

The TypeScript implementation preserves the owned `llm4zio` v4.2.0 behavioral
contracts, but uses idiomatic Effect and JavaScript representations.

| llm4zio                            | llm4ts                                        |
| ---------------------------------- | --------------------------------------------- |
| `ZIO[R, E, A]`                     | `Effect.Effect<A, E, R>`                      |
| `ZStream[R, E, A]`                 | `Stream.Stream<A, E, R>`                      |
| `ZLayer`                           | `Layer`                                       |
| Scala case class / enum            | `Schema.Class` / tagged schema ADT            |
| `Option[A]` at JSON boundaries     | optional property                             |
| `FlowContext` contextual parameter | Effect service or explicit `FlowContextShape` |
| `PlanStore`                        | `@llm4ts/flow/Persistence`                    |
| `.sc` runner                       | `runNode` / `runEmbedded`                     |
| Java facade blocking calls         | `@llm4ts/js` Promise methods                  |

## Errors

Effect-facing APIs retain schema-backed errors in the typed error channel.
Ordinary JavaScript consumers use `@llm4ts/js`, where the boundary intentionally
converts them to `Llm4tsError` rejections. Branch on `error.category`, not error
message text.

## Providers

Provider wire protocols, streaming semantics, usage accounting, health behavior,
and CLI prompt transport follow the pinned source. Configuration is split into
`ApiConnectorConfig` and `CliConnectorConfig`; runtime HTTP/process boundaries
are injected.

## Plans and persistence

Markdown plan files remain human-readable and task-resumable. The bookkeeping
directory is `.llm4ts` instead of `.llm4zio`. Stable prompt filenames use FNV-1a
rather than JVM-specific MurmurHash; move old plans explicitly if resuming a
cross-language run.

## Modernization

The same six named phases and approval markers are retained. `llm4ts` also
persists an explicit versioned phase checkpoint and can run through a selected
phase in one Effect program. Existing per-program specifications, vectors, and
completed implementation tasks remain the finer recovery units.

See [the parity ledger](parity.md) for every accepted adaptation.
