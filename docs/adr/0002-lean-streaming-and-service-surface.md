# ADR 0002: Lean Streaming And Service Surface

## Status

Accepted.

## Context

The pinned source ships streaming helpers that exist because ZIO streams lack
direct one-call equivalents. In Effect 4, several of those helpers reduce to a
single `Stream.*` call with no llm4ts-specific behavior: `retryStream`
(`Stream.retry`), `buffered` (`Stream.buffer`), `batch`
(`Stream.groupedWithin`), `mergeAll` (`Stream.mergeAll`), `withFallback`
(`Stream.catchIf`), and `rateLimit` (`Stream.schedule`). No module in the
workspace consumed them; they were reachable only from their own tests.

Similarly, `LlmService` free-function accessors (`executeStream(prompt)` as a
module-level function requiring the `LlmService` tag) and the six
`*ProviderLayer` exports had zero consumers: every call site consumes the
structural `LlmServiceShape` carried by connectors and `FlowContext`.

## Decision

Delete the pass-through streaming aliases and direct callers to `effect/Stream`
combinators. Keep the exports that carry llm4ts semantics: `collect`,
`trackProgress`, `parsePartialJson`, `withTimeout`/`withHeartbeat` (typed
`TimeoutError`), `cancellable`, `withSnapshots`, `toSSE`/`fromSSE`, and
`parallelStream` (order-preserving bounded collection).

Delete the `LlmService` free-function accessors and the per-provider
`Layer` constructors. The public contract is `LlmServiceShape` (structural,
carried by connectors and `FlowContext`) plus the `LlmService` tag for
applications that want to provide one service instance themselves.

## Consequences

- The CSP streaming behaviors (merge, buffering, batching, fallback, rate
  limiting) remain achievable through `effect/Stream` directly; parity is
  measured by behavior availability, not by re-exported helper names.
- Callers who need a provider as a Layer write
  `Layer.succeed(LlmService, makeOpenAIProvider(config, httpClient))` at their
  composition edge.
- The `@llm4ts/core/Streaming` interface shrinks from 17 exports to 10, all of
  which encode llm4ts-specific policy.
