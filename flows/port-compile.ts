// Compiler diagnostics as a work queue (ADR 0028, the Bun port's Phase B/D):
// the pack's `## Diagnostics` command runs once per round, its output is
// grouped by unit, one fixer per unit edits only that unit (no build, no
// git), two adversarial votes review, the flow rebuilds and commits. Until
// dry, or until a round lowers nothing (typed Stalled).
//
//   LLM4TS_PACK=zig-rust llm4ts run port-compile --repo ~/src/bun
//
// Knobs: LLM4TS_PORT_CONCURRENCY (4), LLM4TS_REVIEW_VOTES (2 here),
// LLM4TS_PORT_COMPILE_ROUNDS (6).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { makeChat } from "@llm4ts/flow/Chat"
import {
  groupDiagnostics,
  parseDiagnostics,
  renderDiagnostics,
  type Diagnostic
} from "@llm4ts/flow/Diagnostics"
import { FlowAborted, ProcessError, Stalled } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { adversarialReviewer, reviewAndFixLoop } from "@llm4ts/flow/Review"
import { runQueue } from "@llm4ts/flow/WorkQueue"
import {
  asReadOnly,
  coderFromEnv,
  nodePlainFileStore,
  nodeProcessExecutor,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { asPortingPack, compileFixerSystem, portEnv, portStateDir } from "./lib/port.ts"

interface Unit {
  readonly id: string
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Fix every compiler diagnostic, one unit at a time")
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const knobs = portEnv(process.env)
  const maxRounds = Math.max(
    1,
    Number.parseInt(process.env.LLM4TS_PORT_COMPILE_ROUNDS ?? "6", 10) || 6
  )
  const stateDir = portStateDir(input.workDir)

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
        const diagnostics = porting.pack.diagnostics
        if (diagnostics === undefined) {
          return yield* FlowAborted.make({
            message: `pack '${porting.pack.name}' has no '## Diagnostics' section (- command: …, - format: json | cargo)`
          })
        }
        const survey = Effect.gen(function* () {
          const ran = yield* nodeProcessExecutor
            .run(diagnostics.command, input.workDir, {})
            .pipe(
              Effect.mapError((cause) =>
                ProcessError.make({ message: diagnostics.command.join(" "), detail: cause.message })
              )
            )
          return parseDiagnostics([...ran.stdout, ...ran.stderr].join("\n"), diagnostics.format)
        })

        let previous: number | undefined
        let flat = 0
        for (let round = 1; round <= maxRounds; round += 1) {
          const found = yield* stage(events, `diagnostics round ${round}`, survey)
          const groups = groupDiagnostics(found)
          yield* files.writeAtomic(
            join(stateDir, `diagnostics-${round}.md`),
            [
              `# Diagnostics, round ${round}`,
              "",
              ...groups.map(
                (group) => `## ${group.unit}\n\n${renderDiagnostics(group.diagnostics, 200)}`
              )
            ].join("\n")
          )
          if (found.length === 0) {
            yield* events.publish(
              Info.make({ message: `compile: clean after ${round - 1} round(s)` })
            )
            return
          }
          if (previous !== undefined && found.length >= previous) {
            flat += 1
            if (flat >= 2) {
              return yield* Stalled.make({
                signal: "no-progress",
                detail: `compile: ${found.length} diagnostic(s) after round ${round - 1}, no lower than the round before`
              })
            }
          } else {
            flat = 0
          }
          previous = found.length
          yield* events.publish(
            Info.make({
              message: `compile: round ${round}, ${found.length} diagnostic(s) in ${groups.length} unit(s)`
            })
          )
          const finished = yield* Ref.make<ReadonlySet<string>>(new Set())
          const units: ReadonlyArray<Unit> = groups.map((group) => ({
            id: group.unit,
            diagnostics: group.diagnostics
          }))
          yield* runQueue({
            label: `compile round ${round}`,
            items: units,
            done: (unit) => Effect.map(Ref.get(finished), (set) => set.has(unit.id)),
            concurrency: knobs.concurrency,
            maxRounds: 1,
            events,
            ledger: { files, path: join(stateDir, "compile-ledger.jsonl") },
            work: (unit) =>
              Effect.gen(function* () {
                const chat = yield* makeChat(context.coder, {
                  system: compileFixerSystem(porting),
                  events,
                  agent: "coder",
                  stall: { repeats: 5 }
                })
                yield* chat.ask(
                  [
                    `Unit \`${unit.id}\`: ${unit.diagnostics.length} diagnostic(s) from \`${diagnostics.command.join(" ")}\`.`,
                    "Fix them in this unit's files. This file is your only runtime evidence; do not rebuild.",
                    "",
                    renderDiagnostics(unit.diagnostics)
                  ].join("\n")
                )
                yield* reviewAndFixLoop({
                  reviewers: [adversarialReviewer, ...porting.pack.lenses],
                  reviewerService: context.reviewers[0] ?? context.reasoning,
                  coder: chat,
                  taskTitle: `compile ${unit.id}`,
                  currentDiff: context.git.diffAll,
                  events,
                  maxRounds: 2,
                  votes: knobs.votes
                })
                yield* Ref.update(finished, (set) => new Set([...set, unit.id]))
                return { note: `${unit.diagnostics.length} diagnostic(s) addressed` }
              })
          }).pipe(
            // A unit the fixer could not finish is the next survey's business.
            Effect.catchTag("Stalled", () => Effect.void)
          )
          const dirty = yield* context.git.uncommittedFiles
          if (dirty.length > 0) {
            yield* context.git.commitAll(`compile: round ${round}, ${units.length} unit(s)`)
          }
        }
        yield* events.publish(
          Info.make({
            message: `compile: ${maxRounds} round(s) done, diagnostics remain — see ${stateDir}`
          })
        )
      })
  )
})

runFlowMain(program)
