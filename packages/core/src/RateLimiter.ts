import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { LlmConfig } from "./Models.ts"

export class RateLimiterAcquireTimeout extends Schema.TaggedErrorClass<RateLimiterAcquireTimeout>()(
  "AcquireTimeout",
  {
    timeout: Schema.Duration
  }
) {}

export class RateLimiterInvalidConfig extends Schema.TaggedErrorClass<RateLimiterInvalidConfig>()(
  "InvalidConfig",
  {
    details: Schema.String
  }
) {}

export const RateLimiterError = Schema.Union([RateLimiterAcquireTimeout, RateLimiterInvalidConfig])
export type RateLimiterError = typeof RateLimiterError.Type

export class RateLimiterConfig extends Schema.Class<RateLimiterConfig>("RateLimiterConfig")({
  requestsPerMinute: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(60))),
  burstSize: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(10))),
  acquireTimeout: Schema.Duration.pipe(
    Schema.withConstructorDefault(Effect.succeed(Duration.seconds(30)))
  )
}) {}

export const rateLimiterConfigFromLlmConfig = (config: LlmConfig): RateLimiterConfig =>
  RateLimiterConfig.make({
    requestsPerMinute: config.requestsPerMinute,
    burstSize: config.burstSize,
    acquireTimeout: config.acquireTimeout
  })

export class RateLimiterMetrics extends Schema.Class<RateLimiterMetrics>("RateLimiterMetrics")({
  totalRequests: Schema.Int,
  throttledRequests: Schema.Int,
  currentTokens: Schema.Int
}) {}

export interface RateLimiterShape {
  readonly acquire: Effect.Effect<void, RateLimiterError>
  readonly tryAcquire: Effect.Effect<boolean>
  readonly metrics: Effect.Effect<RateLimiterMetrics>
}

export class RateLimiter extends Context.Service<RateLimiter, RateLimiterShape>()(
  "@llm4ts/core/RateLimiter"
) {}

interface BucketState {
  readonly tokens: number
  readonly lastRefillNanos: bigint
}

interface TakeResult {
  readonly acquired: boolean
  readonly tokensAfter: number
  readonly deficit: number
}

const nanosPerSecond = 1_000_000_000

const configDetails = (config: RateLimiterConfig): string =>
  `requestsPerMinute=${config.requestsPerMinute}, burstSize=${config.burstSize}, ` +
  `acquireTimeout=${Duration.format(config.acquireTimeout)}`

const isConfigValid = (config: RateLimiterConfig): boolean =>
  config.requestsPerMinute > 0 &&
  config.burstSize > 0 &&
  Duration.toMillis(config.acquireTimeout) > 0

export const makeRateLimiter = Effect.fn("@llm4ts/core/RateLimiter.make")(function* (
  config: RateLimiterConfig
) {
  const initialNanos = yield* Clock.currentTimeNanos
  const state = yield* Ref.make<BucketState>({
    tokens: config.burstSize,
    lastRefillNanos: initialNanos
  })
  const metrics = yield* Ref.make(
    RateLimiterMetrics.make({
      totalRequests: 0,
      throttledRequests: 0,
      currentTokens: config.burstSize
    })
  )
  const capacity = config.burstSize
  const ratePerSecond = config.requestsPerMinute / 60

  const takeToken: Effect.Effect<TakeResult> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeNanos

    return yield* Ref.modify(state, (current) => {
      const elapsedNanos = now - current.lastRefillNanos
      const tokensToAdd =
        elapsedNanos <= 0n ? 0 : (Number(elapsedNanos) / nanosPerSecond) * ratePerSecond
      const refilled =
        tokensToAdd <= 0 ? current.tokens : Math.min(capacity, current.tokens + tokensToAdd)
      const lastRefillNanos = tokensToAdd <= 0 ? current.lastRefillNanos : now

      if (refilled >= 1) {
        const remaining = refilled - 1
        return [
          {
            acquired: true,
            tokensAfter: remaining,
            deficit: 0
          },
          {
            tokens: remaining,
            lastRefillNanos
          }
        ]
      }

      return [
        {
          acquired: false,
          tokensAfter: refilled,
          deficit: 1 - refilled
        },
        {
          tokens: refilled,
          lastRefillNanos
        }
      ]
    })
  })

  const updateCurrentTokens = (tokens: number): Effect.Effect<void> =>
    Ref.update(metrics, (current) =>
      RateLimiterMetrics.make({
        ...current,
        currentTokens: Math.trunc(tokens)
      })
    )

  const waitForToken = (deficit: number): Effect.Effect<void, RateLimiterInvalidConfig> => {
    if (ratePerSecond <= 0) {
      return Effect.fail(
        RateLimiterInvalidConfig.make({
          details: configDetails(config)
        })
      )
    }

    const nanoseconds = BigInt(Math.max(0, Math.ceil((deficit / ratePerSecond) * nanosPerSecond)))
    return Effect.sleep(Duration.nanos(nanoseconds))
  }

  const acquireLoop = (alreadyThrottled: boolean): Effect.Effect<void, RateLimiterError> =>
    Effect.gen(function* () {
      const result = yield* takeToken
      yield* updateCurrentTokens(result.tokensAfter)

      if (result.acquired) {
        return
      }

      if (!alreadyThrottled) {
        yield* Ref.update(metrics, (current) =>
          RateLimiterMetrics.make({
            ...current,
            throttledRequests: current.throttledRequests + 1
          })
        )
      }

      yield* waitForToken(result.deficit)
      return yield* Effect.suspend(() => acquireLoop(true))
    })

  const acquire: Effect.Effect<void, RateLimiterError> = Effect.suspend(() => {
    if (!isConfigValid(config)) {
      return Effect.fail(
        RateLimiterInvalidConfig.make({
          details: configDetails(config)
        })
      )
    }

    return Ref.update(metrics, (current) =>
      RateLimiterMetrics.make({
        ...current,
        totalRequests: current.totalRequests + 1
      })
    ).pipe(
      Effect.andThen(acquireLoop(false)),
      Effect.timeoutOrElse({
        duration: config.acquireTimeout,
        orElse: () =>
          Effect.fail(
            RateLimiterAcquireTimeout.make({
              timeout: config.acquireTimeout
            })
          )
      })
    )
  })

  const tryAcquire: Effect.Effect<boolean> = Effect.suspend(() => {
    if (!isConfigValid(config)) {
      return Effect.logWarning(`Rate limiter config invalid: ${configDetails(config)}`).pipe(
        Effect.as(false)
      )
    }

    return Effect.gen(function* () {
      const result = yield* takeToken
      yield* updateCurrentTokens(result.tokensAfter)
      yield* Ref.update(metrics, (current) =>
        RateLimiterMetrics.make({
          ...current,
          totalRequests: current.totalRequests + 1,
          throttledRequests: current.throttledRequests + (result.acquired ? 0 : 1)
        })
      )
      return result.acquired
    })
  })

  return RateLimiter.of({
    acquire,
    tryAcquire,
    metrics: Ref.get(metrics)
  })
})

export const rateLimiterLayer = (config: RateLimiterConfig): Layer.Layer<RateLimiter> =>
  Layer.effect(RateLimiter, makeRateLimiter(config))
