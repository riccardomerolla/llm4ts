// Audit the porting rulebook before it ports anything (ADR 0028, the Bun
// port's porting-md audit): dimension auditors read the rulebook against a
// few sample sources and propose rules; three refuters vote each finding
// down or let it stand; a trial port of the samples by the rules and again
// natively shows what the rulebook forgot. The result is a patch to
// `prompts/porting.md` behind an approval; the next run applies it.
//
//   LLM4TS_PACK=zig-rust llm4ts run port-guide --repo ~/src/bun
//
// Knobs: LLM4TS_PORT_GUIDE_SAMPLE (3 files), LLM4TS_PORT_GUIDE_TRIAL (on|off).
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ApprovedMarker } from "@llm4ts/flow/Approval"
import { makeChat } from "@llm4ts/flow/Chat"
import { cap } from "@llm4ts/flow/Context"
import { Info } from "@llm4ts/flow/FlowEvents"
import {
  GuideFinding,
  defaultAuditDimensions,
  renderGuideAudit,
  standsAfterRefutes
} from "@llm4ts/flow/Port"
import { AppliedMarkerPrefix, applyRuleEdit, retroApprovalOf } from "@llm4ts/flow/Retro"
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
import {
  asPortingPack,
  implementerPrompt,
  implementerSystem,
  nativeImplementerSystem,
  portEnv,
  portManifest,
  portStateDir
} from "./lib/port.ts"

class Findings extends Schema.Class<Findings>("Findings")({
  findings: Schema.Array(GuideFinding)
}) {}
const findingItems: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      dimension: { type: "string" },
      finding: { type: "string" },
      evidence: { type: "string" },
      proposedRule: { type: "string" }
    },
    required: ["dimension", "finding", "evidence", "proposedRule"]
  }
}
const findingsJson: JsonSchema = {
  type: "object",
  properties: { findings: findingItems },
  required: ["findings"]
}
class Refute extends Schema.Class<Refute>("Refute")({
  holds: Schema.Boolean,
  why: Schema.String
}) {}
const refuteJson: JsonSchema = {
  type: "object",
  properties: { holds: { type: "boolean" }, why: { type: "string" } },
  required: ["holds", "why"]
}
class Trial extends Schema.Class<Trial>("Trial")({
  differences: Schema.Array(Schema.String),
  findings: Schema.Array(GuideFinding)
}) {}
const trialJson: JsonSchema = {
  type: "object",
  properties: { differences: { type: "array", items: { type: "string" } }, findings: findingItems },
  required: ["differences", "findings"]
}

class AuditRecord extends Schema.Class<AuditRecord>("AuditRecord")({
  kept: Schema.Array(GuideFinding)
}) {}
const encodeAudit = Schema.encodeSync(Schema.fromJsonString(AuditRecord))
const decodeAudit = Schema.decodeUnknownOption(Schema.fromJsonString(AuditRecord))

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Audit the porting rulebook against sample sources")
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const knobs = portEnv(process.env)
  const sampleSize = Math.max(
    1,
    Number.parseInt(process.env.LLM4TS_PORT_GUIDE_SAMPLE ?? "3", 10) || 3
  )
  const trialOn = process.env.LLM4TS_PORT_GUIDE_TRIAL?.trim().toLowerCase() !== "off"
  const stateDir = portStateDir(input.workDir)
  const reportPath = join(stateDir, "guide-audit.md")
  const recordPath = join(stateDir, "guide-audit.json")

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
        const rulebookPath = `${opened.dir}/prompts/porting.md`

        // An approved, unapplied audit from an earlier run: apply it to the rulebook and stop.
        const earlier = yield* files.read(reportPath)
        if (earlier !== undefined) {
          const approval = retroApprovalOf(earlier)
          if (approval.approved && !approval.applied) {
            const recordText = yield* files.read(recordPath)
            const record = recordText === undefined ? undefined : decodeAudit(recordText)
            if (record !== undefined && record._tag === "Some") {
              let text = yield* opened.workspace
                .read(rulebookPath)
                .pipe(Effect.orElseSucceed(() => porting.rulebook))
              let applied = 0
              for (const finding of record.value.kept) {
                const next = applyRuleEdit(text, {
                  target: rulebookPath,
                  op: "append-rule",
                  line: finding.proposedRule,
                  why: finding.finding
                })
                if (next !== undefined) {
                  text = next
                  applied += 1
                }
              }
              yield* opened.workspace.write(rulebookPath, text)
              yield* files.writeAtomic(
                reportPath,
                `${earlier.trimEnd()}\n${AppliedMarkerPrefix} ${new Date().toISOString()}\n`
              )
              yield* events.publish(
                Info.make({
                  message: `port-guide: ${applied} rule(s) appended to ${join(opened.workspace.root, rulebookPath)}`
                })
              )
              return
            }
          }
        }

        const manifest = yield* stage(
          events,
          "manifest",
          portManifest(repo, files, input.workDir, porting)
        )
        const sample = manifest.slice(0, sampleSize)
        const sources: Array<string> = []
        for (const entry of sample) {
          const text = (yield* files.read(join(input.workDir, entry.source))) ?? ""
          sources.push(
            `### ${entry.source}\n\`\`\`\n${cap(text, Math.floor(knobs.sourceChars / Math.max(1, sample.length))).text}\n\`\`\``
          )
        }
        const samples = sources.join("\n\n")
        const dimensions = porting.pack.audit ?? defaultAuditDimensions

        const auditor = (dimension: string) =>
          structuredAndPublish(
            context.reasoning,
            events,
            [
              `You audit a porting rulebook along one dimension: ${dimension}.`,
              "Read the rulebook and the sample source files. Report as findings the places where the",
              "rulebook is silent, ambiguous, or wrong for what the samples actually contain: a construct",
              "the samples use that the rules do not map, a mapping that would produce wrong or",
              "non-idiomatic target code, two rules that conflict. Each finding names its evidence (a",
              "rulebook line or a sample line) and proposes one rule, one line, that would settle it.",
              "Report nothing the rulebook already covers. Return ONLY JSON matching the schema.",
              "",
              "# Rulebook",
              porting.rulebook,
              "",
              "# Sample sources",
              samples
            ].join("\n"),
            Findings,
            findingsJson,
            "auditor"
          )
        const audited = yield* stage(
          events,
          "audit",
          Effect.forEach(dimensions, auditor, { concurrency: 3 })
        )
        let proposed = audited.flatMap((result) => result.findings)

        const trial: Array<string> = []
        if (trialOn && sample.length > 0) {
          yield* stage(
            events,
            "trial port",
            Effect.forEach(
              sample,
              (entry) =>
                Effect.gen(function* () {
                  const source = (yield* files.read(join(input.workDir, entry.source))) ?? ""
                  const byRules = {
                    ...entry,
                    target: `.llm4ts/port/trial/by-rules/${entry.target}`
                  }
                  const native = { ...entry, target: `.llm4ts/port/trial/native/${entry.target}` }
                  const rulesChat = yield* makeChat(context.coder, {
                    system: implementerSystem(porting),
                    events,
                    agent: "coder",
                    stall: { repeats: 5 }
                  })
                  yield* rulesChat.ask(
                    implementerPrompt(byRules, source, porting, knobs.sourceChars)
                  )
                  const nativeChat = yield* makeChat(context.coder, {
                    system: nativeImplementerSystem(porting),
                    events,
                    agent: "coder",
                    stall: { repeats: 5 }
                  })
                  yield* nativeChat.ask(
                    `Port \`${entry.source}\` natively. Write the ported file at: ${native.target}\n\nSource file:\n\`\`\`\n${cap(source, knobs.sourceChars).text}\n\`\`\``
                  )
                  const rulesDraft =
                    (yield* files.read(join(input.workDir, byRules.target))) ?? "(no draft written)"
                  const nativeDraft =
                    (yield* files.read(join(input.workDir, native.target))) ?? "(no draft written)"
                  const compared = yield* structuredAndPublish(
                    context.reasoning,
                    events,
                    [
                      `Compare the two drafts of \`${entry.source}\`: one written by the rulebook, one natively.`,
                      "List the differences that matter (where the native port made a better or different",
                      "choice than the rules forced), and for each that the rulebook should settle, a finding",
                      "with evidence and one proposed rule. Return ONLY JSON matching the schema.",
                      "",
                      "# Rulebook",
                      porting.rulebook,
                      "",
                      "# Draft by the rules",
                      "```",
                      cap(rulesDraft, 20_000).text,
                      "```",
                      "",
                      "# Native draft",
                      "```",
                      cap(nativeDraft, 20_000).text,
                      "```"
                    ].join("\n"),
                    Trial,
                    trialJson,
                    "trial-compare"
                  )
                  trial.push(...compared.differences.map((line) => `${entry.source}: ${line}`))
                  proposed = [...proposed, ...compared.findings]
                }),
              { concurrency: 1 }
            )
          )
        }

        // Three refuters per finding; a majority rejecting drops it.
        const kept: Array<GuideFinding> = []
        const dropped: Array<GuideFinding> = []
        yield* stage(
          events,
          "refute",
          Effect.forEach(
            proposed,
            (finding) =>
              Effect.gen(function* () {
                const votes = yield* Effect.forEach(
                  [1, 2, 3],
                  (vote) =>
                    structuredAndPublish(
                      context.reasoning,
                      events,
                      [
                        `Refuter ${vote} of 3. Does this finding hold against the rulebook and the samples?`,
                        "Refute it (holds: false) if the rulebook already covers it, if the evidence does not",
                        "show what the finding claims, or if the proposed rule contradicts another rule. Return",
                        "ONLY JSON matching the schema.",
                        "",
                        `Dimension: ${finding.dimension}`,
                        `Finding: ${finding.finding}`,
                        `Evidence: ${finding.evidence}`,
                        `Proposed rule: ${finding.proposedRule}`,
                        "",
                        "# Rulebook",
                        porting.rulebook,
                        "",
                        "# Sample sources",
                        samples
                      ].join("\n"),
                      Refute,
                      refuteJson,
                      "refuter"
                    ),
                  { concurrency: 3 }
                )
                if (standsAfterRefutes(votes.map((vote) => vote.holds))) kept.push(finding)
                else dropped.push(finding)
              }),
            { concurrency: 2 }
          )
        )

        yield* files.writeAtomic(
          reportPath,
          renderGuideAudit({
            pack: porting.pack.name,
            kept,
            dropped,
            trial,
            sample: sample.map((entry) => entry.source)
          })
        )
        yield* files.writeAtomic(recordPath, `${encodeAudit(AuditRecord.make({ kept }))}\n`)
        yield* events.publish(
          Info.make({
            message: `port-guide: ${kept.length} finding(s) kept, ${dropped.length} dropped — read ${reportPath}, tick \`${ApprovedMarker}\`, run again to append the rules to ${rulebookPath}`
          })
        )
      })
  )
})

runFlowMain(program)
