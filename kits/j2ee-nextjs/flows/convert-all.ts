// Convert the whole legacy estate: walk the survey inventory in wave order, one branch per page, progress board, estimated-cost migration report.
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
import { Info } from "@llm4ts/flow/FlowEvents"
import { stage } from "@llm4ts/flow/PlanExecution"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import {
  conversionInventory,
  convertPage,
  migrationReport,
  setupConversion,
  type MigrationRow
} from "./lib/convert.ts"

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

        const inventory = yield* stage(
          context.events,
          "inventory",
          conversionInventory(files, deps.legacy, deps.legacyDir, deps.pack)
        )
        if (inventory.length === 0) {
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
            inventory.map(({ page, wave }) =>
              BoardItem.make({
                id: page,
                title: page,
                status: "planned",
                ...(wave === undefined ? {} : { wave })
              })
            )
          )
        )

        const baseBranch = yield* context.git.currentBranch
        const failFast = process.env.LLM4TS_FAIL_FAST === "1"

        for (const { page } of inventory) {
          const snapshot = yield* board.snapshot
          const known = snapshot.items.find((item) => item.id === page)
          if (known !== undefined && known.status !== "planned" && known.status !== "failed") {
            yield* context.events.publish(
              Info.make({ message: `resume: ${page} is already ${known.status} — skipping` })
            )
            continue
          }
          const specPath = join(deps.legacyDir, deps.pack.specsDir, `${page}.md`)
          if ((yield* files.read(specPath)) === undefined) {
            yield* board.skip(page, "no extracted spec")
            continue
          }
          const checkpoint = yield* context.git.checkpoint
          yield* board.start(page)
          const result = yield* Effect.result(convertPage(deps, page))
          if (result._tag === "Success") {
            const outcome = result.success
            yield* board.complete(page, {
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
            // A stuck page must not sink the walk: reset the working tree,
            // mark the failure, keep going (LLM4TS_FAIL_FAST=1 to stop).
            yield* context.git.rollback(checkpoint)
            yield* context.git.checkout(baseBranch)
            yield* board.fail(page, reason)
            if (failFast) {
              return yield* Effect.fromResult(result)
            }
            yield* context.events.publish(
              Info.make({ message: `page ${page} failed — continuing: ${reason}` })
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
