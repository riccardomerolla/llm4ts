import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { State, ScoreQuestion, TruthQuestion, truth } from "@llm4ts/core/judgment/Schemas"
import type { JudgmentObservation } from "./JudgmentLog.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import type { Reviewer } from "./Reviewer.ts"

export const DatasetDecision = Schema.Literals([
  "review-prescreen",
  "satisfied-probe",
  "program-judge"
])
export type DatasetDecision = typeof DatasetDecision.Type
const Text = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0))
const DatasetQuestion = Schema.Union([TruthQuestion, ScoreQuestion])
const baseFields = {
  id: Text,
  decision: DatasetDecision,
  state: State,
  question: DatasetQuestion,
  source: Text
}
const correctQuestion = (item: {
  readonly decision: DatasetDecision
  readonly question: typeof DatasetQuestion.Type
}) => item.question.type === (item.decision === "program-judge" ? "score" : "truth")

export const validLabel = (question: typeof DatasetQuestion.Type, label: unknown): boolean =>
  question.type === "truth"
    ? typeof label === "boolean"
    : typeof label === "number" &&
      Number.isInteger(label) &&
      label >= 0 &&
      label < question.criteria.length

const LabelledRecord = Schema.Struct({
  ...baseFields,
  label: Schema.Union([Schema.Boolean, Schema.Int]),
  labelledBy: Text,
  /** Human-supplied ISO 8601 timestamp. */
  labelledAt: Schema.String.check(
    Schema.makeFilter(
      (value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    )
  )
}).check(
  Schema.makeFilter(correctQuestion),
  Schema.makeFilter(
    (item) =>
      validLabel(item.question, item.label) ||
      `Invalid label for ${item.id} (${item.question.type})`
  )
)

export class LabelledItem extends Schema.Class<LabelledItem>("LabelledItem")(LabelledRecord) {}

/** Seeds omit the label; edits remain readable so promotion can report all refused ids. */
export class PendingItem extends Schema.Class<PendingItem>("PendingItem")(
  Schema.Struct({
    ...baseFields,
    label: Schema.optionalKey(Schema.Json),
    labelledBy: Schema.optionalKey(Schema.NullOr(Schema.String)),
    labelledAt: Schema.optionalKey(Schema.NullOr(Schema.String))
  }).check(Schema.makeFilter(correctQuestion))
) {}

export class DatasetParseError extends Schema.TaggedError<DatasetParseError>()(
  "DatasetParseError",
  {
    path: Schema.String,
    line: Schema.Int,
    message: Schema.String
  }
) {}

export class PromotionRefused extends Schema.TaggedError<PromotionRefused>()("PromotionRefused", {
  ids: Schema.Array(Schema.String),
  message: Schema.String
}) {}

/** A missing file is an empty set. Blank interior lines are malformed; a final newline is optional. */
export const readJsonLines = Effect.fn("JudgmentDataset.readJsonLines")(function* <A, I>(
  files: PlainFileStoreShape,
  path: string,
  schema: Schema.Codec<A, I>
) {
  const contents = yield* files.read(path)
  if (contents === undefined || contents === "") return []
  const lines = contents.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return yield* Effect.forEach(lines, (line, index) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(line).pipe(
      Effect.mapError(() =>
        DatasetParseError.make({
          path,
          line: index + 1,
          message: `Malformed JSONL record at ${path}:${index + 1}`
        })
      )
    )
  )
})

export const readDataset = (files: PlainFileStoreShape, path: string) =>
  readJsonLines(files, path, LabelledItem)
export const readPending = (files: PlainFileStoreShape, path: string) =>
  readJsonLines(files, path, PendingItem)

const encodeLines = Effect.fn("JudgmentDataset.encodeLines")(function* <A, I>(
  path: string,
  schema: Schema.Codec<A, I>,
  items: ReadonlyArray<A>
) {
  const lines = yield* Effect.forEach(items, (item, index) =>
    Schema.encodeEffect(Schema.fromJsonString(schema))(item).pipe(
      Effect.mapError(() =>
        DatasetParseError.make({
          path,
          line: index + 1,
          message: `Invalid record for ${path}:${index + 1}`
        })
      )
    )
  )
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
})

export const appendDataset = Effect.fn("JudgmentDataset.appendDataset")(function* (
  files: PlainFileStoreShape,
  path: string,
  items: ReadonlyArray<LabelledItem>
) {
  yield* readDataset(files, path)
  const encoded = yield* encodeLines(path, LabelledItem, items)
  if (encoded === "") return
  const previous = yield* files.read(path)
  yield* files.append(path, `${previous && !previous.endsWith("\n") ? "\n" : ""}${encoded}`)
})

export const writePending = Effect.fn("JudgmentDataset.writePending")(function* (
  files: PlainFileStoreShape,
  path: string,
  items: ReadonlyArray<PendingItem>
) {
  const encoded = yield* encodeLines(path, PendingItem, items)
  yield* files.writeAtomic(path, encoded)
})

/** Escaping keeps source components unambiguous without a runtime-specific hash dependency. */
export const candidateId = (decision: DatasetDecision, source: string): string =>
  `${decision}:${encodeURIComponent(source)}`

export const reviewCandidates = (
  commits: ReadonlyArray<{ readonly sha: string; readonly diff: string }>,
  lenses: ReadonlyArray<Reviewer>
): ReadonlyArray<PendingItem> =>
  commits.flatMap((commit) =>
    lenses.map((lens) => {
      const source = `commit:${commit.sha}:${lens.name}`
      return PendingItem.make({
        id: candidateId("review-prescreen", source),
        decision: "review-prescreen",
        state: { diff: commit.diff },
        question: truth(lens.screeningStatement),
        source
      })
    })
  )

/** Line position distinguishes repeated observations within a run, even at the same timestamp. */
export const observationCandidates = Effect.fn("JudgmentDataset.observationCandidates")(function* (
  decision: DatasetDecision,
  observations: ReadonlyArray<JudgmentObservation>
) {
  return yield* Effect.forEach(
    observations
      .map((observation, index) => ({ observation, index }))
      .filter(({ observation }) => observation.consumer === decision),
    ({ observation, index }) => {
      const source = `observation:${encodeURIComponent(observation.runId)}:${observation.consumer}:${encodeURIComponent(observation.key)}:${observation.at}:${index + 1}`
      return Schema.decodeUnknownEffect(PendingItem)({
        id: candidateId(decision, source),
        decision,
        state: observation.state,
        question: observation.question,
        source
      }).pipe(
        Effect.mapError(() =>
          DatasetParseError.make({
            path: source,
            line: index + 1,
            message: `Question kind does not match decision ${decision} at ${source}`
          })
        )
      )
    }
  )
})

/** Existing human edits win; duplicates in the incoming batch are skipped too. */
export const mergeCandidates = (
  pending: ReadonlyArray<PendingItem>,
  dataset: ReadonlyArray<LabelledItem>,
  candidates: ReadonlyArray<PendingItem>
): ReadonlyArray<PendingItem> => {
  const seen = new Set([...pending, ...dataset].map((item) => item.id))
  return [
    ...pending,
    ...candidates.filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
  ]
}

export const isLabelledPending = (item: PendingItem): boolean => Schema.is(LabelledRecord)(item)

/**
 * Validate the whole batch before any writes. An item nobody has labelled yet
 * (label absent or null) simply stays pending, so labelling can proceed in
 * batches; a label that is present but of the wrong kind or out of range
 * refuses the whole promotion, naming the ids. Complete labels with
 * incomplete attribution stay pending too.
 */
export const preparePromotion = Effect.fn("JudgmentDataset.preparePromotion")(function* (
  pending: ReadonlyArray<PendingItem>,
  dataset: ReadonlyArray<LabelledItem>
) {
  const ids = pending
    .filter(
      (item) =>
        item.label !== undefined && item.label !== null && !validLabel(item.question, item.label)
    )
    .map((item) => item.id)
  if (ids.length > 0)
    return yield* PromotionRefused.make({
      ids,
      message: `Refusing promotion: missing or invalid labels for ids: ${ids.join(", ")}`
    })
  const ready = pending.filter(isLabelledPending)
  const labelled = yield* Effect.forEach(ready, (item) =>
    Schema.decodeUnknownEffect(LabelledItem)(item)
  )
  const existing = new Set(dataset.map((item) => item.id))
  return {
    items: labelled.filter((item) => {
      if (existing.has(item.id)) return false
      existing.add(item.id)
      return true
    }),
    remaining: pending.filter((item) => !isLabelledPending(item))
  }
})
