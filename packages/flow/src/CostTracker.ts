import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { TokenUsage } from "@llm4ts/core/Models"
import { CostCell } from "./CostLedger.ts"
import type { FlowEvent, FlowEventHub } from "./FlowEvents.ts"
import { estimateCostUsd, PricesAsOf } from "./PriceList.ts"

interface CostState {
  readonly byAgent: ReadonlyMap<string, TokenUsage>
  readonly byModel: ReadonlyMap<string, TokenUsage>
  readonly byCell: ReadonlyMap<string, TokenUsage>
  readonly cellKeys: ReadonlyMap<string, readonly [stage: string, agent: string, model: string]>
  readonly openStages: ReadonlyArray<string>
}

export interface CostTracker {
  readonly record: (event: FlowEvent) => Effect.Effect<void>
  readonly cells: Effect.Effect<ReadonlyArray<CostCell>>
  readonly summary: Effect.Effect<string>
  readonly consume: (hub: FlowEventHub) => Effect.Effect<void, never, Scope.Scope>
  readonly awaitDrained: (hub: FlowEventHub) => Effect.Effect<void>
}

const emptyState: CostState = {
  byAgent: new Map(),
  byModel: new Map(),
  byCell: new Map(),
  cellKeys: new Map(),
  openStages: []
}

const mergeUsage = (previous: TokenUsage | undefined, usage: TokenUsage): TokenUsage => {
  const cachedValues = [previous?.cached, usage.cached].flatMap((value) =>
    value === undefined ? [] : [value]
  )
  const costValues = [previous?.costUsd, usage.costUsd].flatMap((value) =>
    value === undefined ? [] : [value]
  )
  return TokenUsage.make({
    prompt: (previous?.prompt ?? 0) + usage.prompt,
    completion: (previous?.completion ?? 0) + usage.completion,
    total: (previous?.total ?? 0) + usage.total,
    ...(cachedValues.length === 0
      ? {}
      : {
          cached: cachedValues.reduce((sum, value) => sum + value, 0)
        }),
    ...(costValues.length === 0
      ? {}
      : {
          costUsd: costValues.reduce((sum, value) => sum + value, 0)
        })
  })
}

// Backend-reported cost is authoritative; the pricing table only fills in
// when the backend said nothing.
const costOf = (model: string, usage: TokenUsage): number | undefined =>
  usage.costUsd ?? (model === "(unknown)" ? undefined : estimateCostUsd(model, usage))

const addUsage = (
  values: ReadonlyMap<string, TokenUsage>,
  key: string,
  usage: TokenUsage
): ReadonlyMap<string, TokenUsage> => new Map(values).set(key, mergeUsage(values.get(key), usage))

const updateCostState = (state: CostState, event: FlowEvent): CostState => {
  switch (event._tag) {
    case "TokensUsed": {
      const model = event.model ?? "(unknown)"
      const stage = state.openStages[0] ?? "(no stage)"
      const cellKey = JSON.stringify([stage, event.agent, model])
      return {
        ...state,
        byAgent: addUsage(state.byAgent, event.agent, event.usage),
        byModel: addUsage(state.byModel, model, event.usage),
        byCell: addUsage(state.byCell, cellKey, event.usage),
        cellKeys: new Map(state.cellKeys).set(cellKey, [stage, event.agent, model])
      }
    }
    case "StageStarted":
      return { ...state, openStages: [event.stage, ...state.openStages] }
    case "StageCompleted":
    case "StageFailed":
      return { ...state, openStages: state.openStages.slice(1) }
    default:
      return state
  }
}

const tokenLine = (label: string, usage: TokenUsage, cost: number | undefined): string => {
  const cached = usage.cached === undefined || usage.cached <= 0 ? "" : ` (${usage.cached} cached)`
  const money = cost === undefined ? "" : ` ($${cost.toFixed(4)}*)`
  return `  ${label}: ${usage.prompt} in${cached}, ${usage.completion} out${money}`
}

const renderSummary = (state: CostState): string => {
  const agents = [...state.byAgent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent, usage]) => tokenLine(agent, usage, undefined))
  const models = [...state.byModel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, usage]) => {
      const cost = costOf(model, usage)
      return { line: tokenLine(model, usage, cost), cost }
    })
  if (agents.length === 0 && models.length === 0) {
    return "cost: no usage reported (the selected backend emits no token counts)"
  }
  const total = models.reduce((sum, entry) => sum + (entry.cost ?? 0), 0)
  const footnote =
    total <= 0
      ? ""
      : `\n\n* estimated from the pricing table (rates as of ${PricesAsOf} — may be stale)`
  const sections: Array<string> = []
  if (agents.length > 0) {
    sections.push(`By agent:\n${agents.join("\n")}`)
  }
  if (models.length > 0) {
    sections.push(`By model:\n${models.map(({ line }) => line).join("\n")}`)
  }
  sections.push(`Total: ${total <= 0 ? "$0.00" : `$${total.toFixed(4)}`}${footnote}`)
  return sections.join("\n\n")
}

export const makeCostTracker = Effect.fn("@llm4ts/flow/CostTracker.make")(
  function* (): Effect.fn.Return<CostTracker> {
    const state = yield* Ref.make<CostState>(emptyState)
    const consumed = yield* Ref.make(0)
    const record = (event: FlowEvent): Effect.Effect<void> =>
      Ref.update(state, (current) => updateCostState(current, event))
    return {
      record,
      cells: Ref.get(state).pipe(
        Effect.map((current) =>
          [...current.byCell.entries()]
            .flatMap(([key, usage]) => {
              const parts = current.cellKeys.get(key)
              if (parts === undefined) {
                return []
              }
              const [stage, agent, model] = parts
              const costUsd = costOf(model, usage)
              return [
                CostCell.make({
                  stage,
                  agent,
                  model,
                  prompt: usage.prompt,
                  completion: usage.completion,
                  total: usage.total,
                  ...(usage.cached === undefined ? {} : { cached: usage.cached }),
                  ...(costUsd === undefined ? {} : { costUsd })
                })
              ]
            })
            .sort((left, right) =>
              [left.stage, left.agent, left.model]
                .join("\0")
                .localeCompare([right.stage, right.agent, right.model].join("\0"))
            )
        )
      ),
      summary: Ref.get(state).pipe(Effect.map(renderSummary)),
      consume: (hub) =>
        Effect.gen(function* () {
          const subscription = yield* hub.subscribe
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((event) =>
              record(event).pipe(Effect.andThen(Ref.update(consumed, (count) => count + 1)))
            ),
            Effect.forkScoped,
            Effect.asVoid
          )
        }),
      awaitDrained: (hub) =>
        Effect.gen(function* () {
          const target = yield* hub.publishedCount
          const drain: Effect.Effect<void> = Effect.suspend(() =>
            Ref.get(consumed).pipe(
              Effect.flatMap((count) =>
                count >= target ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(drain))
              )
            )
          )
          yield* drain
        })
    }
  }
)
