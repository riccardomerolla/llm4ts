You are translating one Scala 3 / ZIO 2 file to TypeScript with Effect 4.
Read this whole document before writing any code. The first pass is a
**draft** `.ts` beside the `.scala`, same basename, that captures the logic
faithfully; it does **not** need to type-check. The compile pass makes it
type-check module by module.

## Ground rules

- Same module, same names (camelCase for values, PascalCase for types), same
  order of declarations, same control flow. Reviewers diff the two files side
  by side.
- Use Effect 4 as the repository uses it: `Effect.gen` for sequencing,
  `Effect.fn` for named reusable operations, `Context.Service` and `Layer` for
  replaceable dependencies, `Schema.Class` / `Schema.TaggedClass` for data,
  `Schema.TaggedError` for expected failures. Never `any`, never an unchecked
  cast, never a global `Error` as a domain error.
- Relative imports use `.ts` extensions; a module imports a contract, never a
  sibling's internals.
- Leave `// TODO(port): <reason>` for anything you cannot translate
  confidently. Do not guess.
- Do not translate build definitions, sbt plugins or Scala-only tooling;
  note them as `// SKIPPED(port): <what>`.

## Type map

| Scala / ZIO                          | TypeScript / Effect                            |
| ------------------------------------ | ---------------------------------------------- |
| `ZIO[R, E, A]`                       | `Effect.Effect<A, E, R>` (note the order)      |
| `UIO[A]` / `Task[A]`                 | `Effect.Effect<A>` / `Effect.Effect<A, UnknownException>` |
| `ZStream[R, E, A]`                   | `Stream.Stream<A, E, R>`                       |
| `ZLayer[RIn, E, ROut]`               | `Layer.Layer<ROut, E, RIn>`                    |
| `trait Service` + `ZIO.service`      | `Context.Service` class + `yield* Service`     |
| `case class`                         | `Schema.Class`                                 |
| `enum` / sealed trait ADT            | `Schema.Union` of `Schema.TaggedClass`         |
| `Option[A]`                          | optional property / `A \| undefined`           |
| `Either[E, A]`                       | `Result` or `Effect.Effect<A, E>`              |
| `Chunk[A]`                           | `ReadonlyArray<A>`                             |
| `Ref[A]`, `Queue[A]`, `Hub[A]`       | `Ref`, `Queue`, `PubSub`                       |
| `Scope` / `acquireRelease`           | `Scope` / `Effect.acquireRelease`              |
| `Schedule`                           | `Schedule`                                     |
| zio-json codecs                      | `Schema` with `Schema.fromJsonString`          |
| ZIO Test `spec` / `test`             | `@effect/vitest` `describe` / `it.effect`      |
| `for` comprehension                  | `Effect.gen(function* () { … })`               |

## Idiom map

- `ZIO.attempt(…)` → `Effect.try(…)`; `ZIO.fail(E)` → `Effect.fail(E)`; `.orDie` → `Effect.orDie`.
- `.provide(layer)` / `.provideSome` → `Effect.provide(layer)`; layer composition order follows `Layer.provide`.
- `.catchSome { case e: X => … }` → `Effect.catchTag("X", …)`.
- `zio.Duration` → `Duration` from effect; `ZIO.sleep` → `Effect.sleep`.
- Implicit parameters and givens become explicit arguments or services.
- `==` on case classes is structural; TypeScript needs `Equal.equals` or a field-by-field compare.

## Output format

End the file with the trailer the flow reads:

```ts
// PORT STATUS
// source: <path>.scala
// confidence: high | medium | low
// todos: <count of TODO(port)>
// notes: <one line>
```
