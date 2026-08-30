// Convert ONE legacy J2EE page into the destination Next.js SPA: branch per page, contract-first mocked ACL, judged gates, estimated costs.
//
// Runs rooted at the TARGET repository (`--repo <nextjs>`), with
// LLM4TS_LEGACY_REPO pointing at the extracted legacy repository. The task
// text is the page name (the program name of its extracted spec):
//
//   LLM4TS_LEGACY_REPO=~/estates/demo-bank-legacy \
//     llm4ts run convert-page --repo ~/estates/demo-bank-nextjs accountOverview
//
// Not clean-room (ADR 0012): the coder gets the schema-validated Page Spec as
// contract plus bounded legacy source evidence, the destination's own pages as
// style guide, and a deterministically generated OpenAPI anti-corruption
// contract. Gates: typecheck+lint+test per task, test+build to finish, then a
// per-page spec-compliance judge with bounded feedback rounds
// (LLM4TS_JUDGE_ROUNDS). One branch `convert/<page>` per run, no PR — the
// branch awaits human review; the conversion report is committed with it.
// Token/cost figures are ESTIMATES (LLM4TS_ESTIMATE_MODEL,
// LLM4TS_ESTIMATE_CHARS_PER_TOKEN). Pack: LLM4TS_PACK (default
// packs/j2ee-nextjs-spa).
import * as Effect from "effect/Effect"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { convertPage, setupConversion } from "./lib/convert.ts"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Convert one legacy page into the destination SPA")
  const page = input.prompt.trim().split(/\s+/)[0] ?? ""
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
        if (page.length === 0) {
          return yield* FlowAborted.make({
            message: "pass the page name to convert, e.g.: llm4ts run convert-page accountOverview"
          })
        }
        const deps = yield* setupConversion(context, input, process.env, import.meta.dirname)
        const outcome = yield* convertPage(deps, page)
        yield* context.events.publish(
          Info.make({
            message:
              `converted ${outcome.page} on branch ${outcome.branch} — ` +
              `report at ${outcome.reportPath}` +
              (outcome.estimatedTokens === undefined
                ? ""
                : ` (~${outcome.estimatedTokens} tokens estimated)`)
          })
        )
      })
  )
})

runFlowMain(program)
