// Legacy modernization benchmark: measure an extraction run and report the cost of a wave.
//
// Two modes:
//
//   report  — `modernize-bench --repo <anything> report` (or LLM4TS_BENCH_MODE=report)
//             loads bench-results.jsonl next to the launch directory and prints
//             the comparison report. LLM4TS_BENCH_PROJECT=<n> adds the per-wave
//             projection modernize-survey embeds in its wave plan.
//
//   measure — the default. Runs the extraction pipeline over the estate at
//             `--repo`, taps the flow's own events for per-stage tokens, cost,
//             and self-healing counters, then appends one schema-versioned
//             BenchRecord to bench-results.jsonl. Extraction is the dominant
//             cost of a modernization wave, so its measurement is what a wave
//             projection needs.
//
// The measured run writes into the estate exactly as modernize-extract would;
// point it at a disposable fixture copy, not a live estate.
//
// Run: modernize-bench --repo ~/estates/fixture-copy
import { arch, cpus, hostname, totalmem, type as osType } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Sample } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import {
  BenchJudge,
  BenchMachine,
  BenchQuality,
  BenchRecord,
  BenchScore,
  CurrentBenchSchema,
  makeBenchPhase,
  makeBenchTap,
  type BenchPhase
} from "@llm4ts/flow/Bench"
import { loadBenchRecords, appendBenchRecord, renderBenchReport } from "@llm4ts/flow/BenchReport"
import { FlowAborted, FlowLlmError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { packageVersion } from "@llm4ts/flow/Package"
import { loadPack } from "@llm4ts/flow/Pack"
import { stage } from "@llm4ts/flow/PlanExecution"
import { mergeReviewResults } from "@llm4ts/flow/Review"
import { coverage, coverageUnits, features, matchingFiles } from "@llm4ts/flow/SpecChecks"
import {
  ProgramArtifacts,
  ProgramUnit,
  extractProgramsResumably
} from "@llm4ts/modernize/Artifacts"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { reviewFingerprint } from "@llm4ts/runner/ReviewFingerprint"

const ModDir = "docs/modernization"
const BenchFile = "bench-results.jsonl"

const programName = (relativePath: string): string => {
  const base = relativePath.slice(relativePath.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(0, dot) : base
}

const machine = (): BenchMachine =>
  BenchMachine.make({
    hostname: hostname(),
    os: osType(),
    arch: arch(),
    cores: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    runtime: `node ${process.versions.node}`
  })

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Benchmark a modernization extraction run")
  const packDir = process.env.LLM4TS_PACK ?? "packs/cobol-springboot"
  const mode =
    process.env.LLM4TS_BENCH_MODE?.trim() ??
    (input.prompt.trim().toLowerCase() === "report" ? "report" : "measure")
  const files = nodePlainFileStore
  const benchPath = join(input.workspace, BenchFile)
  const coder = coderFromEnv(process.env)
  const startedAt = new Date()

  if (mode === "report") {
    const records = yield* loadBenchRecords(files, benchPath)
    if (records.length === 0) {
      return yield* FlowAborted.make({ message: `no benchmark records at ${benchPath}` })
    }
    const projected = Number.parseInt(process.env.LLM4TS_BENCH_PROJECT ?? "", 10)
    process.stdout.write(
      `${renderBenchReport(records, Number.isFinite(projected) && projected > 0 ? projected : undefined)}\n`
    )
    return
  }

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      environment: process.env
    },
    (context) =>
      Effect.scoped(
        Effect.gen(function* () {
          const launchWorkspace = yield* makeNodeWorkspace(input.workspace)
          const estate = yield* makeNodeWorkspace(input.workDir)
          const pack = yield* stage(context.events, "pack", loadPack(launchWorkspace, packDir))
          const modDirAbs = join(input.workDir, ModDir)
          // The tap observes the same events the terminal renders, so the
          // measurement never needs its own instrumentation inside the flow.
          const tap = yield* makeBenchTap(context.events)
          const phases: Array<BenchPhase> = []

          const measured = <A, E>(name: string, body: Effect.Effect<A, E>) =>
            Effect.gen(function* () {
              yield* tap.reset
              const began = Date.now()
              const value = yield* stage(context.events, name, body)
              const observation = yield* tap.get
              phases.push(makeBenchPhase(observation, name, Date.now() - began))
              return value
            })

          const programs = yield* measured(
            "inventory",
            matchingFiles(estate, pack.programs ?? pack.sources ?? ".*")
          )
          if (programs.length === 0) {
            return yield* FlowAborted.make({
              message: `no source units matched the pack's programs/sources regex under ${input.workDir}`
            })
          }
          const units = programs.map((relativePath) =>
            ProgramUnit.make({ name: programName(relativePath), sourcePath: relativePath })
          )
          const system = [
            pack.prompt("analysis"),
            pack.lessons === undefined
              ? undefined
              : `Lessons from previous modernization runs — apply them:\n${pack.lessons}`
          ]
            .filter((part) => part !== undefined)
            .join("\n\n")

          yield* measured(
            "extract",
            extractProgramsResumably(
              files,
              units,
              (unit) =>
                context.coder
                  .executeStructured(
                    [
                      system,
                      "",
                      `Extract the behavioural spec for ONE source unit: ${unit.sourcePath}`,
                      'Respond only with JSON: {"spec":"…","feature":"…","traceability":"…","mapping":"…"}.',
                      pack.prompt("spec") ?? "",
                      pack.prompt("bdd") ?? ""
                    ].join("\n"),
                    ProgramArtifacts,
                    { type: "object" }
                  )
                  .pipe(Effect.mapError(FlowLlmError.from)),
              modDirAbs
            )
          )

          // The deterministic half of the extraction gate, measured on its own:
          // it is the part a slower model cannot make cheaper.
          const deterministic = yield* measured(
            "gate",
            Effect.gen(function* () {
              const fragments: Array<string> = []
              for (const unit of units) {
                const text = yield* files.read(join(modDirAbs, "traceability", `${unit.name}.md`))
                if (text !== undefined) {
                  fragments.push(text)
                }
              }
              const trace = fragments.join("\n\n")
              const covered = yield* coverage(estate, pack.coverage, trace)
              const wellFormed = yield* features(estate, `${ModDir}/features`)
              return mergeReviewResults([covered, wellFormed])
            })
          )

          const judged = yield* measured(
            "judge",
            Effect.gen(function* () {
              const packJudge = judge(context.reasoning, pack.judgeDimensions)
              const scores: Array<BenchScore> = []
              let findings = 0
              for (const unit of units) {
                const spec = (yield* files.read(join(modDirAbs, "specs", `${unit.name}.md`))) ?? ""
                const source = (yield* files.read(join(input.workDir, unit.sourcePath))) ?? ""
                const scored = yield* packJudge
                  .evaluate(Sample.make({ response: spec, context: source, query: input.prompt }))
                  .pipe(Effect.mapError(FlowLlmError.from))
                for (const score of scored.scores) {
                  const max = pack.judgeDimensions.find((d) => d.name === score.name)?.maxScore ?? 2
                  scores.push(
                    BenchScore.make({
                      name: `${unit.name}:${score.name}`,
                      score: score.score,
                      max,
                      reasoning: score.reasoning
                    })
                  )
                  if (score.score < max) {
                    findings += 1
                  }
                }
              }
              return { scores, findings }
            })
          )

          const quality = yield* Effect.gen(function* () {
            const specFiles = yield* matchingFiles(estate, `^${ModDir}/specs/.*\\.md$`).pipe(
              Effect.orElseSucceed(() => [])
            )
            const featureFiles = yield* matchingFiles(
              estate,
              `^${ModDir}/features/.*\\.feature$`
            ).pipe(Effect.orElseSucceed(() => []))
            let scenarios = 0
            for (const path of featureFiles) {
              const text = yield* estate.read(path).pipe(Effect.orElseSucceed(() => ""))
              scenarios += text
                .split(/\r?\n/)
                .filter((line) => line.trim().startsWith("Scenario")).length
            }
            let sourceLines = 0
            for (const path of programs) {
              const text = yield* estate.read(path).pipe(Effect.orElseSucceed(() => ""))
              sourceLines += text.split(/\r?\n/).length
            }
            const units_ = yield* coverageUnits(estate, pack.coverage)
            const malformed = (yield* features(estate, `${ModDir}/features`)).issues.length
            return BenchQuality.make({
              featureFiles: featureFiles.length,
              scenarios,
              malformedFeatures: malformed,
              specFiles: specFiles.length,
              programs: programs.length,
              sourceFiles: programs.length,
              sourceLines,
              testFiles: featureFiles.length,
              testLines: scenarios,
              deterministicFindings: deterministic.issues.length,
              judgeFindings: judged.findings,
              gateCleared: deterministic.issues.length === 0 && judged.findings === 0,
              gateOpenIssues: deterministic.issues.length + judged.findings,
              judgeScores: judged.scores,
              // The rule universe is the estate's own coverage units.
              coveragePct:
                Object.values(units_).flat().length === 0
                  ? 0
                  : Math.round(
                      (Object.values(units_)
                        .flat()
                        .filter((unit) => unit.length > 0).length /
                        Object.values(units_).flat().length) *
                        100
                    )
            })
          })

          // The fingerprint groups records of the SAME estate so the report can
          // compare providers rather than mixing unrelated fixtures.
          const fingerprint = reviewFingerprint(
            pack.name,
            ...[...programs].sort(),
            String(quality.sourceLines)
          ).slice(0, 16)

          const finishedAt = new Date()
          const record = BenchRecord.make({
            schemaVersion: CurrentBenchSchema,
            runId: `${startedAt.toISOString()}-${process.pid}`,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            provider: coder.connectorId.value,
            modelRequested: coder.model ?? "(harness default)",
            modelsServed: [],
            judge: BenchJudge.make({
              provider: coder.connectorId.value,
              model: coder.model ?? "(harness default)",
              fixed: false
            }),
            llm4tsVersion: packageVersion,
            pack: pack.name,
            fixtureFingerprint: fingerprint,
            machine: machine(),
            outcome: quality.gateCleared === true ? "completed" : "gate-open",
            totalMs: finishedAt.getTime() - startedAt.getTime(),
            phases,
            quality
          })

          yield* appendBenchRecord(files, benchPath, record)
          yield* context.events.publish(
            Info.make({
              message:
                `benchmark appended to ${benchPath} — ${record.totalTokens} token(s) over ` +
                `${phases.length} phase(s); report with LLM4TS_BENCH_MODE=report`
            })
          )
          const all = yield* loadBenchRecords(files, benchPath)
          process.stdout.write(`${renderBenchReport(all)}\n`)
        })
      )
  )
})

runFlowMain(program)
