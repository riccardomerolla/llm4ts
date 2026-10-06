// The differential tier (ADR 0028, the Bun port's test swarm): every test
// file runs once on the legacy build for a baseline, then on the target; a
// file passes when the target exits 0 and its pass count equals the
// baseline's; the rest are classified diverge, crash or hang and written as
// `.diag` files; one fixer per red file reads its diag as its only runtime
// evidence; two votes review; one rebuild per round; until green or stalled.
//
//   LLM4TS_PACK=zig-rust llm4ts run port-tests --repo ~/src/bun
//
// Knobs: LLM4TS_PORT_CONCURRENCY (4), LLM4TS_REVIEW_VOTES (2 here),
// LLM4TS_PORT_TEST_ROUNDS (4), LLM4TS_GATE_TAIL_CHARS (4000).
import { join } from "node:path"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { makeChat } from "@llm4ts/flow/Chat"
import { FlowAborted, Stalled } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import {
  diffVerdict,
  renderDiag,
  renderDifferentialReport,
  type DiffVerdict
} from "@llm4ts/flow/Port"
import {
  ReviewResult,
  adversarialReviewer,
  lintCommand,
  reviewAndFixLoop
} from "@llm4ts/flow/Review"
import { matchingFiles } from "@llm4ts/flow/SpecChecks"
import { runQueue } from "@llm4ts/flow/WorkQueue"
import {
  asReadOnly,
  coderFromEnv,
  makeNodeWorkspace,
  nodePlainFileStore,
  nodeProcessExecutor,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { asPortingPack, compileFixerSystem, portEnv, portStateDir } from "./lib/port.ts"

const Baseline = Schema.fromJsonString(ReviewResult)
const encodeBaseline = Schema.encodeSync(Baseline)
const decodeBaseline = Schema.decodeUnknownOption(Baseline)

const slug = (path: string): string => path.replace(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "Run every test file on the legacy and the target build, fix what diverges"
  )
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const knobs = portEnv(process.env)
  const maxRounds = Math.max(
    1,
    Number.parseInt(process.env.LLM4TS_PORT_TEST_ROUNDS ?? "4", 10) || 4
  )
  const tailChars = Math.max(
    500,
    Number.parseInt(process.env.LLM4TS_GATE_TAIL_CHARS ?? "4000", 10) || 4000
  )
  const stateDir = join(portStateDir(input.workDir), "tests")

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
        const differential = porting.pack.differential
        if (differential === undefined) {
          return yield* FlowAborted.make({
            message: `pack '${porting.pack.name}' has no '## Differential' section (- tests: <regex>, - legacy: <cmd {{file}}>, - target: <cmd {{file}}>)`
          })
        }
        const timeout = Duration.seconds(differential.timeoutSeconds)
        const testFiles = yield* stage(
          events,
          "test files",
          matchingFiles(repo, differential.tests, porting.pack.exclude)
        )
        const command = (template: ReadonlyArray<string>, file: string) =>
          template.map((part) => part.replaceAll("{{file}}", file))
        const build = porting.pack.gate("build") ?? porting.pack.gate("check")

        const baselineOf = (file: string) =>
          Effect.gen(function* () {
            const path = join(stateDir, `${slug(file)}.baseline.json`)
            const stored = yield* files.read(path)
            const decoded = stored === undefined ? undefined : decodeBaseline(stored)
            if (decoded !== undefined && decoded._tag === "Some") return decoded.value
            const legacy = yield* lintCommand(
              nodeProcessExecutor,
              events,
              command(differential.legacy, file),
              input.workDir,
              { timeout }
            )
            yield* files.writeAtomic(path, encodeBaseline(legacy))
            return legacy
          })

        let previous: number | undefined
        let flat = 0
        for (let round = 1; round <= maxRounds; round += 1) {
          if (build !== undefined) {
            const built = yield* stage(
              events,
              `build round ${round}`,
              lintCommand(nodeProcessExecutor, events, build, input.workDir, {
                timeout: Duration.minutes(20)
              })
            )
            if (!built.isClean) {
              return yield* FlowAborted.make({
                message: `the target does not build; run port-compile first:\n${built.issues
                  .map((issue) => issue.description)
                  .join("\n")
                  .slice(-tailChars)}`
              })
            }
          }
          const verdicts = yield* stage(
            events,
            `differential round ${round}`,
            Effect.forEach(
              testFiles,
              (file) =>
                Effect.gen(function* () {
                  const legacy = yield* baselineOf(file)
                  const target = yield* lintCommand(
                    nodeProcessExecutor,
                    events,
                    command(differential.target, file),
                    input.workDir,
                    { timeout }
                  )
                  const verdict = diffVerdict(file, legacy, target, [input.workDir])
                  if (verdict.class !== "pass" && verdict.class !== "legacy-red") {
                    yield* files.writeAtomic(
                      join(stateDir, `${slug(file)}.diag.md`),
                      renderDiag(verdict, tailChars)
                    )
                  }
                  return verdict
                }),
              { concurrency: knobs.concurrency }
            )
          )
          yield* files.writeAtomic(
            join(stateDir, `report-${round}.md`),
            renderDifferentialReport(round, verdicts)
          )
          const red = verdicts.filter(
            (verdict) =>
              verdict.class === "diverge" || verdict.class === "crash" || verdict.class === "hang"
          )
          yield* events.publish(
            Info.make({
              message: `port-tests: round ${round}, ${verdicts.length} file(s): ${verdicts.length - red.length - verdicts.filter((v) => v.class === "legacy-red").length} pass, ${red.length} red, ${verdicts.filter((v) => v.class === "legacy-red").length} red on legacy too`
            })
          )
          if (red.length === 0) {
            yield* events.publish(
              Info.make({
                message: `port-tests: green after ${round} round(s) — reports under ${stateDir}`
              })
            )
            return
          }
          if (previous !== undefined && red.length >= previous) {
            flat += 1
            if (flat >= 2) {
              return yield* Stalled.make({
                signal: "no-progress",
                detail: `port-tests: ${red.length} red file(s) after round ${round}, no fewer than before`
              })
            }
          } else {
            flat = 0
          }
          previous = red.length
          if (round === maxRounds) break

          const finished = yield* Ref.make<ReadonlySet<string>>(new Set())
          yield* runQueue({
            label: `port-tests fix round ${round}`,
            items: red.map((verdict) => ({ id: verdict.file, verdict })),
            done: (item) => Effect.map(Ref.get(finished), (set) => set.has(item.id)),
            concurrency: knobs.concurrency,
            maxRounds: 1,
            events,
            ledger: { files, path: join(stateDir, "fix-ledger.jsonl") },
            work: (item: { readonly id: string; readonly verdict: DiffVerdict }) =>
              Effect.gen(function* () {
                const diag =
                  (yield* files.read(join(stateDir, `${slug(item.id)}.diag.md`))) ??
                  renderDiag(item.verdict, tailChars)
                const chat = yield* makeChat(context.coder, {
                  system: compileFixerSystem(porting),
                  events,
                  agent: "coder",
                  stall: { repeats: 5 }
                })
                yield* chat.ask(
                  [
                    `Test file \`${item.id}\` passes on the legacy build and is ${item.verdict.class} on the target.`,
                    "The diagnostic below is your ONLY runtime evidence: fix the target code it points at (never",
                    "the test), do not rebuild or run tests yourself, and say `confidence: low` if you are",
                    "guessing without runtime confirmation.",
                    "",
                    diag
                  ].join("\n")
                )
                yield* reviewAndFixLoop({
                  reviewers: [adversarialReviewer, ...porting.pack.lenses],
                  reviewerService: context.reviewers[0] ?? context.reasoning,
                  coder: chat,
                  taskTitle: `port-tests ${item.id}`,
                  currentDiff: context.git.diffAll,
                  events,
                  maxRounds: 2,
                  votes: knobs.votes,
                  oracle: { diff: context.git.diffAll }
                })
                yield* Ref.update(finished, (set) => new Set([...set, item.id]))
                return { note: item.verdict.class }
              })
          }).pipe(Effect.catchTag("Stalled", () => Effect.void))
          const dirty = yield* context.git.uncommittedFiles
          if (dirty.length > 0) {
            yield* context.git.commitAll(
              `port-tests: round ${round}, ${red.length} red file(s) worked`
            )
          }
        }
        yield* events.publish(
          Info.make({
            message: `port-tests: ${maxRounds} round(s) done, red files remain — see ${stateDir}`
          })
        )
      })
  )
})

runFlowMain(program)
