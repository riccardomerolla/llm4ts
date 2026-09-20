import { resolve } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  DatasetDecision,
  PromotionRefused,
  appendDataset,
  isLabelledPending,
  mergeCandidates,
  observationCandidates,
  preparePromotion,
  readDataset,
  readJsonLines,
  readPending,
  reviewCandidates,
  writePending
} from "@llm4ts/flow/JudgmentDataset"
import { JudgmentObservation, judgmentLogPath } from "@llm4ts/flow/JudgmentLog"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { argValue, commits, lenses } from "./lib.ts"

class LabelToolError extends Schema.TaggedError<LabelToolError>()("LabelToolError", {
  message: Schema.String
}) {}

const usage =
  "Usage: pnpm judgment:label seed|promote|status <decision> [--commits N] [--observations <path>]"
const Arguments = Schema.Struct({
  command: Schema.Literals(["seed", "promote", "status"]),
  decision: DatasetDecision,
  commits: Schema.Int.check(Schema.isGreaterThan(0)),
  observations: Schema.String.check(Schema.isNonEmpty())
})

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const [command, decision] = args
  for (let index = 2; index < args.length; index += 2) {
    if (
      command !== "seed" ||
      !["--commits", "--observations"].includes(args[index] ?? "") ||
      args[index + 1] === undefined ||
      args[index + 1]?.startsWith("--")
    ) {
      return yield* LabelToolError.make({ message: usage })
    }
  }
  const options = yield* Schema.decodeUnknownEffect(Arguments)({
    command,
    decision,
    commits: Number(argValue("commits", "30", args)),
    observations: argValue("observations", ".", args)
  }).pipe(Effect.mapError(() => LabelToolError.make({ message: usage })))
  const root = process.cwd()
  const path = resolve(root, `tools/judgment/datasets/${options.decision}.jsonl`)
  const pendingPath = path.replace(/\.jsonl$/, ".pending.jsonl")
  const files = nodePlainFileStore
  const dataset = yield* readDataset(files, path)
  const pending = yield* readPending(files, pendingPath)
  const misplaced = [...dataset, ...pending].filter((item) => item.decision !== options.decision)
  if (misplaced.length > 0)
    return yield* PromotionRefused.make({
      ids: misplaced.map((item) => item.id),
      message: `Wrong decision in ${path} or ${pendingPath}: ${misplaced.map((item) => item.id).join(", ")}`
    })

  switch (options.command) {
    case "status":
      console.log(
        `${options.decision}: dataset=${dataset.length} pending=${pending.length} labelled-pending=${pending.filter(isLabelledPending).length}`
      )
      return
    case "promote": {
      const promotion = yield* preparePromotion(pending, dataset)
      // Dataset first: retry after an interrupted pending rewrite skips existing ids.
      yield* appendDataset(files, path, promotion.items)
      yield* writePending(files, pendingPath, promotion.remaining)
      console.log(
        `Promoted ${promotion.items.length}; ${promotion.remaining.length} remain pending.`
      )
      return
    }
    case "seed": {
      const candidates =
        options.decision === "review-prescreen"
          ? reviewCandidates(
              yield* Effect.try({
                try: () => commits(root, options.commits),
                catch: () =>
                  LabelToolError.make({
                    message: "Could not read git history for review-prescreen."
                  })
              }),
              lenses
            )
          : yield* observationCandidates(
              options.decision,
              yield* readJsonLines(
                files,
                args.includes("--observations")
                  ? resolve(root, options.observations)
                  : judgmentLogPath(root, options.decision),
                JudgmentObservation
              )
            )
      if (candidates.length === 0) {
        console.log(
          `No seed source exists yet for ${options.decision}. Enable judgment observation logging, run this consumer, then seed again (or pass --observations <path>).`
        )
        return
      }
      const merged = mergeCandidates(pending, dataset, candidates)
      yield* writePending(files, pendingPath, merged)
      console.log(
        `Seeded ${merged.length - pending.length} candidates into ${pendingPath}; ${merged.length} pending.`
      )
    }
  }
})

Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.message)
        process.exitCode = 1
      })
    )
  )
).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
