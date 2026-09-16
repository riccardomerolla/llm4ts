// Continue a modernization an OLDER llm4ts extracted: check its spec pack against the current pack rules and spec schema, re-index it, and mark what must be re-extracted (no LLM).
//
// Runs rooted at the LEGACY repository (`--repo <legacy>`) holding a
// docs/modernization/ pack written by any earlier release (the README of a
// pack older than 2.2.0 carries no `Written by llm4ts` stamp). Deterministic:
//
//   1. Every program with a spec is checked for its four artifacts, the
//      feature file's Gherkin shape, and — when the pack declares
//      `spec-schema:` — a decodable pagespec block under the CURRENT schema
//      (2.0.0 made `esbService` identifier-only, which fails older blocks).
//   2. traceability.md, mapping.md, and rules.txt are regenerated from the
//      fragments under the current pack's coverage rules; units the current
//      rules capture that no fragment covers are reported (the closing
//      modernize-extract run, or a deepen, closes them).
//   3. The README is rewritten with the current version stamp and an
//      upgrade note, its approval reset: a pack another release touched is
//      re-approved by a human before seed.
//   4. With LLM4TS_MARK_DEEPEN=1 every incompatible program gets a `## Deepen`
//      mark in decisions.md ("regenerate the artifacts under the current
//      schema …"), so `modernize-refine` re-extracts exactly those with the
//      current prompts and judge, one commit each. Without it the marks are
//      printed for a human to paste.
//
// Exit 0 whether or not findings exist — the findings ARE the result; the
// commit records them. Pack: LLM4TS_PACK as for modernize-extract.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { ProgramUnit, programArtifactPaths } from "@llm4ts/flow/Artifacts"
import { withDraftApproval } from "@llm4ts/flow/Approval"
import {
  DeepenMark,
  Decisions,
  parseDecisions,
  renderDecisions,
  scenarioTitles,
  waivedUnits
} from "@llm4ts/flow/Decisions"
import { packageVersion } from "@llm4ts/flow/Package"
import {
  coverageReport,
  coverageUnits,
  features,
  matchingFiles,
  specSchemaIssues
} from "@llm4ts/flow/SpecChecks"
import { legacySourceWorkspaceLimits, workspaceLimitsFromEnv } from "@llm4ts/flow/Workspace"
import {
  FlowAborted,
  Info,
  makeNodeWorkspace,
  mock,
  nodePlainFileStore,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage
} from "@llm4ts/runner"
import { ModDir, programName, readmeFor, readmeVersion } from "./lib/modernize-extract.ts"

interface Finding {
  readonly program: string
  readonly problem: string
  /** Whether a deepen re-extraction fixes it (an estate-wide gap does not). */
  readonly deepen: boolean
}

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "Check a spec pack an older llm4ts extracted against the current release"
  )
  const files = nodePlainFileStore
  const modDirAbs = join(input.workDir, ModDir)
  const markDeepen = process.env.LLM4TS_MARK_DEEPEN?.trim() === "1"

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      // No model call: the mock seat satisfies the one context shape the
      // runner composes for every flow.
      coder: mock,
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const say = (message: string) => context.events.publish(Info.make({ message }))
        const repo = yield* makeNodeWorkspace(
          input.workDir,
          workspaceLimitsFromEnv(process.env, legacySourceWorkspaceLimits)
        )
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

        const readme = yield* files.read(join(modDirAbs, "README.md"))
        if (readme === undefined) {
          return yield* FlowAborted.make({
            message: `no spec pack under ${ModDir} — nothing to upgrade`
          })
        }
        const previous = readmeVersion(readme) ?? "an llm4ts older than 2.2.0 (no version stamp)"
        yield* say(`spec pack written by ${previous}; checking it as llm4ts ${packageVersion}`)

        const specPaths = yield* repo
          .discover(`${ModDir}/specs/*.md`)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const names = [...specPaths]
          .map((path) => path.split("/").at(-1) ?? path)
          .filter((file) => file.endsWith(".md") && file !== "README.md")
          .map((file) => file.slice(0, -".md".length))
          .sort()
        if (names.length === 0) {
          return yield* FlowAborted.make({ message: `no specs under ${ModDir}/specs` })
        }
        const sources = yield* matchingFiles(
          repo,
          pack.programs ?? pack.sources ?? ".*",
          pack.exclude
        )
        const sourceOf = new Map(sources.map((path) => [programName(path), path]))
        const units = names.map((name) =>
          ProgramUnit.make({ name, sourcePath: sourceOf.get(name) ?? "" })
        )

        // ---- 1. Per-program artifacts under the current rules ----------------------
        const findings: Array<Finding> = []
        const fragments = new Map<string, string>()
        const scenarios = new Map<string, ReadonlySet<string>>()
        yield* stage(
          context.events,
          "check",
          Effect.gen(function* () {
            const specs: Array<{ readonly name: string; readonly markdown: string | undefined }> =
              []
            for (const unit of units) {
              const [specPath, featurePath, tracePath, mappingPath] = programArtifactPaths(
                unit,
                modDirAbs
              )
              const spec = yield* files.read(specPath)
              specs.push({ name: unit.name, markdown: spec })
              if (unit.sourcePath.length === 0) {
                findings.push({
                  program: unit.name,
                  problem: "no legacy source matches the current pack's programs regex",
                  deepen: false
                })
              }
              const feature = yield* files.read(featurePath)
              if (feature === undefined) {
                findings.push({ program: unit.name, problem: "feature file missing", deepen: true })
              } else {
                scenarios.set(unit.name, new Set(scenarioTitles(feature)))
              }
              const trace = yield* files.read(tracePath)
              if (trace === undefined || trace.trim().length === 0) {
                findings.push({
                  program: unit.name,
                  problem: "traceability fragment missing",
                  deepen: true
                })
              } else {
                fragments.set(unit.name, trace)
              }
              if ((yield* files.read(mappingPath)) === undefined) {
                findings.push({
                  program: unit.name,
                  problem: "mapping fragment missing",
                  deepen: true
                })
              }
            }
            for (const issue of yield* specSchemaIssues(pack.specSchema, specs)) {
              const name = /^judge\[([^\]]+)\]/.exec(issue.title)?.[1] ?? "?"
              findings.push({
                program: name,
                problem: `pagespec block does not decode under the current schema: ${issue.description.split(". ")[0] ?? ""}`,
                deepen: true
              })
            }
            const wellFormed = yield* features(repo, join(ModDir, "features"))
            for (const issue of wellFormed.issues) {
              const stem = (issue.file?.split("/").at(-1) ?? "").replace(/\.feature$/, "")
              const name = names.find((candidate) => candidate.toLowerCase() === stem) ?? stem
              findings.push({ program: name, problem: issue.description, deepen: true })
            }
          })
        )

        // ---- 2. Indexes and rules.txt under the current pack --------------------------
        let uncovered: ReadonlyArray<string> = []
        yield* stage(
          context.events,
          "reindex",
          Effect.gen(function* () {
            for (const [fragmentDir, index] of [
              ["traceability", "traceability.md"],
              ["mapping", "mapping.md"]
            ] as const) {
              const parts: Array<string> = []
              for (const unit of units) {
                const text = yield* files.read(join(modDirAbs, fragmentDir, `${unit.name}.md`))
                if (text !== undefined && text.trim().length > 0) {
                  parts.push(`===== ${unit.name} =====\n${text.trimEnd()}`)
                }
              }
              if (parts.length > 0) {
                yield* files.writeAtomic(join(modDirAbs, index), parts.join("\n\n") + "\n")
              }
            }
            const decisionsText = yield* files.read(join(modDirAbs, "decisions.md"))
            const decisions =
              decisionsText === undefined
                ? Decisions.empty()
                : yield* parseDecisions(decisionsText, `${ModDir}/decisions.md`)
            const unitsByRule = yield* coverageUnits(repo, pack.coverage)
            const allUnits = [...new Set(Object.values(unitsByRule).flat())].sort()
            const waived = waivedUnits(decisions, { fragments, scenarios })
            if (allUnits.length > 0) {
              yield* files.writeAtomic(
                join(modDirAbs, "rules.txt"),
                [
                  ...allUnits,
                  ...(waived.length === 0
                    ? []
                    : [
                        "# waived",
                        ...waived.map((entry) => `${entry.unit} — waived by ${entry.by}`)
                      ])
                ].join("\n") + "\n"
              )
            }
            const trace = (yield* files.read(join(modDirAbs, "traceability.md"))) ?? ""
            const report = yield* coverageReport(repo, pack.coverage, trace, {
              waived: new Set(waived.map((entry) => entry.unit))
            })
            uncovered = report.result.issues.map((issue) => issue.title)
          })
        )

        // ---- 3. README stamp, 4. deepen marks -------------------------------------------
        const toDeepen = [...new Set(findings.filter((f) => f.deepen).map((f) => f.program))]
        const markLines = toDeepen.map(
          (name) =>
            `- ${name}: regenerate the artifacts under the current llm4ts ${packageVersion} schema and prompts — ` +
            findings
              .filter((f) => f.program === name && f.deepen)
              .map((f) => f.problem)
              .join("; ")
        )
        if (markDeepen && toDeepen.length > 0) {
          yield* stage(
            context.events,
            "mark",
            Effect.gen(function* () {
              const text = yield* files.read(join(modDirAbs, "decisions.md"))
              const decisions =
                text === undefined
                  ? Decisions.empty()
                  : yield* parseDecisions(text, `${ModDir}/decisions.md`)
              const already = new Set(decisions.pendingDeepen.map((mark) => mark.program))
              const added = toDeepen
                .filter((name) => !already.has(name))
                .map((name) =>
                  DeepenMark.make({
                    program: name,
                    focus:
                      markLines
                        .find((line) => line.startsWith(`- ${name}: `))
                        ?.slice(name.length + 4) ?? ""
                  })
                )
              yield* files.writeAtomic(
                join(modDirAbs, "decisions.md"),
                renderDecisions(
                  Decisions.make({
                    ...decisions,
                    deepen: [...decisions.deepen, ...added],
                    approved: false
                  })
                )
              )
              yield* say(`${added.length} deepen mark(s) written to ${ModDir}/decisions.md`)
            })
          )
        }
        const verdict =
          /Gate verdict: (.+?)\.\n/.exec(readme)?.[1] ?? "UNKNOWN — extracted by an older release"
        const priorNotes = (/Refined after the gate passed:\n((?:- .*\n)+)/.exec(readme)?.[1] ?? "")
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2))
        const note =
          `upgraded from ${previous} to llm4ts ${packageVersion}: ${findings.length} finding(s), ` +
          `${uncovered.length} uncovered unit(s) under the current rules` +
          (markDeepen && toDeepen.length > 0
            ? `, ${toDeepen.length} program(s) marked for deepen`
            : "")
        yield* files.writeAtomic(
          join(modDirAbs, "README.md"),
          withDraftApproval(readmeFor(pack, verdict, [...priorNotes, note]))
        )
        yield* stage(
          context.events,
          "commit",
          context.git
            .commitAll(`modernize(${pack.name}): pack upgrade check as llm4ts ${packageVersion}`)
            .pipe(Effect.asVoid)
        )

        // ---- Report -------------------------------------------------------------------
        for (const finding of findings) {
          yield* say(`finding: ${finding.program} — ${finding.problem}`)
        }
        for (const title of uncovered.slice(0, 20)) {
          yield* say(`uncovered under the current rules: ${title}`)
        }
        if (uncovered.length > 20) {
          yield* say(`… and ${uncovered.length - 20} more uncovered unit(s)`)
        }
        if (toDeepen.length > 0 && !markDeepen) {
          yield* say(
            `${toDeepen.length} program(s) need re-extraction — rerun with LLM4TS_MARK_DEEPEN=1, or add under '## Deepen' in ${ModDir}/decisions.md:\n` +
              markLines.join("\n")
          )
        }
        yield* say(
          findings.length === 0 && uncovered.length === 0
            ? `pack is compatible with llm4ts ${packageVersion} — review ${ModDir}/README.md, flip '- [x] Approved', then continue with modernize-refine or modernize-seed`
            : `upgrade check done — ${findings.length} finding(s); ` +
                (markDeepen && toDeepen.length > 0
                  ? "run modernize-refine to re-extract the marked programs"
                  : "mark the programs to re-extract, then run modernize-refine")
        )
      })
  )
})

runFlowMain(program)
