import { userInfo } from "node:os"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { FileSystem } from "effect/FileSystem"
import * as Prompt from "effect/unstable/cli/Prompt"
import {
  Decisions,
  DeepenMark,
  type Disposition,
  ProgramDecision,
  ProposalMark,
  ScenarioDecision,
  parseDecisions,
  renderDecisions,
  scenarioTitles
} from "@llm4ts/flow/Decisions"
import { Domains, parseDomains, renderDomains } from "@llm4ts/flow/Domains"
import { ApprovedMarker, DraftApprovalMarker } from "@llm4ts/flow/Approval"

/**
 * The interactive front of `modernize-refine` (ADR 0015). The FILE is the
 * state: every beat here reads `docs/modernization/decisions.md` and
 * `domains.md`, edits them through the flow package's parse/render, and
 * writes them back — then the engine flow runs as a child process exactly
 * as `llm4ts run modernize-refine` would. Nothing done here is unreachable
 * by editing the files by hand.
 */

export const ModDir = "docs/modernization"

export interface PackInventory {
  readonly programs: ReadonlyArray<string>
  readonly scenarios: ReadonlyMap<string, ReadonlyArray<string>>
}

/** The extracted programs and their scenario titles, from the pack on disk. */
export const scanPack = Effect.fn("@llm4ts/shell/Refine.scanPack")(function* (modDir: string) {
  const fs = yield* FileSystem
  const specsDir = `${modDir}/specs`
  const names = (yield* fs.readDirectory(specsDir).pipe(Effect.orElseSucceed(() => [])))
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => file.slice(0, -".md".length))
    .sort()
  const scenarios = new Map<string, ReadonlyArray<string>>()
  for (const name of names) {
    const feature = yield* fs
      .readFileString(`${modDir}/features/${name.toLowerCase()}.feature`)
      .pipe(Effect.orElseSucceed(() => ""))
    scenarios.set(name, scenarioTitles(feature))
  }
  return { programs: names, scenarios } satisfies PackInventory
})

export const loadDecisions = Effect.fn("@llm4ts/shell/Refine.loadDecisions")(function* (
  modDir: string
) {
  const fs = yield* FileSystem
  const text = yield* fs
    .readFileString(`${modDir}/decisions.md`)
    .pipe(Effect.orElseSucceed(() => undefined))
  return text === undefined ? Decisions.empty() : yield* parseDecisions(text, "decisions.md")
})

export const loadDomains = Effect.fn("@llm4ts/shell/Refine.loadDomains")(function* (
  modDir: string
) {
  const fs = yield* FileSystem
  const text = yield* fs
    .readFileString(`${modDir}/domains.md`)
    .pipe(Effect.orElseSucceed(() => undefined))
  return text === undefined ? undefined : yield* parseDomains(text, "domains.md")
})

export const saveDecisions = (modDir: string, decisions: Decisions) =>
  Effect.flatMap(FileSystem, (fs) =>
    fs.writeFileString(`${modDir}/decisions.md`, renderDecisions(decisions))
  )

export const saveDomains = (modDir: string, domains: Domains) =>
  Effect.flatMap(FileSystem, (fs) =>
    fs.writeFileString(`${modDir}/domains.md`, renderDomains(domains))
  )

/** `- [ ] Approved` → `- [x] Approved` in a markdown document; unchanged when already approved. */
export const approveMarkdown = (markdown: string): string =>
  markdown.includes(ApprovedMarker)
    ? markdown
    : markdown.replace(DraftApprovalMarker, ApprovedMarker)

/** The decision signature: LLM4TS_APPROVER, else the OS user. */
export const signer = (environment: Readonly<Record<string, string | undefined>>): string => {
  const approver = environment.LLM4TS_APPROVER?.trim()
  if (approver !== undefined && approver.length > 0) {
    return approver
  }
  try {
    return userInfo().username
  } catch {
    return "operator"
  }
}

const today = (): string => new Date().toISOString().slice(0, 10)

export interface RefineSessionOptions {
  /** Absolute `docs/modernization` of the legacy repository. */
  readonly modDir: string
  /** Runs the engine flow; resolves to its exit code. */
  readonly launch: (extraEnvironment: Readonly<Record<string, string>>) => Effect.Effect<number>
  readonly environment: Readonly<Record<string, string | undefined>>
}

type Action =
  | "programs"
  | "scenarios"
  | "deepen"
  | "run"
  | "answer"
  | "regroup"
  | "approve"
  | "exit"

const dispositionChoices: ReadonlyArray<Prompt.SelectChoice<Disposition | "?">> = [
  { title: "drop", value: "drop", description: "deprecated — will not exist in the target" },
  {
    title: "provided",
    value: "provided",
    description: "the target already has it or solves it differently"
  },
  { title: "defer", value: "defer", description: "still to migrate, not in this delivery" },
  { title: "wrap", value: "wrap", description: "programs only: stays legacy behind an API" },
  { title: "? ask the model", value: "?", description: "let the proposal decide, with your note" }
]

const nonEmpty = (value: string): Effect.Effect<string, string> =>
  value.trim().length === 0 ? Effect.fail("required") : Effect.succeed(value.trim())

interface Decided {
  readonly disposition: Disposition
  readonly reason: string
  readonly pointer?: string
  readonly milestone?: string
  readonly decidedBy: string
  readonly decidedAt: string
}

/** Asks for a disposition and what it needs; `undefined` means a `?` mark with the note. */
const askDisposition = Effect.fn("@llm4ts/shell/Refine.askDisposition")(function* (
  key: string,
  programLevel: boolean,
  who: string
) {
  const disposition = yield* Prompt.run(
    Prompt.Select<Disposition | "?">({
      message: `${key} — disposition`,
      choices: programLevel
        ? dispositionChoices
        : dispositionChoices.filter((choice) => choice.value !== "wrap")
    })
  )
  if (disposition === "?") {
    const note = yield* Prompt.run(
      Prompt.String({ message: `${key} — note for the model (what makes you unsure)` })
    )
    return { mark: note.trim() }
  }
  const pointer =
    disposition === "provided"
      ? yield* Prompt.run(
          Prompt.String({
            message: `${key} — target path or capability that provides it`,
            validate: nonEmpty
          })
        )
      : undefined
  const reason = yield* Prompt.run(
    Prompt.String({
      message: `${key} — why${disposition === "provided" ? " (note)" : ""}`,
      ...(disposition === "provided" ? {} : { validate: nonEmpty })
    })
  )
  const milestone =
    disposition === "defer"
      ? yield* Prompt.run(Prompt.String({ message: `${key} — milestone or wave (empty for none)` }))
      : undefined
  const decided: Decided = {
    disposition,
    reason: reason.trim(),
    ...(pointer === undefined ? {} : { pointer: pointer.trim() }),
    ...(milestone === undefined || milestone.trim().length === 0
      ? {}
      : { milestone: milestone.trim() }),
    decidedBy: who,
    decidedAt: today()
  }
  return { decided }
})

const markPrograms = Effect.fn("@llm4ts/shell/Refine.markPrograms")(function* (
  options: RefineSessionOptions,
  inventory: PackInventory,
  decisions: Decisions
) {
  const open = inventory.programs.filter(
    (name) =>
      decisions.programDecision(name) === undefined &&
      !decisions.marks.some((mark) => mark.program === name && mark.scenario === undefined)
  )
  if (open.length === 0) {
    yield* Console.log("every program already has a decision or a mark")
    return decisions
  }
  const chosen = yield* Prompt.run(
    Prompt.MultiSelect<string>({
      message: "Programs to mark (space selects, enter confirms)",
      choices: open.map((name) => ({ title: name, value: name }))
    })
  )
  const who = signer(options.environment)
  let next = decisions
  for (const name of chosen) {
    const answer = yield* askDisposition(name, true, who)
    next = Decisions.make({
      ...next,
      ...("decided" in answer
        ? {
            programs: [...next.programs, ProgramDecision.make({ program: name, ...answer.decided })]
          }
        : { marks: [...next.marks, ProposalMark.make({ program: name, note: answer.mark })] })
    })
  }
  return next
})

const markScenarios = Effect.fn("@llm4ts/shell/Refine.markScenarios")(function* (
  options: RefineSessionOptions,
  inventory: PackInventory,
  decisions: Decisions
) {
  const programs = inventory.programs.filter(
    (name) => decisions.programDecision(name) === undefined
  )
  if (programs.length === 0) {
    yield* Console.log("no program left whose scenarios can be marked")
    return decisions
  }
  const program = yield* Prompt.run(
    Prompt.Select<string>({
      message: "Program",
      choices: programs.map((name) => ({
        title: name,
        value: name,
        description: `${inventory.scenarios.get(name)?.length ?? 0} scenario(s)`
      }))
    })
  )
  const disposed = decisions.disposedScenarios(program)
  const open = (inventory.scenarios.get(program) ?? []).filter(
    (title) =>
      !disposed.has(title) &&
      !decisions.marks.some((mark) => mark.program === program && mark.scenario === title)
  )
  if (open.length === 0) {
    yield* Console.log(`every scenario of ${program} already has a decision or a mark`)
    return decisions
  }
  const chosen = yield* Prompt.run(
    Prompt.MultiSelect<string>({
      message: `${program} — scenarios to mark`,
      choices: open.map((title) => ({ title, value: title }))
    })
  )
  const who = signer(options.environment)
  let next = decisions
  for (const title of chosen) {
    const answer = yield* askDisposition(`${program} / ${title}`, false, who)
    next = Decisions.make({
      ...next,
      ...("decided" in answer
        ? {
            scenarios: [
              ...next.scenarios,
              ScenarioDecision.make({ program, scenario: title, ...answer.decided })
            ]
          }
        : {
            marks: [
              ...next.marks,
              ProposalMark.make({ program, scenario: title, note: answer.mark })
            ]
          })
    })
  }
  return next
})

const markDeepen = Effect.fn("@llm4ts/shell/Refine.markDeepen")(function* (
  inventory: PackInventory,
  decisions: Decisions
) {
  const program = yield* Prompt.run(
    Prompt.Select<string>({
      message: "Program to deepen",
      choices: inventory.programs.map((name) => ({ title: name, value: name }))
    })
  )
  const focus = yield* Prompt.run(
    Prompt.String({
      message: `${program} — what must the analyst look for (mandatory focus)`,
      validate: nonEmpty
    })
  )
  return Decisions.make({
    ...decisions,
    deepen: [...decisions.deepen, DeepenMark.make({ program, focus: focus.trim() })]
  })
})

/** Walks every unanswered open point of both overlays; an empty answer leaves it open. */
const answerPoints = Effect.fn("@llm4ts/shell/Refine.answerPoints")(function* (
  options: RefineSessionOptions
) {
  const decisions = yield* loadDecisions(options.modDir)
  const domains = yield* loadDomains(options.modDir)
  const pendingDecisions = decisions.unansweredOpenPoints
  const pendingDomains = domains?.unansweredOpenPoints ?? []
  if (pendingDecisions.length + pendingDomains.length === 0) {
    yield* Console.log("no open points")
    return false
  }
  let answered = 0
  let nextDecisions = decisions
  for (const point of pendingDecisions) {
    const answer = yield* Prompt.run(
      Prompt.String({ message: `decisions.md ${point.number}. ${point.question}` })
    )
    if (answer.trim().length > 0) {
      answered += 1
      nextDecisions = Decisions.make({
        ...nextDecisions,
        openPoints: nextDecisions.openPoints.map((candidate) =>
          candidate.number === point.number ? { ...candidate, answer: answer.trim() } : candidate
        )
      })
    }
  }
  if (nextDecisions !== decisions) {
    yield* saveDecisions(options.modDir, nextDecisions)
  }
  if (domains !== undefined) {
    let nextDomains = domains
    for (const point of pendingDomains) {
      const answer = yield* Prompt.run(
        Prompt.String({ message: `domains.md ${point.number}. ${point.question}` })
      )
      if (answer.trim().length > 0) {
        answered += 1
        nextDomains = Domains.make({
          ...nextDomains,
          openPoints: nextDomains.openPoints.map((candidate) =>
            candidate.number === point.number ? { ...candidate, answer: answer.trim() } : candidate
          )
        })
      }
    }
    if (nextDomains !== domains) {
      yield* saveDomains(options.modDir, nextDomains)
    }
  }
  yield* Console.log(`${answered} answer(s) recorded — run modernize-refine to apply them`)
  return answered > 0
})

const approveOverlays = Effect.fn("@llm4ts/shell/Refine.approveOverlays")(function* (
  options: RefineSessionOptions
) {
  const fs = yield* FileSystem
  const decisions = yield* loadDecisions(options.modDir)
  const domains = yield* loadDomains(options.modDir)
  const pending =
    decisions.unansweredOpenPoints.length + (domains?.unansweredOpenPoints.length ?? 0)
  if (pending > 0) {
    yield* Console.log(`${pending} open point(s) are still unanswered — answer them first`)
    return
  }
  const ok = yield* Prompt.run(
    Prompt.Confirm({
      message: "Approve the README, decisions.md, and domains.md as they are on disk?",
      initial: false
    })
  )
  if (!ok) {
    return
  }
  for (const file of ["README.md", "decisions.md", "domains.md"]) {
    const path = `${options.modDir}/${file}`
    const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => undefined))
    if (text !== undefined) {
      yield* fs.writeFileString(path, approveMarkdown(text))
    }
  }
  yield* Console.log("approved — commit the pack and run the seed phase")
})

/**
 * The interactive loop. Each beat writes the files and returns to the menu;
 * Ctrl-C inside a prompt returns to the menu rather than crashing.
 */
export const refineSession = Effect.fn("@llm4ts/shell/Refine.session")(function* (
  options: RefineSessionOptions
) {
  const fs = yield* FileSystem
  const inventory = yield* scanPack(options.modDir)
  if (inventory.programs.length === 0) {
    yield* Console.error(`no spec pack under ${options.modDir}/specs — run modernize-extract first`)
    return
  }
  while (true) {
    const decisions = yield* loadDecisions(options.modDir)
    const domains = yield* loadDomains(options.modDir)
    const pending =
      decisions.unansweredOpenPoints.length + (domains?.unansweredOpenPoints.length ?? 0)
    const summary =
      `${inventory.programs.length} program(s) · ${decisions.programs.length} program and ` +
      `${decisions.scenarios.length} scenario decision(s) · ${decisions.marks.length} mark(s) · ` +
      `${decisions.pendingDeepen.length} deepen pending · ` +
      `${domains === undefined ? "no domain map" : `${domains.features.length} domain feature(s)`} · ` +
      `${pending} open point(s)`
    const action = yield* Prompt.run(
      Prompt.Select<Action>({
        message: `refine — ${summary}`,
        choices: [
          { title: "Mark programs", value: "programs" },
          { title: "Mark scenarios", value: "scenarios" },
          { title: "Deepen a program", value: "deepen" },
          { title: "Run modernize-refine", value: "run" },
          { title: "Answer open points", value: "answer" },
          { title: "Regroup (discard domains.md and rebuild it)", value: "regroup" },
          { title: "Approve the overlays", value: "approve" },
          { title: "Exit", value: "exit" }
        ]
      })
    ).pipe(Effect.catchTag("QuitError", () => Effect.succeed<Action>("exit")))
    const beat = Effect.gen(function* () {
      switch (action) {
        case "programs": {
          yield* saveDecisions(options.modDir, yield* markPrograms(options, inventory, decisions))
          return
        }
        case "scenarios": {
          yield* saveDecisions(options.modDir, yield* markScenarios(options, inventory, decisions))
          return
        }
        case "deepen": {
          yield* saveDecisions(options.modDir, yield* markDeepen(inventory, decisions))
          return
        }
        case "run":
        case "regroup": {
          if (action === "regroup") {
            const ok = yield* Prompt.run(
              Prompt.Confirm({
                message: "Discard domains.md and regroup from the current specs and decisions?",
                initial: false
              })
            )
            if (!ok) {
              return
            }
          }
          if (decisions.isEmpty && !(yield* fs.exists(`${options.modDir}/decisions.md`))) {
            // An empty overlay still lands with its guide, so the next hand-edit has the vocabulary.
            yield* saveDecisions(options.modDir, decisions)
          }
          const code = yield* options.launch(action === "regroup" ? { LLM4TS_REGROUP: "1" } : {})
          if (code !== 0) {
            yield* Console.log(
              `modernize-refine exited with code ${code} — answer any open points it listed, or fix the files`
            )
          }
          return
        }
        case "answer": {
          yield* answerPoints(options)
          return
        }
        case "approve": {
          yield* approveOverlays(options)
          return
        }
        case "exit": {
          return
        }
      }
    })
    if (action === "exit") {
      return
    }
    yield* beat.pipe(
      Effect.catchTag("QuitError", () => Effect.void),
      Effect.catch((error) => Console.error(error instanceof Error ? error.message : String(error)))
    )
  }
})
