# Contract Tests for the Connector Factories

`packages/core/src/Connector.ts` now carries the two seams every connector is
built on — `makeApiConnector` and `makeCliConnector` (+ `versionProbe`,
`timedHealthCheck`, `cliVersionProbeHealthCheck`) — but has **no direct test**.
Behavior is only covered indirectly through individual provider tests.

Blast radius: tests only. No production code changes.

## Tasks

- [x] `packages/core/test/Connector.test.ts` covering `makeApiConnector`:
      derived `kind`/`capabilities` defaults, `executeStructured` as the
      [value] projection of `executeStructuredWithUsage`, and
      `timedHealthCheck` mapping availability → Healthy/Valid vs
      Unhealthy/Invalid with a latency measured via the test clock.
- [ ] Cover `makeCliConnector`: `versionProbe` derivation (Healthy/Valid on
      probe success, Unhealthy/Unknown on failure, custom `versionArgs`),
      explicit `healthCheck`/`isAvailable` overrides winning over the probe,
      the Unknown/Unknown default when neither is given, history flattening
      via `flattenHistory`, structured output via schema hint + `parseFromText`,
      and `executeWithTools` failing typed.
- [ ] Use the in-src fakes (`makeFakeProcessExecutor`) — no Node processes,
      deterministic per CLAUDE.md.

## References

- Seams: `packages/core/src/Connector.ts`
- Fakes: `packages/core/src/ProcessExecutor.ts`
- Test conventions: existing provider tests in `packages/core/test/`
