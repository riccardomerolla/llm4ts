import type { TokenUsage } from "@llm4ts/core/Models"

export interface ModelRate {
  readonly prefix: string
  readonly inputUsdPerMillion: number
  readonly outputUsdPerMillion: number
  readonly cachedInputMultiplier: number
}

export const PricesAsOf = "2026-07"

export const ModelRates: ReadonlyArray<ModelRate> = Object.freeze([
  {
    prefix: "claude-fable-5",
    inputUsdPerMillion: 10,
    outputUsdPerMillion: 50,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "claude-opus-4",
    inputUsdPerMillion: 15,
    outputUsdPerMillion: 75,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "claude-sonnet-4",
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "claude-haiku-4",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "gemini-2.5-pro",
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 10,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "gemini-2.5-flash",
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "gpt-5.5",
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "grok-4.5",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 6,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "grok-4.3",
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 2.5,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "grok-4.20",
    inputUsdPerMillion: 1.25,
    outputUsdPerMillion: 2.5,
    cachedInputMultiplier: 0.1
  },
  {
    prefix: "grok-build-0.1",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cachedInputMultiplier: 0.1
  }
])

export const estimateCostUsd = (model: string, usage: TokenUsage): number | undefined => {
  const rate = ModelRates.find(({ prefix }) => model.startsWith(prefix))
  if (rate === undefined) {
    return undefined
  }
  return (
    (usage.prompt / 1_000_000) * rate.inputUsdPerMillion +
    (usage.completion / 1_000_000) * rate.outputUsdPerMillion +
    ((usage.cached ?? 0) / 1_000_000) * rate.inputUsdPerMillion * rate.cachedInputMultiplier
  )
}
