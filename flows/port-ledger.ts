// A precomputed cross-file table for the implementers (ADR 0028, the Bun
// port's LIFETIMES.tsv): every unit the pack's `## Ledger` regex names in a
// source file is classified by the reasoning seat with the line that proves
// it; UNKNOWN and low-confidence rows plus a fifth of the rest face three
// refuters; the table lands beside the specs and `port-files` hands each
// implementer its own rows, "trust the table over local guessing".
//
//   LLM4TS_PACK=zig-rust llm4ts run port-ledger --repo ~/src/bun
//
// Knobs: LLM4TS_PORT_CONCURRENCY (4), LLM4TS_PORT_SOURCE_CHARS (120000).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { cap } from "@llm4ts/flow/Context"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { LedgerRow, renderLedger, standsAfterRefutes, unitsIn } from "@llm4ts/flow/Port"
import { runQueue } from "@llm4ts/flow/WorkQueue"
import type { JsonSchema } from "@llm4ts/core/Models"
import {
  asReadOnly,
  coderFromEnv,
  makeNodeWorkspace,
  nodePlainFileStore,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { asPortingPack, ledgerPath, portEnv, portManifest } from "./lib/port.ts"

class Classified extends Schema.Class<Classified>("Classified")({
  rows: Schema.Array(
    Schema.Struct({
      unit: Schema.String,
      class: Schema.String,
      evidence: Schema.String,
      confidence: Schema.Literals(["high", "medium", "low"])
    })
  )
}) {}
const classifiedJson: JsonSchema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unit: { type: "string" },
          class: { type: "string" },
          evidence: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["unit", "class", "evidence", "confidence"]
      }
    }
  },
  required: ["rows"]
}
class Refute extends Schema.Class<Refute>("Refute")({
  holds: Schema.Boolean,
  why: Schema.String,
  correctedClass: Schema.optionalKey(Schema.String)
}) {}
const refuteJson: JsonSchema = {
  type: "object",
  properties: {
    holds: { type: "boolean" },
    why: { type: "string" },
    correctedClass: { type: "string" }
  },
  required: ["holds", "why"]
}

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Classify every unit the pack's ledger regex names")
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const knobs = portEnv(process.env)

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      reviewers: [asReadOnly(coder)],
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const events = context.events
        const repo = yield* makeNodeWorkspace(input.workDir)
        const opened = yield* stage(
          events,
          "pack",
          openPack({
            environment: process.env,
            launchDir: input.workspace,
            flowDir: import.meta.dirname
          })
        )
        const porting = yield* asPortingPack(opened)
        const ledger = porting.pack.ledger
        if (ledger === undefined) {
          return yield* FlowAborted.make({
            message: `pack '${porting.pack.name}' has no '## Ledger' section (- unit: <regex>, - classes: …, - question: …)`
          })
        }
        const classes = ledger.classes.length === 0 ? ["UNKNOWN"] : ledger.classes
        const unknown = classes.find((name) => name.toUpperCase() === "UNKNOWN") ?? "UNKNOWN"
        const manifest = yield* stage(
          events,
          "manifest",
          portManifest(repo, files, input.workDir, porting)
        )
        const rows = yield* Ref.make<ReadonlyArray<LedgerRow>>([])
        const finished = yield* Ref.make<ReadonlySet<string>>(new Set())

        yield* runQueue({
          label: "ledger",
          items: manifest,
          done: (entry) => Effect.map(Ref.get(finished), (set) => set.has(entry.id)),
          concurrency: knobs.concurrency,
          maxRounds: 2,
          events,
          work: (entry) =>
            Effect.gen(function* () {
              const text = (yield* files.read(join(input.workDir, entry.source))) ?? ""
              const units = unitsIn(text, ledger.unit)
              if (units.length === 0) {
                yield* Ref.update(finished, (set) => new Set([...set, entry.id]))
                return { note: "no units" }
              }
              const classified = yield* structuredAndPublish(
                context.reasoning,
                events,
                [
                  `Classify every unit listed below in \`${entry.source}\`. ${ledger.question}`,
                  `Classes: ${classes.join(", ")}. Use ${unknown} when the file alone cannot tell.`,
                  "For each unit give the class, the evidence as `file:line` of the statement that proves",
                  "it (an initialisation, a deinit, an assignment), and your confidence. Return ONLY JSON",
                  "matching the schema.",
                  "",
                  "Units:",
                  ...units.map((unit) => `- unit: ${unit}`),
                  "",
                  "```",
                  cap(text, knobs.sourceChars).text,
                  "```"
                ].join("\n"),
                Classified,
                classifiedJson,
                "ledger"
              )
              const settled: Array<LedgerRow> = []
              for (const [index, row] of classified.rows.entries()) {
                if (!units.includes(row.unit)) continue
                const doubtful =
                  row.class.toUpperCase() === unknown.toUpperCase() ||
                  row.confidence === "low" ||
                  index % 5 === 0
                let klass = classes.includes(row.class) ? row.class : unknown
                let confidence = row.confidence
                if (doubtful) {
                  const votes = yield* Effect.forEach(
                    [1, 2, 3],
                    (vote) =>
                      structuredAndPublish(
                        context.reasoning,
                        events,
                        [
                          `Refuter ${vote} of 3. Does this classification hold? ${ledger.question}`,
                          `Unit \`${row.unit}\` in \`${entry.source}\` was classified ${klass} (evidence: ${row.evidence}).`,
                          `Classes: ${classes.join(", ")}. Refute it (holds: false) and give correctedClass when the`,
                          "file shows a different class, or when the evidence does not support it. Return ONLY JSON.",
                          "",
                          "```",
                          cap(text, knobs.sourceChars).text,
                          "```"
                        ].join("\n"),
                        Refute,
                        refuteJson,
                        "ledger-refuter"
                      ),
                    { concurrency: 3 }
                  )
                  if (!standsAfterRefutes(votes.map((vote) => vote.holds))) {
                    const corrected = votes
                      .map((vote) => vote.correctedClass)
                      .find((candidate) => candidate !== undefined && classes.includes(candidate))
                    klass = corrected ?? unknown
                    confidence = corrected === undefined ? "low" : "medium"
                  }
                }
                settled.push(
                  LedgerRow.make({
                    file: entry.source,
                    unit: row.unit,
                    class: klass,
                    evidence: row.evidence,
                    confidence
                  })
                )
              }
              yield* Ref.update(rows, (all) => [...all, ...settled])
              yield* Ref.update(finished, (set) => new Set([...set, entry.id]))
              return { note: `${settled.length} unit(s)` }
            })
        })

        const all = [...(yield* Ref.get(rows))].sort((left, right) =>
          `${left.file}\t${left.unit}`.localeCompare(`${right.file}\t${right.unit}`)
        )
        const path = ledgerPath(porting)
        yield* files.writeAtomic(join(input.workDir, path), renderLedger(all))
        yield* context.git.commitPaths(`port: ledger of ${all.length} unit(s)`, [path])
        const counts = new Map<string, number>()
        for (const row of all) counts.set(row.class, (counts.get(row.class) ?? 0) + 1)
        yield* events.publish(
          Info.make({
            message: `port-ledger: ${all.length} unit(s) in ${manifest.length} file(s) → ${path} (${[...counts.entries()].map(([klass, count]) => `${klass} ${count}`).join(", ")})`
          })
        )
      })
  )
})

runFlowMain(program)
