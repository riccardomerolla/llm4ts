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
// (100), LLM4TS_REVIEW_VOTES (2 here), LLM4TS_PORT_SOURCE_CHARS (120000),
// LLM4TS_PORT_SHARDS (0: one checkout; n: n worktrees under .llm4ts/port/shards,
// each implementer in its own, merged into the checkout after every round).
import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { ApprovedMarker, requireApproval } from "@llm4ts/flow/Approval"
import { makeChat } from "@llm4ts/flow/Chat"
import { Info } from "@llm4ts/flow/FlowEvents"
import {
  asAddedFileDiff,
  batchesOf,
  ledgerRowsFor,
  portStatusIn,
  renderPilotReport,
  type PortEntry
} from "@llm4ts/flow/Port"
import { adversarialReviewer, reviewAndFixLoop } from "@llm4ts/flow/Review"
import { runQueue, type QueueOutcome, type Shard } from "@llm4ts/flow/WorkQueue"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
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
  ledgerPath,
  portEnv,
  readLedgerRows,
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

/** A shard's checkout, branch and the seats bound there (ADR 0028, decided later). */
interface PortShard extends Shard {
  readonly branch: string
  readonly context: FlowContextShape
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
      // Scoped: the shard contexts live until the run ends.
      Effect.scoped(
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
          const exists = (target: string, root: string = input.workDir) =>
            Effect.map(files.read(join(root, target)), (text) => text !== undefined)
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
          // A ledger written by port-ledger rides into every implementer prompt.
          const ledger = yield* readLedgerRows(files, input.workDir, porting)
          if (ledger.length > 0) {
            yield* events.publish(
              Info.make({
                message: `port: ${ledger.length} ledger row(s) from ${ledgerPath(porting)}`
              })
            )
          }
          const batches = batchesOf(items, { files: knobs.batch })
          const started = yield* Clock.currentTimeMillis
          const outcomes: Array<QueueOutcome> = []

          // Shards: one worktree per concurrent implementer, each on its own
          // branch from HEAD; drafts are committed there after a round, merged
          // into this checkout, and the shards catch up before the next round.
          // Items are disjoint target files, so the merges are clean.
          const shards: Array<PortShard> = []
          const baseBranch = yield* context.git.currentBranch
          if (knobs.shards > 0 && context.contextFor === undefined) {
            yield* events.publish(
              Info.make({
                message: `port: LLM4TS_PORT_SHARDS=${knobs.shards} needs a runner context that can rebind seats; working in one checkout`
              })
            )
          }
          const contextFor = context.contextFor
          if (knobs.shards > 0 && contextFor !== undefined) {
            for (let index = 1; index <= knobs.shards; index += 1) {
              const dir = join(stateDir, "shards", String(index))
              const branch = `llm4ts/port-shard-${index}`
              // A shard a failed run left behind is replaced, not reused.
              yield* Effect.ignore(context.git.removeWorktree(dir, true))
              if (yield* context.git.branchExists(branch)) {
                yield* context.git.deleteBranch(branch)
              }
              yield* context.git.addWorktreeNewBranch(dir, branch, "HEAD")
              const shardContext = yield* contextFor(dir, { label: `port shard ${index}` })
              shards.push({ id: `shard-${index}`, dir, branch, context: shardContext })
            }
            yield* events.publish(
              Info.make({
                message: `port: ${shards.length} shard(s) under ${join(stateDir, "shards")}`
              })
            )
          }
          const laneOf = (shard: Shard | undefined) =>
            shard === undefined
              ? { context, root: input.workDir }
              : (shards.find((candidate) => candidate.id === shard.id) ?? {
                  context,
                  root: input.workDir
                })
          const rootOf = (lane: { readonly root?: string; readonly dir?: string }) =>
            lane.dir ?? lane.root ?? input.workDir
          const shardOf = new Map<string, PortShard>()

          for (const [index, batch] of batches.entries()) {
            const report = yield* runQueue({
              label: `port batch ${index + 1}/${batches.length}`,
              items: batch,
              done: (entry, shard) => exists(entry.target, rootOf(laneOf(shard))),
              concurrency: knobs.concurrency,
              maxRounds: 2,
              events,
              ...(shards.length === 0 ? {} : { shards }),
              ledger: { files, path: join(stateDir, "ledger.jsonl") },
              afterRound: (round, done) =>
                Effect.gen(function* () {
                  if (done.length === 0) return
                  const message = `port: ${done.length} file(s) drafted (batch ${index + 1}, round ${round})`
                  if (shards.length === 0) {
                    yield* context.git.commitPaths(
                      message,
                      done.map((entry) => entry.target)
                    )
                    return
                  }
                  for (const shard of shards) {
                    const mine = done.filter((entry) => shardOf.get(entry.id) === shard)
                    if (mine.length === 0) continue
                    yield* shard.context.git.commitPaths(
                      `${message}, ${shard.id}`,
                      mine.map((entry) => entry.target)
                    )
                    yield* context.git.merge(
                      shard.branch,
                      `port: merge ${shard.id} (round ${round})`
                    )
                  }
                  for (const shard of shards) {
                    yield* shard.context.git.merge(baseBranch, `port: ${shard.id} catches up`)
                  }
                }),
              work: (entry, _round, shard) =>
                Effect.gen(function* () {
                  const lane = laneOf(shard)
                  const root = rootOf(lane)
                  const laneContext = lane.context
                  if (shard !== undefined && "branch" in lane) shardOf.set(entry.id, lane)
                  const source = (yield* files.read(join(input.workDir, entry.source))) ?? ""
                  const chat = yield* makeChat(laneContext.coder, {
                    system: implementerSystem(porting),
                    events,
                    agent: "coder",
                    stall: { repeats: 5 }
                  })
                  yield* chat.ask(
                    implementerPrompt(
                      entry,
                      source,
                      porting,
                      knobs.sourceChars,
                      ledgerRowsFor(ledger, entry.source)
                    )
                  )
                  const targetPath = join(root, entry.target)
                  if ((yield* files.read(targetPath)) === undefined) {
                    return { note: `nothing written at ${entry.target}` }
                  }
                  yield* reviewAndFixLoop({
                    reviewers: [adversarialReviewer, ...porting.pack.lenses],
                    reviewerService: laneContext.reviewers[0] ?? laneContext.reasoning,
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
                        makeChat(laneContext.coder, {
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
          for (const shard of shards) {
            yield* context.git.removeWorktree(shard.dir, true)
            yield* context.git.deleteBranch(shard.branch)
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
  )
})

runFlowMain(program)
