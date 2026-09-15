// Shared core of the J2EE→Next.js conversion flows (convert-page,
// convert-feature, convert-all). One page — or, once refine has produced an
// approved domain map, one domain feature — = one branch = one conversion report. The Page Spec
// extracted from the legacy repo is the contract; the legacy source is
// consultable evidence (NOT clean-room — ADR 0012); the destination repo's
// own pages are the style guide. All token/cost figures are ESTIMATES.
import { join, resolve } from "node:path"
import * as Effect from "effect/Effect"
import { Dimension } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  FlowAborted,
  Info,
  Plan,
  implementPlanFlow,
  lintCommand,
  loadKitPatternCards,
  makeChat,
  makeNodeWorkspace,
  makePlanStore,
  mergeReviewResults,
  minimalReviewers,
  nodePlainFileStore,
  nodeProcessExecutor,
  openPack,
  reviewFingerprint,
  stage
} from "@llm4ts/runner"
import type { FlowContextShape, PackNotFound, ReviewResult } from "@llm4ts/runner"
import { budget, capped } from "@llm4ts/flow/Context"
import { Decisions, parseDecisions } from "@llm4ts/flow/Decisions"
import type { Domains } from "@llm4ts/flow/Domains"
import { navigationOrder, parseDomains, type DomainFeature } from "@llm4ts/flow/Domains"
import { type FlowError } from "@llm4ts/flow/FlowError"
import { FlowEvents } from "@llm4ts/flow/FlowEvents"
import type { Pack } from "@llm4ts/flow/Pack"
import {
  openApiFor,
  openApiForFeature,
  parsePageSpec,
  renderPageSpec,
  type PageSpec
} from "@llm4ts/flow/PageSpec"
import { loadPatternCards, matchingPatternCards, type PatternCard } from "@llm4ts/flow/Patterns"
import { type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { Task } from "@llm4ts/flow/Plan"
import { judgeAllPrograms } from "@llm4ts/flow/ProgramJudge"
import { closureFor, surveyGraph } from "@llm4ts/flow/Survey"
import { estimatedUsageOptionsFromEnv, makeEstimatedUsageMeter } from "@llm4ts/flow/EstimatedUsage"
import {
  legacySourceWorkspaceLimits,
  workspaceLimitsFromEnv,
  type WorkspaceShape
} from "@llm4ts/flow/Workspace"

export const positiveEnvInt = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number
): number => {
  const raw = Number.parseInt(environment[name] ?? "", 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Sums the coder and reasoning meters into one per-run estimate. */
export const combineTotals = (
  first: Effect.Effect<TokenUsage | undefined>,
  second: Effect.Effect<TokenUsage | undefined>
): Effect.Effect<TokenUsage | undefined> =>
  Effect.gen(function* () {
    const left = yield* first
    const right = yield* second
    if (left === undefined) {
      return right
    }
    if (right === undefined) {
      return left
    }
    const cached = [left.cached, right.cached].flatMap((value) =>
      value === undefined ? [] : [value]
    )
    const cost = [left.costUsd, right.costUsd].flatMap((value) =>
      value === undefined ? [] : [value]
    )
    return TokenUsage.make({
      prompt: left.prompt + right.prompt,
      completion: left.completion + right.completion,
      total: left.total + right.total,
      ...(cached.length === 0 ? {} : { cached: cached.reduce((sum, value) => sum + value, 0) }),
      ...(cost.length === 0 ? {} : { costUsd: cost.reduce((sum, value) => sum + value, 0) })
    })
  })

export interface ConvertPageDeps {
  /** Flow context with METERED coder/reasoning seats (EstimatedUsage). */
  readonly context: FlowContextShape
  readonly files: PlainFileStoreShape
  readonly pack: Pack
  readonly cards: ReadonlyArray<PatternCard>
  readonly legacy: WorkspaceShape
  readonly legacyDir: string
  readonly target: WorkspaceShape
  readonly targetDir: string
  readonly environment: Readonly<Record<string, string | undefined>>
  /** Cumulative estimated usage across both seats — read after the run. */
  readonly totals: Effect.Effect<TokenUsage | undefined>
}

export interface ConvertOutcome {
  readonly page: string
  readonly branch: string
  readonly reportPath: string
  readonly estimatedTokens?: number
  readonly estimatedCostUsd?: number
}

const conversionDimensions: ReadonlyArray<Dimension> = [
  Dimension.make({
    name: "spec-compliance",
    rubric:
      "Does the converted page satisfy its Page Spec — every form field present, every " +
      "validation rule with its VERBATIM message in the spec's order, navigation and " +
      "multi-step session state owned explicitly, and every apiCall represented as a port " +
      "operation matching the OpenAPI contract — without weakening any test?"
  }),
  Dimension.make({
    name: "acl-purity",
    rubric:
      "Is the anti-corruption layer intact — no fetch outside service adapters, no legacy " +
      "DTO names anywhere, no business logic implemented client-side, the page depending " +
      "only on the port through the registry, the mock adapter faking transport rather " +
      "than rules?"
  }),
  Dimension.make({
    name: "house-fidelity",
    rubric:
      "Does the page read as if the destination team wrote it — design-system components " +
      "instead of hand-rolled UI, the house Form validation map, the house test style, no " +
      "ad-hoc styling or auth handling?"
  })
]

const conversionPlan = (page: string, spec: PageSpec, contractPath: string): Plan =>
  Plan.make({
    epicId: `convert/${page}`,
    brief: [
      `You are converting the legacy page '${page}' into this Next.js SPA.`,
      "",
      renderPageSpec(spec).trimEnd(),
      "",
      `The OpenAPI anti-corruption contract is ALREADY WRITTEN at ${contractPath} —`,
      "it is generated from the page spec and is the contract of record. Do not edit it."
    ].join("\n"),
    tasks: [
      Task.make({
        title: `acl: ${page} service port and mock`,
        description: [
          `Implement the anti-corruption service layer for '${page}' from the contract at`,
          `${contractPath}:`,
          `- src/services/${page}/port.ts — a typed port interface with one method per`,
          "  OpenAPI operation, request/response types in the contract's DOMAIN names.",
          `- src/services/${page}/mock.ts — a mock adapter returning contract-shaped,`,
          "  deterministic fixture data (transport fake, never business rules).",
          "- Wire the port into src/services/registry.ts the same way the existing",
          "  services are wired.",
          "Imitate the existing services (e.g. src/services/cards/) exactly. No page code",
          "in this task."
        ].join("\n")
      }),
      Task.make({
        title: `page: ${page} component`,
        description: [
          `Build the converted page under src/app/${page}/ using ONLY the destination`,
          "design-system components and the port from the previous task:",
          "- Respect the original form: same fields, same validation rules with their",
          "  VERBATIM messages in the spec's order, same navigation.",
          "- Anything the legacy app kept in HttpSession or hidden fields becomes explicit",
          "  client state (use the Stepper pattern for multi-step flows).",
          "- No fetch in components; the page obtains its port from the registry.",
          "- Read CONTRIBUTING.md and the existing pages first and match their style."
        ].join("\n")
      }),
      Task.make({
        title: `tests: ${page} component tests`,
        description: [
          `Write component tests at tests/${page}.page.test.tsx in the house test style`,
          "(see the existing tests/ files): mock the registry port, render inside",
          "AuthProvider, and assert EXACTLY three families of behaviour:",
          "1. every spec'd form field renders,",
          "2. every spec'd validation fires with its verbatim message,",
          "3. the port is called with contract-shaped payloads on the happy path.",
          "No snapshots, no styling assertions, nothing beyond those families."
        ].join("\n")
      })
    ]
  })

/**
 * The feature plan (ADR 0012 addendum): the shared port first, then one
 * task per page in navigation order with its tests inside, so every task is
 * a vertical slice behind the gate.
 */
export const featurePlan = (
  feature: DomainFeature,
  order: ReadonlyArray<string>,
  specs: ReadonlyMap<string, PageSpec>,
  contractPath: string
): Plan =>
  Plan.make({
    epicId: `convert/${feature.id}`,
    brief: [
      `You are converting the legacy domain feature '${feature.name}' (${feature.id}) — pages`,
      `${order.join(", ")} — into this Next.js SPA.`,
      ...(feature.context.length === 0
        ? []
        : [
            `The pages include the shared fragments ${feature.context.join(", ")}: they are context,`,
            "already provided by the app layout — do not re-implement them here."
          ]),
      "",
      ...order.flatMap((page) => {
        const spec = specs.get(page)
        return spec === undefined ? [] : [`===== ${page} =====`, renderPageSpec(spec).trimEnd(), ""]
      }),
      `The OpenAPI anti-corruption contract is ALREADY WRITTEN at ${contractPath} — it is the`,
      "union of the pages' API sections and the contract of record. Do not edit it."
    ].join("\n"),
    tasks: [
      Task.make({
        title: `acl: ${feature.id} service port and mock`,
        description: [
          `Implement the anti-corruption service layer for '${feature.name}' from the contract at`,
          `${contractPath}:`,
          `- src/services/${feature.id}/port.ts — a typed port interface with one method per`,
          "  OpenAPI operation, request/response types in the contract's DOMAIN names.",
          `- src/services/${feature.id}/mock.ts — a mock adapter returning contract-shaped,`,
          "  deterministic fixture data (transport fake, never business rules).",
          "- Wire the port into src/services/registry.ts the same way the existing",
          "  services are wired.",
          "Imitate the existing services (e.g. src/services/cards/) exactly. No page code",
          "in this task."
        ].join("\n")
      }),
      ...order.map((page) =>
        Task.make({
          title: `page: ${page} component and tests`,
          description: [
            `Build the converted page under src/app/${page}/ using ONLY the destination`,
            `design-system components and the '${feature.id}' port from the first task:`,
            "- Respect the original form: same fields, same validation rules with their",
            "  VERBATIM messages in the spec's order, same navigation between the feature's pages.",
            "- Anything the legacy app kept in HttpSession or hidden fields becomes explicit",
            "  client state (use the Stepper pattern for multi-step flows).",
            "- No fetch in components; the page obtains its port from the registry.",
            "- Read CONTRIBUTING.md and the existing pages first and match their style.",
            `Then write its component tests at tests/${page}.page.test.tsx in the house test`,
            "style (see the existing tests/ files): mock the registry port, render inside",
            "AuthProvider, and assert EXACTLY three families of behaviour:",
            "1. every spec'd form field renders,",
            "2. every spec'd validation fires with its verbatim message,",
            "3. the port is called with contract-shaped payloads on the happy path.",
            "No snapshots, no styling assertions, nothing beyond those families."
          ].join("\n")
        })
      )
    ]
  })

const gateFor = (
  deps: ConvertPageDeps,
  name: string
): Effect.Effect<ReviewResult, FlowError> | undefined => {
  const command = deps.pack.gate(name)
  return command === undefined
    ? undefined
    : lintCommand(nodeProcessExecutor, deps.context.events, command, deps.targetDir)
}

const allClean = (
  gates: ReadonlyArray<Effect.Effect<ReviewResult, FlowError> | undefined>
): Effect.Effect<ReviewResult, FlowError> =>
  Effect.gen(function* () {
    const results: Array<ReviewResult> = []
    for (const gate of gates) {
      if (gate !== undefined) {
        const result = yield* gate
        results.push(result)
        // Fail fast: a broken typecheck makes later gate output noise.
        if (!result.isClean) {
          break
        }
      }
    }
    return mergeReviewResults(results)
  })

const issueLines = (result: ReviewResult): string =>
  result.issues.map((issue) => `- ${issue.title}: ${issue.description}`).join("\n")

/** The page's legacy source and its bounded include closure, capped to budget. */
const legacyEvidence = Effect.fn("convert.legacyEvidence")(function* (
  deps: ConvertPageDeps,
  page: string
): Effect.fn.Return<{ readonly source: string; readonly evidence: string }, FlowError> {
  const matchesPage = yield* deps.legacy
    .discover(`**/${page}.jsp`)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  const sourcePath = matchesPage[0]
  const source =
    sourcePath === undefined
      ? ""
      : yield* deps.legacy.read(sourcePath).pipe(Effect.orElseSucceed(() => ""))
  const graph = yield* surveyGraph(
    deps.legacy,
    deps.pack.sources ?? ".*",
    deps.pack.coverage,
    deps.pack.survey
  )
  const closure = closureFor(
    graph,
    page,
    positiveEnvInt(deps.environment, "LLM4TS_MAX_CLOSURE_FILES", 12)
  )
  const parts: Array<string> = []
  if (sourcePath !== undefined) {
    parts.push(`===== ${sourcePath} =====\n${source}`)
  }
  for (const path of closure) {
    const text = yield* deps.legacy.read(path).pipe(Effect.orElseSucceed(() => ""))
    if (text.trim().length > 0) {
      parts.push(`===== ${path} =====\n${text}`)
    }
  }
  const evidence = yield* capped(
    `legacy[${page}]`,
    parts.join("\n\n"),
    Math.floor(budget(deps.environment) / 3)
  ).pipe(Effect.provideService(FlowEvents, deps.context.events))
  return { source, evidence }
})

const destinationGuidance = Effect.fn("convert.destinationGuidance")(function* (
  deps: ConvertPageDeps
): Effect.fn.Return<string, FlowError> {
  const contributing = yield* deps.target
    .read("CONTRIBUTING.md")
    .pipe(Effect.orElseSucceed(() => ""))
  const pages = yield* deps.target
    .discover("src/app/**/page.tsx")
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  return [
    "Destination house rules (CONTRIBUTING.md):",
    contributing.trim(),
    "",
    "Existing pages to imitate:",
    ...pages.map((path) => `- ${path}`)
  ].join("\n")
})

/**
 * What one conversion run needs, whether its unit is a page or a domain
 * feature (ADR 0012 addendum): the branch, the contract of record, the plan,
 * what the coder is briefed with, what the judge scores, and the report.
 */
interface ConversionUnit {
  readonly id: string
  readonly kind: "page" | "feature"
  readonly contractPath: string
  readonly contract: string
  readonly plan: Plan
  /** Legacy source of every page, for pattern-card matching. */
  readonly source: string
  readonly evidence: string
  readonly scope: string | undefined
  /** Programs the judge scores, each against its own contract text. */
  readonly judged: ReadonlyArray<{ readonly name: string; readonly spec: string }>
  readonly openQuestions: ReadonlyArray<{ readonly page: string; readonly question: string }>
  readonly reportLines: ReadonlyArray<string>
}

const scopeFor = (decisions: Decisions, pages: ReadonlyArray<string>): string | undefined => {
  const lines = pages.flatMap((page) =>
    decisions.scenarios
      .filter((entry) => entry.program === page)
      .map((entry) => `- ${page} / ${entry.scenario}: ${entry.disposition} — ${entry.reason}`)
  )
  return lines.length === 0
    ? undefined
    : "Out of scope by decision (do not implement, do not test, do not score their absence):\n" +
        lines.join("\n")
}

const readSpec = Effect.fn("convert.readSpec")(function* (
  deps: ConvertPageDeps,
  page: string
): Effect.fn.Return<
  { readonly path: string; readonly markdown: string; readonly spec: PageSpec },
  FlowError
> {
  const path = join(deps.legacyDir, deps.pack.specsDir, `${page}.md`)
  const markdown = yield* deps.files.read(path)
  if (markdown === undefined) {
    return yield* FlowAborted.make({
      message: `no spec at ${path} — run modernize-extract on the legacy repo first`
    })
  }
  // Hard schema validation: a spec without a decodable pagespec block is an
  // incomplete extraction, not a page to guess at.
  const spec = yield* parsePageSpec(markdown)
  return { path, markdown, spec }
})

const runConversion = Effect.fn("convert.run")(function* (
  deps: ConvertPageDeps,
  unit: ConversionUnit
): Effect.fn.Return<ConvertOutcome, FlowError> {
  const { context, environment, files, pack } = deps
  const branch = `convert/${unit.id}`
  yield* stage(context.events, "branch", context.git.checkoutOrCreate(branch))

  // The contract is a deterministic projection of the reviewed spec(s) — written
  // by code before any model runs, committed with the first task.
  yield* stage(
    context.events,
    "contract",
    files.writeAtomic(join(deps.targetDir, unit.contractPath), unit.contract)
  )

  const playbook = matchingPatternCards(unit.source, deps.cards)
  const guidance = yield* destinationGuidance(deps)
  const system = [
    pack.prompt("implement"),
    pack.lessons === undefined
      ? undefined
      : `Lessons from previous conversion runs — apply them:\n${pack.lessons}`,
    playbook.length === 0
      ? undefined
      : "Pattern cards matched by the legacy source — the translation playbook (advisory, " +
        "the spec wins):\n\n" +
        playbook.map((card) => `### ${card.id}\n${card.body}`).join("\n\n"),
    guidance,
    unit.scope,
    unit.evidence.trim().length === 0
      ? undefined
      : `Legacy source evidence (for disambiguation only — the Page Spec wins):\n\n${unit.evidence}`
  ]
    .filter((part) => part !== undefined)
    .join("\n\n")

  const perTaskGate = allClean([
    gateFor(deps, "typecheck"),
    gateFor(deps, "lint"),
    gateFor(deps, "test")
  ])

  yield* implementPlanFlow(context, {
    store: makePlanStore(files),
    planPath: join(deps.targetDir, ".llm4ts", "convert", `${unit.id}.plan.md`),
    plan: Effect.succeed(unit.plan),
    system,
    chatPerTask: true,
    checkoutBranch: false,
    reviewers: [...minimalReviewers, ...pack.lenses],
    lint: perTaskGate
  })

  const verifyGate = allClean([gateFor(deps, "test"), gateFor(deps, "build")])
  yield* stage(
    context.events,
    "verify",
    Effect.gen(function* () {
      const result = yield* verifyGate
      if (!result.isClean) {
        return yield* FlowAborted.make({
          message: `verify gate failed for ${unit.id}:\n${issueLines(result)}`
        })
      }
    })
  )

  yield* stage(
    context.events,
    "judge",
    Effect.gen(function* () {
      const complianceJudge = judge(context.reasoning, conversionDimensions)
      const rounds = positiveEnvInt(environment, "LLM4TS_JUDGE_ROUNDS", 2)
      const specOf = new Map(unit.judged.map((entry) => [entry.name, entry.spec]))
      for (let round = 1; round <= rounds; round += 1) {
        const base = yield* context.git.defaultBase
        const verdict = yield* judgeAllPrograms({
          pack,
          judge: complianceJudge,
          dimensions: conversionDimensions,
          git: context.git,
          files,
          gateDir: join(deps.targetDir, ".llm4ts", "convert", "gate"),
          base,
          programs: unit.judged.map((entry) => entry.name),
          specFor: (program) => Effect.succeed(specOf.get(program) ?? ""),
          query: context.userPrompt,
          fingerprint: reviewFingerprint
        })
        if (verdict.isClean) {
          return yield* context.events.publish(
            Info.make({ message: `judge: ${unit.id} cleared the bar` })
          )
        }
        if (round >= rounds) {
          return yield* FlowAborted.make({
            message: `judge not cleared for ${unit.id} after ${rounds} round(s):\n${issueLines(verdict)}`
          })
        }
        const feedback = yield* makeChat(context.coder, {
          system,
          events: context.events,
          agent: "coder"
        })
        yield* feedback.ask(
          [
            `The conversion of '${unit.id}' scored below the bar. Close these gaps without`,
            "weakening any test, then stop:",
            issueLines(verdict)
          ].join("\n")
        )
        const regated = yield* verifyGate
        if (!regated.isClean) {
          return yield* FlowAborted.make({
            message: `verify gate broke while addressing judge feedback on ${unit.id}`
          })
        }
        yield* context.git.commitAll(`convert/${unit.id}: address judge feedback`)
      }
    }).pipe(Effect.provideService(FlowEvents, context.events))
  )

  const totals = yield* deps.totals
  const reportPath = `docs/conversion/${unit.id}.md`
  const base = yield* context.git.defaultBase
  const changed = yield* context.git.changedFilesVsBase(base)
  const report = [
    `# Conversion report: ${unit.id}`,
    "",
    "> Token and cost figures below are ESTIMATES from character counts",
    "> (see docs/adr/0012): the CLI seats report no usage. They are not",
    "> measurements.",
    "",
    ...unit.reportLines,
    `- Branch: \`${branch}\` (awaiting human review — no auto-merge)`,
    `- Contract: ${unit.contractPath}`,
    `- Gates: typecheck, lint, test, build — green at report time`,
    "- Judge: cleared (spec-compliance, acl-purity, house-fidelity)",
    ...(totals === undefined
      ? ["- Estimated usage: none recorded"]
      : [
          `- Estimated tokens: ~${totals.total} (${totals.prompt} in / ${totals.completion} out)`,
          ...(totals.costUsd === undefined
            ? []
            : [`- Estimated cost: ~$${totals.costUsd.toFixed(2)}`])
        ]),
    "",
    "## Files changed",
    "",
    ...changed.map((file) => `- ${file}`),
    ...(unit.openQuestions.length === 0
      ? []
      : [
          "",
          "## Open questions carried forward",
          "",
          ...unit.openQuestions.map((q) =>
            unit.kind === "page" ? `- ${q.question}` : `- ${q.page}: ${q.question}`
          )
        ])
  ].join("\n")
  yield* files.writeAtomic(join(deps.targetDir, reportPath), report + "\n")
  yield* context.git.commitAll(`convert/${unit.id}: conversion report`)

  return {
    page: unit.id,
    branch,
    reportPath,
    ...(totals === undefined ? {} : { estimatedTokens: totals.total }),
    ...(totals?.costUsd === undefined ? {} : { estimatedCostUsd: totals.costUsd })
  }
})

export const convertPage = Effect.fn("convert.page")(function* (
  deps: ConvertPageDeps,
  page: string
): Effect.fn.Return<ConvertOutcome, FlowError> {
  const { path: specPath, markdown: specMarkdown, spec } = yield* readSpec(deps, page)
  // The decisions overlay (ADR 0015): a page disposed as a whole is never
  // converted; disposed scenarios are out of scope for the coder and the judge.
  const decisions = yield* legacyDecisions(deps.files, deps.legacyDir)
  const pageDecision = decisions.programDecision(page)
  if (pageDecision !== undefined) {
    return yield* FlowAborted.make({
      message: `${page} is marked '${pageDecision.disposition}' in the legacy pack's decisions.md — ${pageDecision.reason}`
    })
  }
  const scope = scopeFor(decisions, [page])
  const contractPath = `contracts/${page}.openapi.yaml`
  const { source, evidence } = yield* legacyEvidence(deps, page)
  return yield* runConversion(deps, {
    id: page,
    kind: "page",
    contractPath,
    contract: openApiFor(spec),
    plan: conversionPlan(page, spec, contractPath),
    source,
    evidence,
    scope,
    judged: [
      { name: page, spec: scope === undefined ? specMarkdown : `${specMarkdown}\n\n${scope}` }
    ],
    openQuestions: spec.openQuestions.map((question) => ({ page, question })),
    reportLines: [`- Legacy spec: ${specPath}`]
  })
})

/** The legacy pack's domain map, or undefined when refine never consolidated it. */
export const legacyDomains = Effect.fn("convert.domains")(function* (
  files: PlainFileStoreShape,
  legacyDir: string
): Effect.fn.Return<Domains | undefined, FlowError> {
  const text = yield* files.read(join(legacyDir, "docs/modernization/domains.md"))
  return text === undefined ? undefined : yield* parseDomains(text, "domains.md")
})

/**
 * Convert ONE domain feature (ADR 0012 addendum): its surviving pages on one
 * branch, one contract that is the union of their API sections, the port
 * first and then each page with its tests in navigation order. The judge
 * scores every page against its own spec plus the feature against its
 * contract of record.
 */
export const convertFeature = Effect.fn("convert.feature")(function* (
  deps: ConvertPageDeps,
  featureId: string
): Effect.fn.Return<ConvertOutcome, FlowError> {
  const domains = yield* legacyDomains(deps.files, deps.legacyDir)
  if (domains === undefined) {
    return yield* FlowAborted.make({
      message: "no docs/modernization/domains.md in the legacy pack — run modernize-refine first"
    })
  }
  if (!domains.approved) {
    return yield* FlowAborted.make({
      message: "docs/modernization/domains.md is not approved — flip '- [x] Approved' first"
    })
  }
  const feature = domains.features.find((candidate) => candidate.id === featureId)
  if (feature === undefined) {
    return yield* FlowAborted.make({
      message: `no domain feature '${featureId}' in domains.md (known: ${domains.features.map((f) => f.id).join(", ")})`
    })
  }
  const decisions = yield* legacyDecisions(deps.files, deps.legacyDir)
  const pages = feature.programs.filter((page) => decisions.programDecision(page) === undefined)
  if (pages.length === 0) {
    return yield* FlowAborted.make({
      message: `every page of '${featureId}' is disposed of in decisions.md — nothing to convert`
    })
  }
  const specs = new Map<string, { path: string; markdown: string; spec: PageSpec }>()
  for (const page of pages) {
    specs.set(page, yield* readSpec(deps, page))
  }
  const graph = yield* surveyGraph(
    deps.legacy,
    deps.pack.sources ?? ".*",
    deps.pack.coverage,
    deps.pack.survey
  )
  const order = navigationOrder(
    { ...feature, programs: pages },
    graph,
    deps.pack.consolidate ?? { cluster: [], context: [] }
  )
  const contractPath = `contracts/${feature.id}.openapi.yaml`
  const contract = yield* openApiForFeature(
    feature,
    order.map((page) => specs.get(page)?.spec).filter((spec) => spec !== undefined)
  )
  const sources: Array<string> = []
  const evidences: Array<string> = []
  for (const page of order) {
    const { source, evidence } = yield* legacyEvidence(deps, page)
    sources.push(source)
    evidences.push(evidence)
  }
  const evidence = yield* capped(
    `legacy[${feature.id}]`,
    evidences.join("\n\n"),
    Math.floor(budget(deps.environment) / 3)
  ).pipe(Effect.provideService(FlowEvents, deps.context.events))
  const scope = scopeFor(decisions, order)
  const specMap = new Map(order.map((page) => [page, specs.get(page)?.spec]))
  const plan = featurePlan(
    feature,
    order,
    new Map([...specMap.entries()].flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as const]))),
    contractPath
  )
  return yield* runConversion(deps, {
    id: feature.id,
    kind: "feature",
    contractPath,
    contract: contract.yaml,
    plan,
    source: sources.join("\n"),
    evidence,
    scope,
    judged: [
      ...order.map((page) => {
        const markdown = specs.get(page)?.markdown ?? ""
        return { name: page, spec: scope === undefined ? markdown : `${markdown}\n\n${scope}` }
      }),
      // The feature itself is judged against its contract of record: the
      // pack's feature-files scope is exactly the port and the contract.
      {
        name: feature.id,
        spec:
          `# Contract of record for domain feature ${feature.name}\n\n` +
          "The service port under src/services/<feature>/ must expose one operation per path " +
          "and method below, with request and response types in the contract's domain names.\n\n" +
          "```yaml\n" +
          contract.yaml +
          "```"
      }
    ],
    openQuestions: order.flatMap((page) =>
      (specs.get(page)?.spec.openQuestions ?? []).map((question) => ({ page, question }))
    ),
    reportLines: [
      `- Domain feature: ${feature.name} (${feature.id})`,
      `- Pages, in navigation order: ${order.join(", ")}`,
      ...(feature.context.length === 0
        ? []
        : [`- Context fragments: ${feature.context.join(", ")}`]),
      ...order.map((page) => `- Legacy spec: ${specs.get(page)?.path ?? page}`)
    ]
  })
})

/**
 * The common wiring of both conversion flows: metered seats (estimates-only
 * accounting), the two workspaces (legacy read-only limits, target default),
 * the pack (default `j2ee-nextjs-spa`, from the kit), and the pattern-card deck.
 */
export const setupConversion = Effect.fn("convert.setup")(function* (
  context: FlowContextShape,
  input: { readonly workDir: string; readonly workspace: string },
  environment: Readonly<Record<string, string | undefined>>,
  flowDir: string
): Effect.fn.Return<ConvertPageDeps, FlowError | PackNotFound> {
  const legacyRaw = environment.LLM4TS_LEGACY_REPO
  if (legacyRaw === undefined || legacyRaw.trim().length === 0) {
    return yield* FlowAborted.make({
      message: "set LLM4TS_LEGACY_REPO to the extracted legacy repository path"
    })
  }
  const legacyDir = resolve(input.workspace, legacyRaw.trim())
  const estimateOptions = estimatedUsageOptionsFromEnv(environment)
  const coderMeter = yield* makeEstimatedUsageMeter(context.coder, estimateOptions)
  const reasoningMeter = yield* makeEstimatedUsageMeter(context.reasoning, estimateOptions)
  const metered: FlowContextShape = {
    ...context,
    coder: coderMeter.service,
    reasoning: reasoningMeter.service
  }
  const legacy = yield* makeNodeWorkspace(
    legacyDir,
    workspaceLimitsFromEnv(environment, legacySourceWorkspaceLimits)
  )
  const target = yield* makeNodeWorkspace(input.workDir)
  const opened = yield* stage(
    context.events,
    "pack",
    openPack({
      environment: {
        ...environment,
        LLM4TS_PACK: environment.LLM4TS_PACK ?? "j2ee-nextjs-spa"
      },
      launchDir: input.workspace,
      flowDir
    })
  )
  const cards = [
    ...(yield* loadPatternCards(opened.workspace, `${opened.dir}/patterns`)),
    ...(yield* loadKitPatternCards(opened))
  ]
  return {
    context: metered,
    files: nodePlainFileStore,
    pack: opened.pack,
    cards,
    legacy,
    legacyDir,
    target,
    targetDir: input.workDir,
    environment,
    totals: combineTotals(coderMeter.totals, reasoningMeter.totals)
  }
})

// ---- Inventory (convert-all) ------------------------------------------------

export interface WaveEntry {
  readonly wave: string
  readonly pages: ReadonlyArray<string>
}

/** `## Wave: <name>` sections with their `- PROG` lines — the survey's plan. */
export const parseWavePlan = (planText: string): ReadonlyArray<WaveEntry> => {
  const waves: Array<{ wave: string; pages: Array<string> }> = []
  let collecting = false
  for (const line of planText.split(/\r?\n/)) {
    const trimmed = line.trim()
    const heading = /^## Wave: (.+)$/.exec(trimmed)
    if (heading?.[1] !== undefined) {
      waves.push({ wave: heading[1].trim(), pages: [] })
      collecting = true
      continue
    }
    if (trimmed.startsWith("## ") || trimmed.startsWith("# ")) {
      // Any other section (Triage, notes) ends the current wave's list.
      collecting = false
      continue
    }
    const current = waves.at(-1)
    // The approval marker sits under the last wave; it is not a page.
    if (
      collecting &&
      current !== undefined &&
      trimmed.startsWith("- ") &&
      !/^- \[[ xX]\] /.test(trimmed)
    ) {
      current.pages.push(trimmed.slice(2).trim())
    }
  }
  return waves
}

/**
 * The ordered page list: the approved wave plan when present, otherwise every
 * extracted spec. Pages appear in conversion order.
 */
export interface InventoryEntry {
  readonly page: string
  readonly wave?: string
  /** A program-level decision (ADR 0015): the page is listed, never converted. */
  readonly disposition?: string
}

/** The legacy pack's decisions overlay, empty when refine never ran. */
export const legacyDecisions = Effect.fn("convert.decisions")(function* (
  files: PlainFileStoreShape,
  legacyDir: string
): Effect.fn.Return<Decisions, FlowError> {
  const text = yield* files.read(join(legacyDir, "docs/modernization/decisions.md"))
  return text === undefined ? Decisions.empty() : yield* parseDecisions(text, "decisions.md")
})

/**
 * The ordered page list: the approved wave plan when present, otherwise every
 * extracted spec. Pages appear in conversion order; a page disposed as a whole
 * by the decisions overlay carries its disposition and is skipped by the walk.
 */
export const conversionInventory = Effect.fn("convert.inventory")(function* (
  files: PlainFileStoreShape,
  legacy: WorkspaceShape,
  legacyDir: string,
  pack: Pack
): Effect.fn.Return<ReadonlyArray<InventoryEntry>, FlowError> {
  const decisions = yield* legacyDecisions(files, legacyDir)
  const withDisposition = (entry: InventoryEntry): InventoryEntry => {
    const decision = decisions.programDecision(entry.page)
    return decision === undefined ? entry : { ...entry, disposition: decision.disposition }
  }
  const planText = yield* files.read(join(legacyDir, "docs/modernization/wave-plan.md"))
  if (planText !== undefined) {
    const waves = parseWavePlan(planText)
    if (waves.length > 0) {
      return waves.flatMap((entry) =>
        entry.pages.map((page) => withDisposition({ page, wave: entry.wave }))
      )
    }
  }
  const specs = yield* legacy
    .discover(`${pack.specsDir}/*.md`)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  return [...specs]
    .map((path) => path.split("/").at(-1) ?? path)
    .filter(
      (name) => name.endsWith(".md") && !["README.md", "decisions.md", "domains.md"].includes(name)
    )
    .map((name) => name.slice(0, -".md".length))
    .sort()
    .map((page) => withDisposition({ page }))
})

export interface FeatureEntry {
  readonly feature: DomainFeature
  readonly wave?: string
  /** Every page disposed of at program level: listed, never converted. */
  readonly disposed: boolean
}

/**
 * The feature walk (ADR 0012 addendum): the approved domain map's features
 * ordered by the earliest wave of their pages, then by id; undefined when the
 * legacy pack has no approved map, so the caller falls back to pages.
 */
export const featureInventory = Effect.fn("convert.featureInventory")(function* (
  files: PlainFileStoreShape,
  legacy: WorkspaceShape,
  legacyDir: string,
  pack: Pack
): Effect.fn.Return<ReadonlyArray<FeatureEntry> | undefined, FlowError> {
  const domains = yield* legacyDomains(files, legacyDir)
  if (domains === undefined || !domains.approved) {
    return undefined
  }
  const pages = yield* conversionInventory(files, legacy, legacyDir, pack)
  const waveOf = new Map(pages.map((entry) => [entry.page, entry.wave]))
  const waveIndex = [...new Set(pages.map((entry) => entry.wave))]
  const decisions = yield* legacyDecisions(files, legacyDir)
  return domains.features
    .map((feature): FeatureEntry => {
      const waves = feature.programs
        .map((page) => waveOf.get(page))
        .filter((wave): wave is string => wave !== undefined)
        .sort((left, right) => waveIndex.indexOf(left) - waveIndex.indexOf(right))
      const wave = waves[0]
      return {
        feature,
        ...(wave === undefined ? {} : { wave }),
        disposed: feature.programs.every((page) => decisions.programDecision(page) !== undefined)
      }
    })
    .sort((left, right) => {
      const byWave = waveIndex.indexOf(left.wave ?? "") - waveIndex.indexOf(right.wave ?? "")
      return byWave !== 0 ? byWave : left.feature.id.localeCompare(right.feature.id)
    })
})

// ---- Migration report (convert-all) ----------------------------------------

export interface MigrationRow {
  readonly page: string
  readonly outcome: "done" | "failed" | "skipped"
  readonly detail?: string
  readonly estimatedTokens?: number
  readonly estimatedCostUsd?: number
}

/**
 * Whole-estate summary with a deliberately naive projection: average estimated
 * cost per converted page times the remainder. Every figure is an estimate of
 * an estimate and the report says so — no pretend precision, rounded hard.
 */
export const migrationReport = (
  rows: ReadonlyArray<MigrationRow>,
  remaining: ReadonlyArray<string>
): string => {
  const done = rows.filter((row) => row.outcome === "done")
  const tokenRows = done.flatMap((row) =>
    row.estimatedTokens === undefined ? [] : [row.estimatedTokens]
  )
  const costRows = done.flatMap((row) =>
    row.estimatedCostUsd === undefined ? [] : [row.estimatedCostUsd]
  )
  const averageTokens =
    tokenRows.length === 0
      ? undefined
      : Math.round(tokenRows.reduce((sum, value) => sum + value, 0) / tokenRows.length)
  const averageCost =
    costRows.length === 0
      ? undefined
      : costRows.reduce((sum, value) => sum + value, 0) / costRows.length
  const lines: Array<string> = [
    "# Migration report",
    "",
    "> EVERY figure in this report is an ESTIMATE derived from character",
    "> counts (docs/adr/0012) — the CLI seats report no token usage. The",
    "> projection below is an estimate built on those estimates.",
    "",
    `- Pages converted: ${done.length}`,
    `- Pages failed: ${rows.filter((row) => row.outcome === "failed").length}`,
    `- Pages skipped: ${rows.filter((row) => row.outcome === "skipped").length}`,
    `- Pages remaining: ${remaining.length}`,
    "",
    "## Per page (estimated)",
    "",
    "| Page | Outcome | ~Tokens | ~Cost | Note |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) =>
      [
        `| ${row.page}`,
        row.outcome,
        row.estimatedTokens === undefined ? "—" : `~${row.estimatedTokens}`,
        row.estimatedCostUsd === undefined ? "—" : `~$${row.estimatedCostUsd.toFixed(2)}`,
        `${row.detail ?? ""} |`
      ].join(" | ")
    )
  ]
  if (remaining.length > 0 && (averageTokens !== undefined || averageCost !== undefined)) {
    lines.push("", "## Projection for the remaining estate (estimated)", "")
    if (averageTokens !== undefined) {
      lines.push(
        `- ~${averageTokens} tokens/page × ${remaining.length} pages ≈ ` +
          `~${averageTokens * remaining.length} tokens`
      )
    }
    if (averageCost !== undefined) {
      lines.push(
        `- ~$${averageCost.toFixed(2)}/page × ${remaining.length} pages ≈ ` +
          `~$${(averageCost * remaining.length).toFixed(0)}`
      )
    }
    lines.push("", `Remaining: ${remaining.join(", ")}`)
  }
  return lines.join("\n") + "\n"
}
