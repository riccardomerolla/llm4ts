import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { BudgetExceeded, PlanParseError, type FlowError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { stablePromptHash } from "./Plan.ts"
import { PricesAsOf } from "./PriceList.ts"

export class CostCell extends Schema.Class<CostCell>("CostCell")({
  stage: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  prompt: Schema.Int,
  completion: Schema.Int,
  cached: Schema.optionalKey(Schema.Int),
  total: Schema.Int,
  costUsd: Schema.optionalKey(Schema.Number)
}) {}

export class CostRecord extends Schema.Class<CostRecord>("CostRecord")({
  schemaVersion: Schema.Int,
  runId: Schema.String,
  at: Schema.String,
  repo: Schema.String,
  label: Schema.optionalKey(Schema.String),
  promptHead: Schema.String,
  promptHash: Schema.String,
  pricesAsOf: Schema.String,
  cells: Schema.Array(CostCell),
  totalPrompt: Schema.Int,
  totalCompletion: Schema.Int,
  totalCostUsd: Schema.optionalKey(Schema.Number)
}) {}

export const CurrentCostRecordSchema = 1
export const CostLedgerFileName = "costs.jsonl"

export interface CostRecordInput {
  readonly runId: string
  readonly at: string
  readonly repo: string
  readonly label?: string
  readonly prompt: string
  readonly cells: ReadonlyArray<CostCell>
}

export const makeCostRecord = (input: CostRecordInput): CostRecord => {
  const costs = input.cells.flatMap((cell) => (cell.costUsd === undefined ? [] : [cell.costUsd]))
  return CostRecord.make({
    schemaVersion: CurrentCostRecordSchema,
    runId: input.runId,
    at: input.at,
    repo: input.repo,
    ...(input.label === undefined ? {} : { label: input.label }),
    promptHead: input.prompt.trim().replaceAll(/\s+/gu, " ").slice(0, 120),
    promptHash: stablePromptHash(input.prompt),
    pricesAsOf: PricesAsOf,
    cells: input.cells,
    totalPrompt: input.cells.reduce((sum, cell) => sum + cell.prompt, 0),
    totalCompletion: input.cells.reduce((sum, cell) => sum + cell.completion, 0),
    ...(costs.length === 0 ? {} : { totalCostUsd: costs.reduce((sum, cost) => sum + cost, 0) })
  })
}

export class CostBudget extends Schema.Class<CostBudget>("CostBudget")({
  maximumTokens: Schema.optionalKey(Schema.Int),
  maximumCostUsd: Schema.optionalKey(Schema.Number)
}) {}

export const checkCostBudget = (
  record: CostRecord,
  budget: CostBudget
): Effect.Effect<void, BudgetExceeded> => {
  const totalTokens = record.totalPrompt + record.totalCompletion
  if (budget.maximumTokens !== undefined && totalTokens > budget.maximumTokens) {
    return Effect.fail(
      BudgetExceeded.make({
        metric: "tokens",
        limit: budget.maximumTokens,
        actual: totalTokens
      })
    )
  }
  if (budget.maximumCostUsd !== undefined && (record.totalCostUsd ?? 0) > budget.maximumCostUsd) {
    return Effect.fail(
      BudgetExceeded.make({
        metric: "costUsd",
        limit: budget.maximumCostUsd,
        actual: record.totalCostUsd ?? 0
      })
    )
  }
  return Effect.void
}

const costRecordCodec = Schema.fromJsonString(CostRecord)

export const appendCostRecord = Effect.fn("@llm4ts/flow/CostLedger.append")(function* (
  files: PlainFileStoreShape,
  path: string,
  record: CostRecord
): Effect.fn.Return<void, FlowError> {
  const encoded = yield* Schema.encodeEffect(costRecordCodec)(record).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `failed to encode cost record: ${String(error)}`
      })
    )
  )
  yield* files.append(path, `${encoded}\n`)
})

export const loadCostLedger = Effect.fn("@llm4ts/flow/CostLedger.load")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<ReadonlyArray<CostRecord>, FlowError> {
  const contents = yield* files.read(path)
  if (contents === undefined) {
    return []
  }
  const parsed = yield* Effect.forEach(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    (line) =>
      Schema.decodeUnknownEffect(costRecordCodec)(line).pipe(
        Effect.option,
        Effect.map((option) => (option._tag === "Some" ? [option.value] : []))
      ),
    { concurrency: 1 }
  )
  return parsed.flat()
})

const sumOptional = (values: ReadonlyArray<number | undefined>): number | undefined => {
  const present = values.flatMap((value) => (value === undefined ? [] : [value]))
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0)
}

export const mergeCostCells = (records: ReadonlyArray<CostRecord>): ReadonlyArray<CostCell> => {
  const groups = new Map<string, Array<CostCell>>()
  for (const cell of records.flatMap((record) => record.cells)) {
    const key = JSON.stringify([cell.stage, cell.agent, cell.model])
    groups.set(key, [...(groups.get(key) ?? []), cell])
  }
  return [...groups.values()]
    .map((cells) => {
      const first = cells[0]
      if (first === undefined) {
        return undefined
      }
      const cached = sumOptional(cells.map((cell) => cell.cached))
      const costUsd = sumOptional(cells.map((cell) => cell.costUsd))
      return CostCell.make({
        stage: first.stage,
        agent: first.agent,
        model: first.model,
        prompt: cells.reduce((sum, cell) => sum + cell.prompt, 0),
        completion: cells.reduce((sum, cell) => sum + cell.completion, 0),
        total: cells.reduce((sum, cell) => sum + cell.total, 0),
        ...(cached === undefined ? {} : { cached }),
        ...(costUsd === undefined ? {} : { costUsd })
      })
    })
    .filter((cell): cell is CostCell => cell !== undefined)
    .sort((left, right) =>
      [left.stage, left.agent, left.model]
        .join("\0")
        .localeCompare([right.stage, right.agent, right.model].join("\0"))
    )
}
