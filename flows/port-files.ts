// Port a code base file by file (ADR 0028, the Bun port's Phase A): every
// source the pack matches gets a draft at its target path, written by one
// implementer that reads the rulebook, the pitfall cards and exactly one
// source file; reviewed by two adversarial votes; fixed by a separate fixer;
// ending in a machine-readable PORT STATUS trailer the ledger records. Not
// clean-room: the source stays in the tree as the spec. Resumable: a target
// that exists is done.
//
//   LLM4TS_PACK=zig-rust llm4ts run port-files --repo ~/src/bun
//   LLM4TS_PORT_PILOT=3 … first: three files, a pilot report, an approval
//
// Knobs: LLM4TS_PORT_PILOT, LLM4TS_PORT_CONCURRENCY (4), LLM4TS_PORT_BATCH
// (100), LLM4TS_REVIEW_VOTES (2 here), LLM4TS_PORT_SOURCE_CHARS (120000).
import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { ApprovedMarker, requireApproval } from "@llm4ts/flow/Approval"
import { makeChat } from "@llm4ts/flow/Chat"
import { Info } from "@llm4ts/flow/FlowEvents"
import {
  asAddedFileDiff,
  batchesOf,
  portStatusIn,
  renderPilotReport,
  type PortEntry
} from "@llm4ts/flow/Port"
import { adversarialReviewer, reviewAndFixLoop } from "@llm4ts/flow/Review"
import { runQueue, type QueueOutcome } from "@llm4ts/flow/WorkQueue"
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
import {
  asPortingPack,
  implementerPrompt,
  implementerSystem,
  portEnv,
  portFixerSystem,
  portManifest,
  portStateDir
} from "./lib/port.ts"

const renderReport = (
  outcomes: ReadonlyArray<QueueOutcome>,
  total: number,
  pending: number
): string => {
  const done = outcomes.filter((outcome) => outcome.status === "done")
  const failed = outcomes.filter((outcome) => outcome.status === "failed")
  const by = (level: "high" | "medium" | "low") =>
    done.filter((outcome) => outcome.confidence === level).length
  const low = done.filter((outcome) => outcome.confidence === "low")
  return [
    "# Port report",
    "",
    `- sources: ${total}; drafted this run: ${done.length}; failed: ${failed.length}; still pending: ${pending}`,
    `- confidence: ${by("high")} high, ${by("medium")} medium, ${by("low")} low; TODO(port) markers: ${done.reduce((sum, outcome) => sum + (outcome.todos ?? 0), 0)}`,
    "",
    ...(low.length === 0
      ? []
      : [
          "## Re-read against the source first (confidence: low)",
          "",
          ...low.map(
            (outcome) => `- ${outcome.id}${outcome.note === undefined ? "" : ` — ${outcome.note}`}`
          ),
          ""
        ]),
    ...(failed.length === 0
      ? []
      : ["## Failed", "", ...failed.map((outcome) => `- ${outcome.id}: ${outcome.note ?? ""}`), ""])
  ].join("\n")
}

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Port every source file the pack matches to its target")
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const knobs = portEnv(process.env)
  const stateDir = portStateDir(input.workDir)
  const pilotPath = join(stateDir, "pilot.md")

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
        const manifest = yield* stage(
          events,
          "manifest",
          portManifest(repo, files, input.workDir, porting)
        )
        const exists = (target: string) =>
          Effect.map(files.read(join(input.workDir, target)), (text) => text !== undefined)
        const pending: Array<PortEntry> = []
        for (const entry of manifest) {
          if (!(yield* exists(entry.target))) pending.push(entry)
        }
        yield* events.publish(
          Info.make({
            message: `port: ${manifest.length} source(s), ${manifest.length - pending.length} already ported, ${pending.length} pending (pack ${porting.pack.name}, target ${porting.target})`
          })
        )
        if (knobs.pilot === 0 && (yield* files.read(pilotPath)) !== undefined) {
          // A pilot ran: the rest of the port waits for its approval (R7).
          yield* requireApproval(files, pilotPath)
        }
        const items = knobs.pilot > 0 ? pending.slice(0, knobs.pilot) : pending
        const batches = batchesOf(items, { files: knobs.batch })
        const started = yield* Clock.currentTimeMillis
        const outcomes: Array<QueueOutcome> = []

        for (const [index, batch] of batches.entries()) {
          const report = yield* runQueue({
            label: `port batch ${index + 1}/${batches.length}`,
            items: batch,
            done: (entry) => exists(entry.target),
            concurrency: knobs.concurrency,
            maxRounds: 2,
            events,
            ledger: { files, path: join(stateDir, "ledger.jsonl") },
            afterRound: (round, done) =>
              done.length === 0
                ? Effect.void
                : Effect.asVoid(
                    context.git.commitPaths(
                      `port: ${done.length} file(s) drafted (batch ${index + 1}, round ${round})`,
                      done.map((entry) => entry.target)
                    )
                  ),
            work: (entry) =>
              Effect.gen(function* () {
                const source = (yield* files.read(join(input.workDir, entry.source))) ?? ""
                const chat = yield* makeChat(context.coder, {
                  system: implementerSystem(porting),
                  events,
                  agent: "coder",
                  stall: { repeats: 5 }
                })
                yield* chat.ask(implementerPrompt(entry, source, porting, knobs.sourceChars))
                const targetPath = join(input.workDir, entry.target)
                if ((yield* files.read(targetPath)) === undefined) {
                  return { note: `nothing written at ${entry.target}` }
                }
                yield* reviewAndFixLoop({
                  reviewers: [adversarialReviewer, ...porting.pack.lenses],
                  reviewerService: context.reviewers[0] ?? context.reasoning,
                  coder: chat,
                  taskTitle: `port ${entry.source}`,
                  currentDiff: Effect.map(files.read(targetPath), (text) =>
                    asAddedFileDiff(entry.target, text ?? "")
                  ),
                  events,
                  maxRounds: 2,
                  votes: knobs.votes,
                  fixWith: (prompt) =>
                    Effect.flatMap(
                      makeChat(context.coder, {
                        system: portFixerSystem(porting),
                        events,
                        agent: "coder",
                        stall: { repeats: 5 }
                      }),
                      (fixer) =>
                        fixer.ask(
                          `${prompt}\n\nThe ported file is ${entry.target}; its source is ${entry.source}.`
                        )
                    )
                })
                const status = portStatusIn((yield* files.read(targetPath)) ?? "")
                return {
                  ...(status.confidence === undefined ? {} : { confidence: status.confidence }),
                  ...(status.todos === undefined ? {} : { todos: status.todos }),
                  ...(status.notes === undefined || status.notes === "none"
                    ? {}
                    : { note: status.notes })
                }
              })
          })
          outcomes.push(...report.outcomes)
        }

        const stillPending =
          pending.length - outcomes.filter((outcome) => outcome.status === "done").length
        yield* files.writeAtomic(
          join(stateDir, "report.md"),
          renderReport(outcomes, manifest.length, stillPending)
        )
        if (knobs.pilot > 0) {
          const pilot = renderPilotReport({
            outcomes,
            piloted: items.length,
            remaining: pending.length - items.length,
            elapsedMs: (yield* Clock.currentTimeMillis) - started,
            estimatedCostUsd: undefined
          })
          yield* files.writeAtomic(pilotPath, pilot)
          yield* events.publish(
            Info.make({
              message: `port: pilot of ${items.length} file(s) done — read ${pilotPath}, tick \`${ApprovedMarker}\`, then run again without LLM4TS_PORT_PILOT to port the remaining ${pending.length - items.length}`
            })
          )
        } else {
          yield* events.publish(
            Info.make({
              message: `port: ${outcomes.filter((o) => o.status === "done").length} drafted, ${stillPending} still pending — report at ${join(stateDir, "report.md")}`
            })
          )
        }
      })
  )
})

runFlowMain(program)
