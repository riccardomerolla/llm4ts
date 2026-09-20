import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { JudgmentBackend } from "@llm4ts/core/judgment/Schemas"
import { DatasetDecision, readDataset } from "@llm4ts/flow/JudgmentDataset"
import { evaluateJudgments, renderEvalReport, type EvalItem } from "@llm4ts/flow/JudgmentEval"
import { nodeFlowRunnerDependencies } from "@llm4ts/runner/FlowRunner"
import {
  argValue,
  backendFromEnvironment,
  batchingFromEnvironment,
  judgmentBackend,
  writeReport,
  JudgmentToolError
} from "./lib.ts"
import { Batching } from "@llm4ts/core/judgment/LlmJudgment"

class EvalToolError extends Schema.TaggedError<EvalToolError>()("EvalToolError", {
  message: Schema.String
}) {}

const usage = [
  "Usage: pnpm judgment:eval <decision> [--backend llm|typesafe|fake] [--dataset <path>] [--out <path>] [--concurrency N] [--pid PID] [--batching independent|shared-prefix]",
  "Decisions: review-prescreen | satisfied-probe | program-judge",
  "Default dataset: tools/judgment/datasets/<decision>.jsonl; concurrency: 1.",
  "Suggested --out: docs/judgment/evals/<YYYY-MM-DD>-<decision>.md",
  "--pid identifies the local LLM server explicitly; omitted means no RSS measurement."
].join("\n")
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const Path = Schema.String.check(Schema.isNonEmpty())
const Arguments = Schema.Struct({
  decision: DatasetDecision,
  backend: JudgmentBackend,
  dataset: Path,
  out: Schema.optionalKey(Path),
  concurrency: PositiveInt,
  pid: Schema.optionalKey(PositiveInt),
  batching: Batching
})

const residentMb = Effect.fn("JudgmentEval.residentMb")(function* (pid: number) {
  const raw = yield* Effect.try({
    try: () =>
      execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim(),
    catch: () =>
      EvalToolError.make({ message: "Could not sample RSS for the supplied server PID." })
  })
  const rss = yield* Schema.decodeUnknownEffect(PositiveInt)(Number(raw)).pipe(
    Effect.mapError(() => EvalToolError.make({ message: "Server RSS was absent or invalid." }))
  )
  return rss / 1024
})

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage)
    return
  }
  const [decision] = args
  const seen = new Set<string>()
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index] ?? ""
    if (
      !["--backend", "--dataset", "--out", "--concurrency", "--pid", "--batching"].includes(flag) ||
      seen.has(flag) ||
      args[index + 1] === undefined ||
      args[index + 1]?.startsWith("--")
    ) {
      return yield* EvalToolError.make({ message: usage })
    }
    seen.add(flag)
  }
  const environment = process.env
  const defaultBackend = backendFromEnvironment(environment)
  const options = yield* Schema.decodeUnknownEffect(Arguments)({
    decision,
    backend: argValue("backend", defaultBackend, args),
    dataset: argValue("dataset", `tools/judgment/datasets/${decision}.jsonl`, args),
    concurrency: Number(argValue("concurrency", "1", args)),
    batching: argValue("batching", batchingFromEnvironment(environment), args),
    ...(seen.has("--out") ? { out: argValue("out", "", args) } : {}),
    ...(seen.has("--pid") ? { pid: Number(argValue("pid", "", args)) } : {})
  }).pipe(Effect.mapError(() => EvalToolError.make({ message: usage })))
  if (options.pid !== undefined && options.backend !== "llm") {
    return yield* EvalToolError.make({
      message: "--pid requires the llm backend and the PID of its local server."
    })
  }
  const root = process.cwd()
  const dependencies = nodeFlowRunnerDependencies()
  const dataset = yield* readDataset(dependencies.files, resolve(root, options.dataset))
  if (dataset.length === 0) {
    return yield* EvalToolError.make({
      message: "Dataset is missing or empty; label items before evaluating."
    })
  }
  if (dataset.some((item) => item.decision !== options.decision)) {
    return yield* EvalToolError.make({
      message: "Dataset contains an item for a different decision."
    })
  }
  const backend = yield* judgmentBackend(
    options.backend,
    environment,
    root,
    dependencies,
    {},
    options.batching
  )
  const restMb = options.pid === undefined ? undefined : yield* residentMb(options.pid)
  const results = yield* Effect.forEach(
    dataset,
    (item) =>
      Effect.gen(function* () {
        const start = yield* Effect.sync(() => performance.now())
        const result = yield* backend.judgment
          .judge({ state: item.state, questions: { [item.id]: item.question } })
          .pipe(
            // Backend diagnostics can contain provider bodies; never print them or their causes.
            Effect.mapError(() =>
              EvalToolError.make({
                message: "Judgment backend request failed; evaluation aborted."
              })
            )
          )
        const latencyMs = (yield* Effect.sync(() => performance.now())) - start
        const answer = result.answers[item.id]
        const failed = result.failures.some((failure) => failure.key === item.id)
        const evaluation: EvalItem = {
          item,
          answer,
          latencyMs,
          ...(failed || answer === undefined || answer.type !== item.question.type
            ? { failure: "Question failed or returned no matching answer." }
            : {})
        }
        return { evaluation, model: result.model }
      }),
    { concurrency: options.concurrency }
  )
  const endMb = options.pid === undefined ? undefined : yield* residentMb(options.pid)
  const memory =
    restMb === undefined || endMb === undefined
      ? undefined
      : { restMb, peakMb: Math.max(restMb, endMb) }
  const report = evaluateJudgments(
    results.map(({ evaluation }) => evaluation),
    memory
  )
  const models = [
    ...new Set(results.flatMap(({ model }) => (model === undefined ? [] : [model])))
  ].sort()
  const markdown = renderEvalReport(report, {
    date: DateTime.formatIso(yield* DateTime.now).slice(0, 10),
    decision: options.decision,
    backend: backend.judgment.identity,
    model: models.length === 0 ? backend.model : models.join(", "),
    memoryNote:
      options.pid === undefined
        ? "Memory skipped: no local server PID supplied (--pid); no processes were guessed."
        : `Server PID ${options.pid}: ps RSS / 1024, sampled before and after evaluation. Peak is the larger sample, not a continuous high-water mark.`
  })
  yield* writeReport({
    markdown,
    out: options.out,
    root,
    tool: "eval",
    args,
    environment,
    files: dependencies.files,
    dataset: options.dataset
  })
})

Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // Only our own safe messages and dataset locations may reach the terminal.
        console.error(
          error instanceof EvalToolError ||
            error instanceof JudgmentToolError ||
            error._tag === "DatasetParseError"
            ? error.message
            : `Evaluation failed (${error._tag}).`
        )
        process.exitCode = 1
      })
    )
  )
).catch(() => {
  console.error("Evaluation failed unexpectedly.")
  process.exitCode = 1
})
