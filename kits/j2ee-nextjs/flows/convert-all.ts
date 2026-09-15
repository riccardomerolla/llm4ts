// Convert the whole legacy estate: walk the approved domain map (one branch per feature) or the survey inventory (one branch per page) in wave order, progress board, estimated-cost migration report.
//
// Runs rooted at the TARGET repository (`--repo <nextjs>`), with
// LLM4TS_LEGACY_REPO pointing at the extracted legacy repository:
//
//   LLM4TS_LEGACY_REPO=~/estates/demo-bank-legacy \
//     llm4ts run convert-all --repo ~/estates/demo-bank-nextjs
//
// Order comes from the approved docs/modernization/wave-plan.md when present,
// otherwise every extracted spec alphabetically. The board (a BoardSync port)
// always writes the local files at .llm4ts/convert/board.{json,md}; when
// LLM4TS_ADO_ORG_URL and LLM4TS_ADO_PROJECT are set, an Azure DevOps
// work-item mirror is added via the az CLI (LLM4TS_ADO_REPO defaults to the
// project; auth belongs to az itself — `az devops login` or
// AZURE_DEVOPS_EXT_PAT, never an llm4ts variable, per ADR 0011).
// A failing page is marked failed and the walk continues
// (LLM4TS_FAIL_FAST=1 stops instead); pages already done on the board are
// skipped, so re-running resumes. Every token/cost figure — including the
// closing whole-estate projection in docs/conversion/migration-report.md —
// is an ESTIMATE, and the report says so.
import { basename, join } from "node:path"
import * as Effect from "effect/Effect"
import { AdoConfig, makeAzureDevOpsTool } from "@llm4ts/flow/AzureDevOpsTool"
import {
  BoardItem,
  composeBoardSync,
  makeAdoBoardSync,
  makeLocalBoardSync,
  type BoardSyncShape
} from "@llm4ts/flow/BoardSync"
import { describeFlowError } from "@llm4ts/flow/FlowError"
import {
  Info,
  asReadOnly,
  coderFromEnv,
  nodePlainFileStore,
  nodeProcessExecutor,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import {
  conversionInventory,
  convertFeature,
  convertPage,
  featureInventory,
  migrationReport,
  setupConversion,
  type ConvertOutcome,
  type MigrationRow
} from "./lib/convert.ts"
import type { FlowError } from "@llm4ts/flow/FlowError"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Convert the legacy estate into the destination SPA")
  const coder = coderFromEnv(process.env)

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
        const deps = yield* setupConversion(context, input, process.env, import.meta.dirname)
        const files = nodePlainFileStore
        const boardTitle = `Conversion: ${basename(input.workDir)}`

        const boards: Array<BoardSyncShape> = [
          makeLocalBoardSync(files, join(input.workDir, ".llm4ts", "convert"), boardTitle)
        ]
        const orgUrl = process.env.LLM4TS_ADO_ORG_URL?.trim()
        const project = process.env.LLM4TS_ADO_PROJECT?.trim()
        if (orgUrl !== undefined && orgUrl.length > 0 && project !== undefined) {
          // az CLI owns the credentials (`az devops login` / AZURE_DEVOPS_EXT_PAT);
          // no PAT ever passes through llm4ts configuration.
          const ado = makeAzureDevOpsTool(
            AdoConfig.make({
              orgUrl,
              project,
              repository: process.env.LLM4TS_ADO_REPO?.trim() || project
            }),
            nodeProcessExecutor,
            input.workDir,
            context.events
          )
          boards.push(yield* makeAdoBoardSync(ado, boardTitle))
          yield* context.events.publish(
            Info.make({ message: `ADO board mirror enabled: ${orgUrl}/${project}` })
          )
        }
        const board = composeBoardSync(boards)

        // ADR 0012 addendum: an approved domain map makes the feature the
        // unit of delivery; without one the walk is per page as before.
        const features = yield* stage(
          context.events,
          "inventory",
          featureInventory(files, deps.legacy, deps.legacyDir, deps.pack)
        )
        interface WalkItem {
          readonly id: string
          readonly title: string
          readonly wave?: string
          readonly detail?: string
          /** Listed on the board with this reason, never converted. */
          readonly skip?: string
          readonly convert: Effect.Effect<ConvertOutcome, FlowError>
        }
        let items: ReadonlyArray<WalkItem>
        if (features !== undefined) {
          yield* context.events.publish(
            Info.make({
              message: `approved domain map: converting ${features.length} feature(s), one branch each`
            })
          )
          items = features.map((entry) => ({
            id: entry.feature.id,
            title: entry.feature.name,
            ...(entry.wave === undefined ? {} : { wave: entry.wave }),
            detail: `pages: ${entry.feature.programs.join(", ")}`,
            ...(entry.disposed ? { skip: "every page disposed by decision" } : {}),
            convert: convertFeature(deps, entry.feature.id)
          }))
        } else {
          const inventory = yield* conversionInventory(
            files,
            deps.legacy,
            deps.legacyDir,
            deps.pack
          )
          items = yield* Effect.forEach(inventory, ({ page, wave, disposition }) =>
            Effect.gen(function* () {
              const specPath = join(deps.legacyDir, deps.pack.specsDir, `${page}.md`)
              const missing = (yield* files.read(specPath)) === undefined
              return {
                id: page,
                title: page,
                ...(wave === undefined ? {} : { wave }),
                // A page the decisions overlay disposed of as a whole (ADR 0015)
                // is listed with its disposition, like a page triaged dead.
                ...(disposition !== undefined
                  ? { skip: `${disposition} by decision` }
                  : missing
                    ? { skip: "no extracted spec" }
                    : {}),
                convert: convertPage(deps, page)
              } satisfies WalkItem
            })
          )
        }
        if (items.length === 0) {
          yield* context.events.publish(
            Info.make({ message: "inventory is empty — extract the legacy estate first" })
          )
          return
        }
        // The whole estate lands on the board as planned up front — the
        // breadth view exists from minute one.
        yield* stage(
          context.events,
          "board",
          board.plan(
            items.map((item) =>
              BoardItem.make({
                id: item.id,
                title: item.title,
                status: "planned",
                ...(item.wave === undefined ? {} : { wave: item.wave }),
                ...(item.detail === undefined ? {} : { detail: item.detail })
              })
            )
          )
        )

        const baseBranch = yield* context.git.currentBranch
        const failFast = process.env.LLM4TS_FAIL_FAST === "1"

        for (const item of items) {
          const snapshot = yield* board.snapshot
          const known = snapshot.items.find((candidate) => candidate.id === item.id)
          if (known !== undefined && known.status !== "planned" && known.status !== "failed") {
            yield* context.events.publish(
              Info.make({ message: `resume: ${item.id} is already ${known.status} — skipping` })
            )
            continue
          }
          if (item.skip !== undefined) {
            yield* board.skip(item.id, item.skip)
            continue
          }
          const checkpoint = yield* context.git.checkpoint
          yield* board.start(item.id)
          const result = yield* Effect.result(item.convert)
          if (result._tag === "Success") {
            const outcome = result.success
            yield* board.complete(item.id, {
              branch: outcome.branch,
              reportPath: outcome.reportPath,
              ...(outcome.estimatedTokens === undefined
                ? {}
                : { estimatedTokens: outcome.estimatedTokens }),
              ...(outcome.estimatedCostUsd === undefined
                ? {}
                : { estimatedCostUsd: outcome.estimatedCostUsd })
            })
            yield* context.git.checkout(baseBranch)
          } else {
            const reason = describeFlowError(result.failure)
            // A stuck unit must not sink the walk: reset the working tree,
            // mark the failure, keep going (LLM4TS_FAIL_FAST=1 to stop).
            yield* context.git.rollback(checkpoint)
            yield* context.git.checkout(baseBranch)
            yield* board.fail(item.id, reason)
            if (failFast) {
              return yield* Effect.fromResult(result)
            }
            yield* context.events.publish(
              Info.make({ message: `${item.id} failed — continuing: ${reason}` })
            )
          }
        }

        const finalBoard = yield* board.snapshot
        const rows: Array<MigrationRow> = finalBoard.items.flatMap((item) =>
          item.status === "done" || item.status === "failed" || item.status === "skipped"
            ? [
                {
                  page: item.id,
                  outcome: item.status,
                  ...(item.detail === undefined ? {} : { detail: item.detail }),
                  ...(item.estimatedTokens === undefined
                    ? {}
                    : { estimatedTokens: item.estimatedTokens }),
                  ...(item.estimatedCostUsd === undefined
                    ? {}
                    : { estimatedCostUsd: item.estimatedCostUsd })
                }
              ]
            : []
        )
        const remaining = finalBoard.items
          .filter((item) => item.status === "planned" || item.status === "failed")
          .map((item) => item.id)
        yield* stage(
          context.events,
          "report",
          files
            .writeAtomic(
              join(input.workDir, "docs", "conversion", "migration-report.md"),
              migrationReport(rows, remaining)
            )
            .pipe(Effect.andThen(context.git.commitAll("convert: migration report and board")))
        )
        yield* context.events.publish(
          Info.make({
            message:
              `estate walk complete — ${rows.filter((row) => row.outcome === "done").length} ` +
              `converted, ${remaining.length} remaining; ` +
              "report: docs/conversion/migration-report.md (all figures estimated)"
          })
        )
      })
  )
})

runFlowMain(program)
