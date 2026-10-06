# Pack: scala-ts

source: scala
sources: .*\.scala$
exclude: (^|/)(target|node_modules|\.bloop|\.metals|project)/
target: {{dir}}/{{base}}.ts
comment: //
specs-dir: docs/port
features-dir: docs/port/features

## Gates

- typecheck: pnpm typecheck
- test: pnpm test

## Diagnostics

- command: pnpm exec tsc -p tsconfig.json --pretty false
- format: tsc

## Ledger

- unit: ^\s*(?:final\s+)?(?:case\s+)?(?:class|object|trait|enum)\s+(\w+)
- classes: SERVICE, LAYER, DATA, ERROR, STREAM, TEST, UTIL, UNKNOWN
- question: What kind of thing is this declaration in an Effect port? SERVICE (a ZIO service trait → Context.Service), LAYER (a ZLayer → Layer), DATA (a case class or enum → Schema.Class or a tagged union), ERROR (an error ADT → Schema.TaggedError), STREAM (ZStream producer → Stream), TEST (a spec → @effect/vitest), UTIL (pure helpers).

## Audit

- dimensions: error channel and variance, services and layers, data modelling and schemas, streams and resources, concurrency primitives, test idioms, what not to translate

## Review rules

`any`, unchecked casts, namespaces and a global `Error` in the error channel
are findings. Every expected failure is a `Schema.TaggedError`; every
replaceable dependency is a service with a layer. Relative imports carry `.ts`
extensions.
