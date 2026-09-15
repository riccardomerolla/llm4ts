// Convert ONE domain feature of the approved domains.md into the destination Next.js SPA: one branch, one merged contract, the port then each page in navigation order.
//
// Runs rooted at the TARGET repository (`--repo <nextjs>`), with
// LLM4TS_LEGACY_REPO pointing at the refined legacy repository whose
// docs/modernization/domains.md is approved. The task text is the feature id:
//
//   LLM4TS_LEGACY_REPO=~/estates/demo-bank-legacy \
//     llm4ts run convert-feature --repo ~/estates/demo-bank-nextjs beneficiary-maintenance
//
// ADR 0012 addendum: the unit of delivery is the domain feature — its
// surviving pages share `contracts/<feature>.openapi.yaml` (the deterministic
// union of their API sections; conflicts are open points in domains.md, never
// silent merges), one port under src/services/<feature>/, page components
// and tests per page. Gates and judge as convert-page, plus the feature
// judged against its contract of record. Branch `convert/<feature>`, no PR.
import * as Effect from "effect/Effect"
import {
  FlowAborted,
  Info,
  asReadOnly,
  coderFromEnv,
  resolveFlowInput,
  runFlowMain,
  runNode
} from "@llm4ts/runner"
import { convertFeature, setupConversion } from "./lib/convert.ts"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Convert one domain feature into the destination SPA")
  const feature = input.prompt.trim().split(/\s+/)[0] ?? ""
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
        if (feature.length === 0) {
          return yield* FlowAborted.make({
            message:
              "pass the domain feature id to convert, e.g.: llm4ts run convert-feature beneficiary-maintenance"
          })
        }
        const deps = yield* setupConversion(context, input, process.env, import.meta.dirname)
        const outcome = yield* convertFeature(deps, feature)
        yield* context.events.publish(
          Info.make({
            message:
              `converted feature ${outcome.page} on branch ${outcome.branch} — ` +
              `report at ${outcome.reportPath}` +
              (outcome.estimatedTokens === undefined
                ? ""
                : ` (~${outcome.estimatedTokens} tokens, ESTIMATED)`)
          })
        )
      })
  )
})

runFlowMain(program)
