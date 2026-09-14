// Legacy modernization phase -1: load a pack and match its rules against an estate; no LLM.
//
// The pack equivalent of the mock provider: a deterministic first success
// before any paid phase. The pack is loaded exactly as survey and extract load
// it, then the flow reports what it found and how each rule matches the
// estate at `--repo`:
//
//   1. manifest — name, source, scaffold, specs/features dirs, gates, replay,
//      equivalence policy, judge dimensions, prompt and reviewer sidecars.
//   2. estate — the files `sources:` selects (minus `exclude:`), the files
//      `programs:` selects, and for every `## Coverage:` and `## Survey:` rule
//      the units it captures, with a sample of each so a regex typo is
//      visible at a glance.
//   3. verdict — hard failures (the pack does not load, `sources:` or
//      `programs:` match nothing) abort with exit code 1; likely mistakes (a
//      rule capturing no unit, a missing phase prompt, a scaffold path that
//      does not exist, no reviewer lens, no judge dimension) are listed as
//      warnings and the flow exits 0.
//
// Run: LLM4TS_PACK=packs/my-pack modernize-pack-check --repo ~/estates/legacy
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import {
  FlowAborted,
  Info,
  makeNodeWorkspace,
  mock,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { coverageUnits, matchingFiles } from "@llm4ts/flow/SpecChecks"
import type { CoverageRule } from "@llm4ts/flow/SpecChecks"
import { legacySourceWorkspaceLimits, workspaceLimitsFromEnv } from "@llm4ts/flow/Workspace"

/** Prompt sidecars the modernization phases read, with the phase that reads each. */
const phasePrompts: ReadonlyArray<readonly [name: string, phase: string]> = [
  ["analysis", "extract"],
  ["spec", "extract"],
  ["bdd", "extract"],
  ["plan", "extract"],
  ["implement", "implement"],
  ["review", "review"],
  ["vectors", "verify"]
]

const sampleSize = 5

const sample = (units: ReadonlyArray<string>): string =>
  units.length === 0
    ? "(none)"
    : units.slice(0, sampleSize).join(", ") +
      (units.length > sampleSize ? ` … +${units.length - sampleSize} more` : "")

const plural = (count: number, noun: string, many = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : many}`

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Check the pack against the estate")

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      // This phase makes no model call; the mock seat satisfies the one
      // context shape the runner composes for every flow.
      coder: mock,
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))
        const warnings: Array<string> = []
        const failures: Array<string> = []

        const opened = yield* stage(
          context.events,
          "pack",
          openPack({
            environment: process.env,
            launchDir: input.workspace,
            flowDir: import.meta.dirname
          })
        )
        const pack = opened.pack
        const packRoot = join(opened.workspace.root, opened.dir)

        yield* stage(
          context.events,
          "manifest",
          Effect.gen(function* () {
            yield* say(`pack '${pack.name}' (source: ${pack.source}) at ${packRoot}`)
            yield* say(`specs-dir: ${pack.specsDir} · features-dir: ${pack.featuresDir}`)
            if (pack.scaffold === undefined) {
              yield* say("scaffold: (none — seed needs a non-empty target)")
            } else {
              const scaffoldRoot = join(packRoot, pack.scaffold)
              yield* say(`scaffold: ${pack.scaffold}`)
              if (!existsSync(scaffoldRoot)) {
                warnings.push(`scaffold '${pack.scaffold}' does not exist at ${scaffoldRoot}`)
              }
            }
            const gates = Object.entries(pack.gates)
            yield* say(
              gates.length === 0
                ? "gates: (none)"
                : `gates: ${gates.map(([name, command]) => `${name} → ${command.join(" ")}`).join(" · ")}`
            )
            if (gates.length === 0) {
              warnings.push("## Gates is empty — implement and verify have nothing to enforce")
            }
            yield* say(
              pack.replay === undefined
                ? "replay: (none — verify cannot run equivalence vectors)"
                : `replay: ${pack.replay.join(" ")} (${pack.equivalence.ordering.toLowerCase()} comparison)`
            )
            yield* say(
              `judge: ${plural(pack.judgeDimensions.length, "dimension")}` +
                (pack.judgeDimensions.length === 0
                  ? ""
                  : ` — ${pack.judgeDimensions.map((d) => `${d.name} (0..${d.maxScore})`).join(", ")}`)
            )
            if (pack.judgeDimensions.length === 0) {
              warnings.push("## Judge has no dimensions — extract's gate cannot score a spec")
            }
            const present = phasePrompts.filter(([name]) => pack.prompt(name) !== undefined)
            const missing = phasePrompts.filter(([name]) => pack.prompt(name) === undefined)
            yield* say(
              `prompts: ${present.length}/${phasePrompts.length} phase sidecars` +
                (present.length === 0 ? "" : ` — ${present.map(([name]) => name).join(", ")}`)
            )
            for (const [name, phase] of missing) {
              warnings.push(`prompts/${name}.md not found (read by ${phase})`)
            }
            yield* say(
              `reviewers: ${plural(pack.lenses.length, "lens", "lenses")}` +
                (pack.lenses.length === 0 ? "" : ` — ${pack.lenses.map((l) => l.name).join(", ")}`)
            )
            if (pack.lenses.length === 0) {
              warnings.push("no reviewers/*.md sidecar — review runs without pack lenses")
            }
            yield* say(`lessons: ${pack.lessons === undefined ? "(none yet)" : "present"}`)
          })
        )

        yield* stage(
          context.events,
          "estate",
          Effect.gen(function* () {
            const repo = yield* makeNodeWorkspace(
              input.workDir,
              workspaceLimitsFromEnv(process.env, legacySourceWorkspaceLimits)
            )
            const sourcesRegex = pack.sources ?? ".*"
            const sources = yield* matchingFiles(repo, sourcesRegex, pack.exclude)
            yield* say(
              `sources: ${plural(sources.length, "file")} match '${sourcesRegex}'` +
                (pack.exclude === undefined ? "" : ` minus '${pack.exclude}'`) +
                ` — ${sample(sources)}`
            )
            if (sources.length === 0) {
              failures.push(`sources '${sourcesRegex}' matched no file under ${input.workDir}`)
            }
            if (pack.programs === undefined) {
              yield* say("programs: (not set — every source file is a program)")
            } else {
              const programs = yield* matchingFiles(repo, pack.programs, pack.exclude)
              yield* say(
                `programs: ${plural(programs.length, "file")} match '${pack.programs}' — ${sample(programs)}`
              )
              if (programs.length === 0) {
                failures.push(`programs '${pack.programs}' matched no file under ${input.workDir}`)
              }
            }
            const report = Effect.fn("modernize-pack-check.rules")(function* (
              kind: string,
              rules: ReadonlyArray<CoverageRule>
            ) {
              if (rules.length === 0) {
                yield* say(`${kind}: (no rules)`)
                return
              }
              const units = yield* coverageUnits(repo, rules)
              for (const rule of rules) {
                const found = units[rule.name] ?? []
                yield* say(
                  `${kind} '${rule.name}': ${plural(found.length, "unit")} — ${sample(found)}`
                )
                if (found.length === 0) {
                  warnings.push(
                    `${kind} rule '${rule.name}' captured no unit: files '${rule.files}', unit '${rule.unit}'`
                  )
                }
              }
            })
            yield* report("coverage", pack.coverage)
            yield* report("survey", pack.survey)
          })
        )

        yield* stage(
          context.events,
          "verdict",
          Effect.gen(function* () {
            for (const warning of warnings) {
              yield* say(`warning: ${warning}`)
            }
            if (failures.length > 0) {
              return yield* FlowAborted.make({
                message: `pack '${pack.name}' failed the check: ${failures.join("; ")}`
              })
            }
            yield* say(
              `pack '${pack.name}' check passed with ${plural(warnings.length, "warning")} — ` +
                `next: LLM4TS_PACK=${process.env.LLM4TS_PACK ?? opened.dir} modernize-survey --repo ${input.workDir}`
            )
          })
        )
      })
  )
})

runFlowMain(program)
