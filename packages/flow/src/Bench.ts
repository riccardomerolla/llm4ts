import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { TokenUsage } from "@llm4ts/core/Models"
import type { FlowEvent, FlowEventHub, FlowEventsShape } from "./FlowEvents.ts"
import { estimateCostUsd } from "./PriceList.ts"

export class BenchTokens extends Schema.Class<BenchTokens>("BenchTokens")({
  prompt: Schema.Int,
  completion: Schema.Int,
  cached: Schema.Int
}) {
  get total(): number {
    return this.prompt + this.completion
  }

  add(that: BenchTokens): BenchTokens {
    return new BenchTokens({
      prompt: this.prompt + that.prompt,
      completion: this.completion + that.completion,
      cached: this.cached + that.cached
    })
  }
}

export const emptyBenchTokens = (): BenchTokens =>
  BenchTokens.make({ prompt: 0, completion: 0, cached: 0 })

export const benchTokensFromUsage = (usage: TokenUsage): BenchTokens =>
  BenchTokens.make({
    prompt: usage.prompt,
    completion: usage.completion,
    cached: usage.cached ?? 0
  })

export class BenchCounters extends Schema.Class<BenchCounters>("BenchCounters")({
  flakyRetries: Schema.Int,
  transientRetries: Schema.Int,
  autoResumes: Schema.Int,
  turnLimitTrips: Schema.Int,
  shrinks: Schema.Int
}) {
  get selfHealing(): number {
    return this.flakyRetries + this.transientRetries + this.autoResumes + this.shrinks
  }
}

export const emptyBenchCounters = (): BenchCounters =>
  BenchCounters.make({
    flakyRetries: 0,
    transientRetries: 0,
    autoResumes: 0,
    turnLimitTrips: 0,
    shrinks: 0
  })

export class BenchPhase extends Schema.Class<BenchPhase>("BenchPhase")({
  name: Schema.String,
  ms: Schema.Int,
  tokens: BenchTokens,
  costUsd: Schema.optionalKey(Schema.Number),
  counters: BenchCounters,
  detail: Schema.Record(Schema.String, Schema.String)
}) {}

export class BenchScore extends Schema.Class<BenchScore>("BenchScore")({
  name: Schema.String,
  score: Schema.Int,
  max: Schema.Int,
  reasoning: Schema.String
}) {}

export class BenchJudge extends Schema.Class<BenchJudge>("BenchJudge")({
  provider: Schema.String,
  model: Schema.String,
  fixed: Schema.Boolean
}) {}

export class BenchMachine extends Schema.Class<BenchMachine>("BenchMachine")({
  hostname: Schema.String,
  os: Schema.String,
  arch: Schema.String,
  cores: Schema.Int,
  memoryGb: Schema.Number,
  runtime: Schema.String
}) {}

export class BenchQuality extends Schema.Class<BenchQuality>("BenchQuality")({
  buildPassed: Schema.optionalKey(Schema.Boolean),
  testsRun: Schema.optionalKey(Schema.Int),
  testsFailed: Schema.optionalKey(Schema.Int),
  coveragePct: Schema.optionalKey(Schema.Number),
  featureFiles: Schema.Int,
  scenarios: Schema.Int,
  malformedFeatures: Schema.Int,
  specFiles: Schema.Int,
  programs: Schema.Int,
  sourceFiles: Schema.Int,
  sourceLines: Schema.Int,
  testFiles: Schema.Int,
  testLines: Schema.Int,
  deterministicFindings: Schema.Int,
  judgeFindings: Schema.Int,
  gateCleared: Schema.optionalKey(Schema.Boolean),
  gateRounds: Schema.optionalKey(Schema.Int),
  gateOpenIssues: Schema.optionalKey(Schema.Int),
  judgeScores: Schema.Array(BenchScore)
}) {}

export class BenchRecord extends Schema.Class<BenchRecord>("BenchRecord")({
  schemaVersion: Schema.Int,
  runId: Schema.String,
  label: Schema.optionalKey(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.String,
  provider: Schema.String,
  modelRequested: Schema.String,
  modelsServed: Schema.Array(Schema.String),
  judge: BenchJudge,
  toolVersion: Schema.optionalKey(Schema.String),
  llm4tsVersion: Schema.String,
  pack: Schema.String,
  fixtureFingerprint: Schema.String,
  machine: BenchMachine,
  outcome: Schema.String,
  resumed: Schema.optionalKey(Schema.Boolean),
  totalMs: Schema.Int,
  phases: Schema.Array(BenchPhase),
  quality: Schema.optionalKey(BenchQuality)
}) {
  get completed(): boolean {
    return this.outcome === "completed"
  }

  get totalTokens(): number {
    return this.phases.reduce((sum, phase) => sum + phase.tokens.total + phase.tokens.cached, 0)
  }

  get totalCostUsd(): number | undefined {
    const values = this.phases.flatMap((phase) =>
      phase.costUsd === undefined ? [] : [phase.costUsd]
    )
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0)
  }

  get selfHealing(): number {
    return this.phases.reduce((sum, phase) => sum + phase.counters.selfHealing, 0)
  }
}

export const CurrentBenchSchema = 1
export const BenchUnstaged = "(none)"

export interface BenchObservation {
  readonly openStages: ReadonlyArray<string>
  readonly cells: ReadonlyMap<string, BenchTokens>
  readonly cellKeys: ReadonlyMap<string, readonly [stage: string, model: string]>
  readonly counters: ReadonlyMap<string, BenchCounters>
  readonly modelsServed: ReadonlySet<string>
}

export const emptyBenchObservation = (): BenchObservation => ({
  openStages: [],
  cells: new Map(),
  cellKeys: new Map(),
  counters: new Map(),
  modelsServed: new Set()
})

const currentStage = (observation: BenchObservation): string =>
  observation.openStages[observation.openStages.length - 1] ?? BenchUnstaged

const dropFirst = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> => {
  const index = values.indexOf(value)
  return index < 0 ? values : [...values.slice(0, index), ...values.slice(index + 1)]
}

const classifyNotice = (message: string, counters: BenchCounters): BenchCounters | undefined => {
  if (message.startsWith("⟳ flaky")) {
    return new BenchCounters({
      ...counters,
      flakyRetries: counters.flakyRetries + 1
    })
  }
  if (message.startsWith("⟳ transient")) {
    return new BenchCounters({
      ...counters,
      transientRetries: counters.transientRetries + 1
    })
  }
  if (message.startsWith("↻ auto-resume")) {
    return new BenchCounters({
      ...counters,
      autoResumes: counters.autoResumes + 1
    })
  }
  if (message.includes("turn limit hit")) {
    return new BenchCounters({
      ...counters,
      turnLimitTrips: counters.turnLimitTrips + 1
    })
  }
  if (message.includes("shrinking to")) {
    return new BenchCounters({
      ...counters,
      shrinks: counters.shrinks + 1
    })
  }
  return undefined
}

export const observeBench = (observation: BenchObservation, event: FlowEvent): BenchObservation => {
  switch (event._tag) {
    case "StageStarted":
      return {
        ...observation,
        openStages: [event.stage, ...observation.openStages]
      }
    case "StageCompleted":
    case "StageFailed":
      return {
        ...observation,
        openStages: dropFirst(observation.openStages, event.stage)
      }
    case "TokensUsed": {
      const stage = currentStage(observation)
      const model = event.model ?? ""
      const key = JSON.stringify([stage, model])
      const cells = new Map(observation.cells)
      cells.set(key, (cells.get(key) ?? emptyBenchTokens()).add(benchTokensFromUsage(event.usage)))
      return {
        ...observation,
        cells,
        cellKeys: new Map(observation.cellKeys).set(key, [stage, model]),
        modelsServed:
          event.model === undefined
            ? observation.modelsServed
            : new Set([...observation.modelsServed, event.model])
      }
    }
    case "Info": {
      const stage = currentStage(observation)
      const current = observation.counters.get(stage) ?? emptyBenchCounters()
      const next = classifyNotice(event.message, current)
      return next === undefined
        ? observation
        : {
            ...observation,
            counters: new Map(observation.counters).set(stage, next)
          }
    }
    default:
      return observation
  }
}

export const stageBenchTokens = (observation: BenchObservation, stage: string): BenchTokens =>
  [...observation.cells.entries()].reduce((total, [key, tokens]) => {
    const parts = observation.cellKeys.get(key)
    return parts?.[0] === stage ? total.add(tokens) : total
  }, emptyBenchTokens())

export const stageBenchCounters = (observation: BenchObservation, stage: string): BenchCounters =>
  observation.counters.get(stage) ?? emptyBenchCounters()

export const makeBenchPhase = (
  observation: BenchObservation,
  stage: string,
  ms: number,
  detail: Readonly<Record<string, string>> = {}
): BenchPhase => {
  const costs = [...observation.cells.entries()].flatMap(([key, tokens]) => {
    const parts = observation.cellKeys.get(key)
    if (parts?.[0] !== stage) {
      return []
    }
    const cost = estimateCostUsd(
      parts[1],
      TokenUsage.make({
        prompt: tokens.prompt,
        completion: tokens.completion,
        total: tokens.total,
        ...(tokens.cached <= 0 ? {} : { cached: tokens.cached })
      })
    )
    return cost === undefined ? [] : [cost]
  })
  return BenchPhase.make({
    name: stage,
    ms,
    tokens: stageBenchTokens(observation, stage),
    counters: stageBenchCounters(observation, stage),
    detail,
    ...(costs.length === 0 ? {} : { costUsd: costs.reduce((sum, cost) => sum + cost, 0) })
  })
}

const isHub = (events: FlowEventsShape): events is FlowEventHub =>
  "subscribe" in events && "publishedCount" in events && "stream" in events

export interface BenchTap {
  readonly get: Effect.Effect<BenchObservation>
  readonly reset: Effect.Effect<void>
}

export const makeBenchTap = Effect.fn("@llm4ts/flow/Bench.makeTap")(function* (
  events: FlowEventsShape
): Effect.fn.Return<BenchTap, never, Scope.Scope> {
  const observation = yield* Ref.make(emptyBenchObservation())
  const consumed = yield* Ref.make(0)
  if (!isHub(events)) {
    return {
      get: Ref.get(observation),
      reset: Ref.set(observation, emptyBenchObservation())
    }
  }
  const subscription = yield* events.subscribe
  const baseline = yield* events.publishedCount
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((event) =>
      Ref.update(observation, (current) => observeBench(current, event)).pipe(
        Effect.andThen(Ref.update(consumed, (count) => count + 1))
      )
    ),
    Effect.forkScoped
  )
  const drain: Effect.Effect<void> = Effect.suspend(() =>
    Effect.all([events.publishedCount, Ref.get(consumed)]).pipe(
      Effect.flatMap(([published, seen]) =>
        seen >= published - baseline ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(drain))
      )
    )
  )
  return {
    get: drain.pipe(Effect.andThen(Ref.get(observation))),
    reset: drain.pipe(Effect.andThen(Ref.set(observation, emptyBenchObservation())))
  }
})
