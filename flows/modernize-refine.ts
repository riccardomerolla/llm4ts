// Legacy modernization phase 1.5 (optional): refine the extracted spec pack — prune, deepen, consolidate — before it is approved and seeded (ADR 0015).
//
// Runs rooted at the LEGACY repository (`--repo <legacy>`), after
// modernize-extract wrote its pack and before a human flips the README's
// approval. The FILE is the state, never the conversation: everything this
// flow does is driven by two overlays under docs/modernization/ that a
// human edits (or the `llm4ts refine` shell verb writes for them):
//
//   decisions.md — what the pack should become: `drop`, `provided`, `defer`,
//                  `wrap` per program or scenario; `?` marks asking the
//                  model to propose; `## Deepen` marks sending the analyst
//                  back to the source with a focus; `## Open points` the
//                  questions a proposal could not settle.
//   domains.md   — the domain features: pages grouped by the pack's
//                  `## Consolidate` edge rules, named by the model, every
//                  surviving scenario assigned exactly once.
//
// One run, in order: validate the overlays → execute pending deepen marks
// (re-extract one program with its focus, judge, one fix turn, own commit)
// → propose dispositions for the `?` marks (an agent session on the
// read-only target at LLM4TS_TARGET_REPO; without it `provided` is never
// proposed) → consolidate when domains.md is absent or stale (LLM4TS_REGROUP=1
// forces it) → regenerate plan.md per domain feature → rewrite rules.txt with
// its `# waived` section → reset the README approval → commit. It halts with
// a typed OpenPointsPending when either overlay has unanswered questions;
// answer them in the file and rerun. Nothing marked and a fresh map is a
// no-op. Budgets: LLM4TS_ANALYST_TURNS, LLM4TS_MAX_CLOSURE_FILES,
// LLM4TS_CONTEXT_BUDGET. Pack: LLM4TS_PACK as for modernize-extract.
import { existsSync } from "node:fs"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import {
  ProgramArtifacts,
  ProgramUnit,
  extractProgramsResumably,
  programArtifactPaths
} from "@llm4ts/flow/Artifacts"
import { budget, capped } from "@llm4ts/flow/Context"
import {
  Decisions,
  DecisionsInvalid,
  DecisionsProposal,
  OpenPointsPending,
  applyProposal,
  decisionsProposalJsonSchema,
  parseDecisions,
  proposePrompt,
  renderDecisions,
  scenarioTitles,
  validateDecisions,
  waivedUnits,
  type KnownPack
} from "@llm4ts/flow/Decisions"
import {
  DomainProposal,
  Domains,
  checkExactlyOnce,
  clusterPrograms,
  consolidatePrompt,
  domainProposalJsonSchema,
  domainsFromProposal,
  domainsInputsHash,
  parseDomains,
  renderDomains
} from "@llm4ts/flow/Domains"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { FlowEvents } from "@llm4ts/flow/FlowEvents"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { Task } from "@llm4ts/flow/Plan"
import { coverageUnits, matchingFiles } from "@llm4ts/flow/SpecChecks"
import { SurveyGraph, closureFor, surveyGraph } from "@llm4ts/flow/Survey"
import { withDraftApproval } from "@llm4ts/flow/Approval"
import { legacySourceWorkspaceLimits, workspaceLimitsFromEnv } from "@llm4ts/flow/Workspace"
import {
  FlowAborted,
  Info,
  Plan,
  asReadOnly,
  coderFromEnv,
  defaultPlanInstructions,
  makeNodeWorkspace,
  nodePlainFileStore,
  openPack,
  planFrom,
  resolveFlowInput,
  runFlowMain,
  runNode,
  stage,
  withTurnLimit
} from "@llm4ts/runner"
import {
  ModDir,
  analystSystem,
  analystTurns,
  fixTurn,
  makeProgramJudge,
  maxClosureFiles,
  programArtifactsJsonSchema,
  programAsk,
  programFixAsk,
  programName,
  readmeFor
} from "./lib/modernize-extract.ts"

const today = (): string => new Date().toISOString().slice(0, 10)

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "Refine the extracted spec pack: prune, deepen, and consolidate it before approval"
  )
  const coder = withTurnLimit(coderFromEnv(process.env), analystTurns())
  const files = nodePlainFileStore
  const modDirAbs = join(input.workDir, ModDir)
  const targetRepo = process.env.LLM4TS_TARGET_REPO?.trim()
  const regroup = process.env.LLM4TS_REGROUP?.trim() === "1"

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
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
        const say = (message: string) => context.events.publish(Info.make({ message }))
        const notes: Array<string> = []

        // ---- The pack on disk: its programs, sources, and scenario titles ----
        const specPaths = yield* repo
          .discover(`${ModDir}/specs/*.md`)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
        const names = [...specPaths]
          .map((path) => path.split("/").at(-1) ?? path)
          .filter((file) => file.endsWith(".md") && file !== "README.md")
          .map((file) => file.slice(0, -".md".length))
          .sort()
        if (names.length === 0) {
          return yield* FlowAborted.make({
            message: `no spec pack under ${ModDir}/specs — run modernize-extract first`
          })
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
        const readPack = Effect.gen(function* () {
          const specs: Record<string, string> = {}
          const features: Record<string, string> = {}
          const scenarios = new Map<string, ReadonlySet<string>>()
          for (const name of names) {
            specs[name] = (yield* files.read(join(modDirAbs, "specs", `${name}.md`))) ?? ""
            const feature =
              (yield* files.read(join(modDirAbs, "features", `${name.toLowerCase()}.feature`))) ??
              ""
            features[name] = feature
            scenarios.set(name, new Set(scenarioTitles(feature)))
          }
          const known: KnownPack = { programs: new Set(names), scenarios }
          return { specs, features, scenarios, known }
        })
        let packState = yield* readPack

        // ---- decisions.md ------------------------------------------------------
        const decisionsPath = join(modDirAbs, "decisions.md")
        const decisionsText = yield* files.read(decisionsPath)
        let decisions =
          decisionsText === undefined
            ? Decisions.empty()
            : yield* parseDecisions(decisionsText, `${ModDir}/decisions.md`)
        const violations = validateDecisions(decisions, packState.known)
        if (violations.length > 0) {
          return yield* DecisionsInvalid.make({ path: `${ModDir}/decisions.md`, violations })
        }
        const writeDecisions = Effect.gen(function* () {
          yield* files.writeAtomic(decisionsPath, renderDecisions(decisions))
        })

        const graph = yield* stage(
          context.events,
          "graph",
          pack.survey.length === 0
            ? Effect.succeed(SurveyGraph.make({ nodes: [], edges: [] }))
            : surveyGraph(repo, pack.sources ?? ".*", pack.coverage, pack.survey, {
                ...(pack.exclude === undefined ? {} : { exclude: pack.exclude })
              })
        )
        const system = analystSystem(pack)
        const limit = budget()
        const judgeProgram = makeProgramJudge({
          context,
          files,
          pack,
          modDirAbs,
          workDir: input.workDir,
          limit
        })

        // ---- Deepen: re-extract one program with its focus ----------------------
        const pending = decisions.pendingDeepen
        if (pending.length > 0) {
          yield* stage(
            context.events,
            "deepen",
            Effect.gen(function* () {
              for (const mark of pending) {
                const unit = units.find((candidate) => candidate.name === mark.program)
                if (unit === undefined || unit.sourcePath.length === 0) {
                  return yield* FlowAborted.make({
                    message: `deepen: no legacy source found for program '${mark.program}'`
                  })
                }
                const [specPath, featurePath, tracePath, mappingPath] = programArtifactPaths(
                  unit,
                  modDirAbs
                )
                const previous = ProgramArtifacts.make({
                  spec: (yield* files.read(specPath)) ?? "",
                  feature: (yield* files.read(featurePath)) ?? "",
                  traceability: (yield* files.read(tracePath)) ?? "",
                  mapping: (yield* files.read(mappingPath)) ?? ""
                })
                yield* say(`deepening ${unit.name} — ${mark.focus}`)
                // Removing the spec is what makes the resumable seam re-extract it.
                yield* files.remove(specPath)
                yield* extractProgramsResumably(
                  files,
                  [unit],
                  (target) =>
                    structuredAndPublish(
                      context.coder,
                      context.events,
                      `${system}\n\n${programAsk(
                        pack,
                        target.sourcePath,
                        closureFor(graph, target.name, maxClosureFiles()),
                        { previous, focus: mark.focus }
                      )}`,
                      ProgramArtifacts,
                      programArtifactsJsonSchema,
                      "coder"
                    ),
                  modDirAbs,
                  {
                    onCreated: (created) =>
                      context.git
                        .commitPaths(
                          `modernize(${pack.name}): deepen ${created.name}`,
                          programArtifactPaths(created, ModDir)
                        )
                        .pipe(Effect.asVoid)
                  }
                )
                const focusRubric =
                  `deepen-focus (0..2): The revision addresses this focus explicitly and grounds it in ` +
                  `the source: ${mark.focus}. Score 2 only if the focus is fully answered.`
                let verdict = yield* judgeProgram(unit, focusRubric)
                if (verdict.issues.length > 0) {
                  yield* say(`fixing ${unit.name} — ${verdict.issues.length} finding(s)`)
                  yield* fixTurn(
                    context,
                    system,
                    programFixAsk(unit.name, unit.sourcePath, verdict.issues),
                    `modernize(${pack.name}): deepen fixes ${unit.name}`
                  )
                  verdict = yield* judgeProgram(unit, focusRubric)
                  if (verdict.issues.length > 0) {
                    yield* say(
                      `${unit.name} still has ${verdict.issues.length} finding(s) after its fix turn — recorded as open points`
                    )
                  }
                }
                const hash = (yield* context.git.checkpoint).slice(0, 7)
                decisions = Decisions.make({
                  ...decisions,
                  deepen: decisions.deepen.map((entry) =>
                    entry === mark ? { ...entry, done: hash } : entry
                  ),
                  openPoints: [
                    ...decisions.openPoints,
                    ...verdict.issues.map((issue, index) => ({
                      number: decisions.openPoints.length + index + 1,
                      question: `After deepening ${unit.name}: ${issue.title} — ${issue.description}`
                    }))
                  ]
                })
                yield* writeDecisions
                notes.push(`deepened ${unit.name} (${hash}): ${mark.focus}`)
              }
              // Titles may have moved: a reference that dangles is a question, not a crash.
              packState = yield* readPack
              const dangling = validateDecisions(decisions, packState.known)
              if (dangling.length > 0) {
                decisions = Decisions.make({
                  ...decisions,
                  openPoints: [
                    ...decisions.openPoints,
                    ...dangling.map((violation, index) => ({
                      number: decisions.openPoints.length + index + 1,
                      question: `After deepening: ${violation} — remap the entry or delete it`
                    }))
                  ]
                })
                yield* writeDecisions
              }
            })
          )
        }

        // ---- Propose: resolve the `?` marks ---------------------------------------
        if (decisions.marks.length > 0) {
          yield* stage(
            context.events,
            "propose",
            Effect.gen(function* () {
              const marked = [...new Set(decisions.marks.map((mark) => mark.program))]
              const specs = marked.map((name) => ({
                name,
                spec: packState.specs[name] ?? "",
                feature: packState.features[name] ?? ""
              }))
              const targetMounted = targetRepo !== undefined && targetRepo.length > 0
              if (!targetMounted) {
                yield* say(
                  "no LLM4TS_TARGET_REPO — the proposal cannot claim anything is provided by the target"
                )
              }
              const packParagraph = pack.prompt("refine-propose")
              const promptText = proposePrompt(decisions, specs, {
                targetMounted,
                ...(packParagraph === undefined ? {} : { packParagraph })
              })
              const ask = yield* capped("propose", promptText, limit).pipe(
                Effect.provideService(FlowEvents, context.events)
              )
              const propose = (seat: FlowContextShape) =>
                structuredAndPublish(
                  seat.reasoning,
                  context.events,
                  ask,
                  DecisionsProposal,
                  decisionsProposalJsonSchema,
                  "coder"
                )
              // The reasoning seat is the coder with read-only tools; rebound
              // into the target (ADR 0013's seat rebind) it proposes `provided`
              // from files it actually opened. Without a target the
              // legacy-rooted seat proposes drops only.
              const proposal =
                targetMounted && context.contextFor !== undefined
                  ? yield* Effect.scoped(
                      Effect.flatMap(context.contextFor(targetRepo), (rebound) => propose(rebound))
                    )
                  : yield* propose(context)
              decisions = applyProposal(decisions, proposal, {
                pointerExists: (pointer) => targetMounted && existsSync(join(targetRepo, pointer)),
                known: packState.known,
                decidedBy: "proposal",
                decidedAt: today()
              })
              yield* writeDecisions
              notes.push(
                `proposed dispositions for ${marked.length} marked program(s): ` +
                  `${decisions.programs.length} program and ${decisions.scenarios.length} scenario decision(s) on file`
              )
            })
          )
        }

        // ---- Consolidate: the domain map ----------------------------------------------
        let domains: Domains | undefined
        const domainsPath = join(modDirAbs, "domains.md")
        const existingText = yield* files.read(domainsPath)
        const existing =
          existingText === undefined
            ? undefined
            : yield* parseDomains(existingText, `${ModDir}/domains.md`)
        if (decisions.unansweredOpenPoints.length === 0) {
          const survivingPrograms = names.filter(
            (name) => decisions.programDecision(name) === undefined
          )
          const surviving = new Map<string, ReadonlySet<string>>(
            survivingPrograms.map((name) => {
              const disposed = decisions.disposedScenarios(name)
              return [
                name,
                new Set([...(packState.scenarios.get(name) ?? [])].filter((t) => !disposed.has(t)))
              ]
            })
          )
          const hash = domainsInputsHash(packState.specs, renderDecisions(decisions))
          if (existing !== undefined && existing.inputsHash === hash && !regroup) {
            domains = existing
          } else {
            domains = yield* stage(
              context.events,
              existing === undefined ? "consolidate" : "consolidate (regroup)",
              Effect.gen(function* () {
                const clusters = clusterPrograms(
                  graph,
                  survivingPrograms,
                  pack.consolidate ?? { cluster: [], context: [] }
                )
                if (pack.consolidate === undefined) {
                  yield* say(
                    "pack has no '## Consolidate' section — every program seeds its own domain feature"
                  )
                }
                const base = consolidatePrompt(clusters, surviving, pack.prompt("consolidate"))
                const attempt = (extra: ReadonlyArray<string>) =>
                  Effect.gen(function* () {
                    const promptText =
                      extra.length === 0
                        ? base
                        : `${base}\n\nYour previous answer broke these rules — fix them:\n${extra.map((v) => `- ${v}`).join("\n")}`
                    const ask = yield* capped("consolidate", promptText, limit).pipe(
                      Effect.provideService(FlowEvents, context.events)
                    )
                    const proposal = yield* structuredAndPublish(
                      context.reasoning,
                      context.events,
                      ask,
                      DomainProposal,
                      domainProposalJsonSchema
                    )
                    const map = domainsFromProposal(proposal, clusters, hash)
                    return { map, violations: checkExactlyOnce(map, surviving) }
                  })
                let result = yield* attempt([])
                if (result.violations.length > 0) {
                  yield* say(
                    `consolidation broke the exactly-once rule ${result.violations.length} time(s) — one retry`
                  )
                  result = yield* attempt(result.violations)
                }
                const map =
                  result.violations.length === 0
                    ? result.map
                    : Domains.make({
                        ...result.map,
                        openPoints: [
                          ...result.map.openPoints,
                          ...result.violations.map((violation, index) => ({
                            number: result.map.openPoints.length + index + 1,
                            question: `The map breaks the exactly-once rule: ${violation} — fix the map by hand`
                          }))
                        ]
                      })
                yield* files.writeAtomic(domainsPath, renderDomains(map))
                notes.push(
                  `${existing === undefined ? "grouped" : "regrouped"} ${survivingPrograms.length} program(s) into ${map.features.length} domain feature(s)`
                )
                return map
              })
            )
          }
        }

        // ---- Plan per domain feature ------------------------------------------------------
        const openPoints = [
          ...decisions.unansweredOpenPoints.map(
            (point) => `decisions.md ${point.number}. ${point.question}`
          ),
          ...(domains?.unansweredOpenPoints ?? []).map(
            (point) => `domains.md ${point.number}. ${point.question}`
          )
        ]
        if (domains !== undefined && openPoints.length === 0 && (notes.length > 0 || regroup)) {
          const map = domains
          yield* stage(
            context.events,
            "plan",
            Effect.gen(function* () {
              const tasks: Array<Task> = []
              const outOfScope = [
                ...decisions.programs.map((e) => `${e.program}: ${e.disposition}`),
                ...decisions.scenarios.map((e) => `${e.program} / ${e.scenario}: ${e.disposition}`)
              ]
              for (const feature of map.features) {
                const text = [
                  `# Domain feature: ${feature.name} (${feature.id})`,
                  `Programs: ${feature.programs.join(", ")}`,
                  `Included fragments (context): ${feature.context.join(", ") || "none"}`,
                  `Scenarios in scope: ${feature.scenarios.map((s) => `${s.program} / ${s.title}`).join("; ")}`,
                  ...(outOfScope.length === 0
                    ? []
                    : [`Out of scope by decision (do not plan): ${outOfScope.join("; ")}`]),
                  ...feature.programs.map(
                    (name) => `\n===== ${name} =====\n${packState.specs[name] ?? ""}`
                  ),
                  ...feature.context.map(
                    (name) => `\n===== ${name} (context) =====\n${packState.specs[name] ?? ""}`
                  )
                ].join("\n")
                const plannerSpecs = yield* capped(`plan[${feature.id}]`, text, limit).pipe(
                  Effect.provideService(FlowEvents, context.events)
                )
                const plan = yield* planFrom(
                  context.reasoning,
                  plannerSpecs,
                  `${defaultPlanInstructions}\n\n${pack.prompt("plan") ?? ""}`
                )
                for (const task of plan.tasks) {
                  tasks.push(
                    Task.make({
                      title: `[${feature.id}] ${task.title}`,
                      description: task.description,
                      completed: false
                    })
                  )
                }
              }
              yield* files.writeAtomic(
                join(modDirAbs, "plan.md"),
                Plan.make({ epicId: `${pack.name}-features`, tasks }).render
              )
              notes.push(`planned ${tasks.length} task(s) across ${map.features.length} feature(s)`)
            })
          )
        }

        if (notes.length === 0) {
          yield* say(
            openPoints.length === 0
              ? "nothing to refine — no marks, no deepen, and the domain map is fresh"
              : "nothing ran — open points are still unanswered"
          )
          if (openPoints.length > 0) {
            return yield* OpenPointsPending.make({ path: ModDir, points: openPoints })
          }
          return
        }

        // ---- rules.txt with its waived section, README reset, commit ---------------------
        yield* stage(
          context.events,
          "rules",
          Effect.gen(function* () {
            const unitsByRule = yield* coverageUnits(repo, pack.coverage)
            const allUnits = [...new Set(Object.values(unitsByRule).flat())].sort()
            const fragments = new Map<string, string>()
            for (const name of names) {
              const fragment = yield* files.read(join(modDirAbs, "traceability", `${name}.md`))
              if (fragment !== undefined) {
                fragments.set(name, fragment)
              }
            }
            const waived = waivedUnits(decisions, { fragments, scenarios: packState.scenarios })
            const lines = [
              ...allUnits,
              ...(waived.length === 0
                ? []
                : ["# waived", ...waived.map((entry) => `${entry.unit} — waived by ${entry.by}`)])
            ]
            if (allUnits.length > 0) {
              yield* files.writeAtomic(join(modDirAbs, "rules.txt"), lines.join("\n") + "\n")
            }
            if (waived.length > 0) {
              notes.push(`${waived.length} coverage unit(s) waived by decision`)
            }
          })
        )
        // The README carries every refinement since the gate passed, not
        // only this run's: an approver reads one list.
        const readme = (yield* files.read(join(modDirAbs, "README.md"))) ?? ""
        const verdict =
          /Gate verdict: (.+?)\.\n/.exec(readme)?.[1] ?? "PASSED — pending human approval"
        const priorNotes = (/Refined after the gate passed:\n((?:- .*\n)+)/.exec(readme)?.[1] ?? "")
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.slice(2))
        yield* files.writeAtomic(
          join(modDirAbs, "README.md"),
          withDraftApproval(readmeFor(pack, verdict, [...priorNotes, ...notes]))
        )
        yield* stage(
          context.events,
          "commit",
          context.git
            .commitAll(`modernize(${pack.name}): refine — ${notes[notes.length - 1] ?? "overlays"}`)
            .pipe(Effect.asVoid)
        )
        if (openPoints.length > 0) {
          return yield* OpenPointsPending.make({ path: ModDir, points: openPoints })
        }
        yield* say(
          `refined — review ${ModDir}/README.md, decisions.md, and domains.md, flip '- [x] Approved' ` +
            "in each, then run the seed phase"
        )
      })
  )
})

runFlowMain(program)
