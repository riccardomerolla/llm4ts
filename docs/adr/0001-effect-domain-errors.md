# ADR 0001: Effect Domain Errors

## Status

Accepted.

## Context

The Scala source models `LlmError` as a pure ADT that does not extend
`Throwable`. Effect's idiomatic schema-backed expected error is
`Schema.TaggedErrorClass`, which is yieldable in `Effect.gen`, serializable, and
represented as an Error-like JavaScript value.

## Decision

Use `Schema.TaggedErrorClass` for serializable expected failures. Preserve source
tags, fields, stable messages, and typed error channels. Do not use the global
`Error` type as a public expected-error contract.

Underlying defects may be captured only in fields explicitly modeled for that
purpose and must be sanitized before crossing logging or persistence boundaries.

## Consequences

- Expected failures remain easy to yield, match, encode, and test in Effect.
- Runtime `instanceof Error` behavior differs from Scala's non-`Throwable` ADT.
- Parity is measured by typed-channel behavior and public fields, not JVM
  inheritance.
