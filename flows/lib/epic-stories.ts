// Shared core of the epic-stories flow (ADR 0013): the operator flags, the
// story-plan generator prompt and schema, the story judge, the gate runner,
// and seat selection. The executor itself is `@llm4ts/flow/Stories`.
import { readdir, rm, stat } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Dimension, Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { TokenUsage, type JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { cap } from "@llm4ts/flow/Context"
import type { LedgerBrief } from "@llm4ts/flow/CoverageLedger"
import {
  parseEpicBrief,
  renderEpicBrief,
  unanswered,
  type BriefStatus
} from "@llm4ts/flow/EpicBrief"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import {
  EpicBriefInvalid,
  EpicBriefNotApproved,
  EpicCheckoutDirty,
  LandingFailed,
  RefineRefused,
  type FlowError
} from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { nodePreflight } from "@llm4ts/flow/NodePreflight"
import { statusPaths } from "@llm4ts/flow/GitTool"
import { EpicLanded, EpicLandedVersion, landedPath } from "@llm4ts/flow/Landing"
import {
  RefineProposal,
  assembleRound,
  countNotPlanned,
  earlierStories,
  refineProposalJsonSchema,
  renderNotPlanned,
  roundPrefix,
  roundRepair,
  runAction,
  type EarlierStory,
  type NotPlanned,
  type RoundProgress
} from "@llm4ts/flow/RefineRound"
import { EpicRun, appendEpicRun, readEpicRuns } from "@llm4ts/flow/EpicRuns"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { BlockedVerdict, StoryState, StoryStateVersion, StoryVerdict } from "@llm4ts/flow/Stories"
import { stableHash } from "@llm4ts/flow/Plan"
import { ReviewIssue } from "@llm4ts/flow/Review"
import {
  StoryPlan,
  dependenciesOf,
  makeStoryPlanStore,
  parseStoryPlan,
  pathsNamedIn,
  type Story
} from "@llm4ts/flow/StoryPlan"
import * as Clock from "effect/Clock"
import * as Console from "effect/Console"
import { CliConnectorConfig, type ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { budget } from "@llm4ts/flow/Context"
import { makeLocalBoardSync } from "@llm4ts/flow/BoardSync"
import { estimatedUsageOptionsFromEnv, makeEstimatedUsageMeter } from "@llm4ts/flow/EstimatedUsage"
import { landEpic } from "@llm4ts/flow/Landing"
import { implementStoriesFlow, type StoriesOptions, type StorySeats } from "@llm4ts/flow/Stories"
import { validateStoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  asReadOnly,
  nodePlainFileStore,
  nodeProcessExecutor,
  resolveFlowInput,
  runNode,
  stage,
  withModel
} from "@llm4ts/runner"
import { claude, coderIds, judgmentConnectorFromEnvironment, pi } from "@llm4ts/runner/Connectors"
import {
  FlowAborted,
  FlowLlmError,
  ReviewResult,
  ScriptUsage,
  coderFor,
  lintCommand,
  mergeReviewResults
} from "@llm4ts/runner"

// ---- Flags ------------------------------------------------------------------

export interface EpicArgs {
  readonly planOnly: boolean
  readonly failFast: boolean
  readonly concurrency: number | undefined
  /** `--land[=branch]`: land the finished epic on that branch (default main) and stop. */
  readonly land: string | undefined
  /** `--keep-worktrees`: after landing, keep the story worktrees and branches. */
  readonly keepWorktrees: boolean
  /** `--list`: list the epics in this repository and stop. */
  readonly list: boolean
  /** `--epic <id>`: work on this existing epic, by folder name or plan id, without its text. */
  readonly epic: string | undefined
  /** `--refine`: the text is feedback on the finished epic, planned as a round of follow-up stories. */
  readonly refine: boolean
  /** Everything else, for `resolveFlowInput` (`--repo`, the epic text). */
  readonly rest: ReadonlyArray<string>
}

export const epicUsage = [
  "epic-stories flags:",
  "  --plan-only         write (or re-validate) the story plan and stop",
  "  --land[=<branch>]   land the finished epic on <branch> (default main): merge the branch in,",
  "                      let the coder fix conflicts and red gates (3 rounds), then merge;",
  "                      afterwards the story worktrees and merged story branches go",
  "  --keep-worktrees    with --land: keep the story worktrees and branches",
  "  --list              list this repository's epics (id, stories merged, landed) and stop",
  "  --epic <id>         work on an existing epic by id, no text needed. Without text or",
  "                      --epic, the one epic not landed yet is chosen; several stop the run",
  "  --refine            the text is feedback on the finished epic: plan a round of follow-up",
  "                      stories from it and run them on the epic branch (before landing).",
  "                      A plain rerun finishes an open round; --plan-only stops after planning",
  "  --concurrency <n>   stories implemented at once (default 3)",
  "  --fail-fast         stop the epic at the first failed story",
  "Seats: LLM4TS_REASONER (claude|gemini|…, default claude) splits, reviews, judges;",
  "       LLM4TS_CODER (default pi) implements; LLM4TS_REASONING_MODEL / LLM4TS_CODER_MODEL",
  "       pick their models (pi: provider/model); LLM4TS_CODER_FLAGS / LLM4TS_REASONING_FLAGS",
  "       add CLI flags (key=value;key=value). LLM4TS_GATES overrides the gate commands",
  "       (default: those of pnpm typecheck|lint|test|build the app's package.json defines);",
  "       LLM4TS_WORKTREE_SETUP (default: pnpm install --offline) prepares each worktree;",
  "       LLM4TS_WORKTREE_ROOT (default: <repo>.worktrees beside the repository) holds them;",
  "       LLM4TS_APP_DIR (e.g. frontend) runs setup and gates in that subfolder; unset, a",
  "       repository without a root package.json uses its one subfolder that has one;",
  "       LLM4TS_SETUP_AGENT=1 gives the coder one turn to fix a failed setup, then reruns it;",
  "       LLM4TS_CODER_HEALTH_URL is polled after the coder's serving engine goes down."
].join("\n")

/** The flow's own flags, taken out before the shared `--repo`/prompt parsing sees the rest. */
export const parseEpicArgs = (argv: ReadonlyArray<string>): Effect.Effect<EpicArgs, ScriptUsage> =>
  Effect.gen(function* () {
    let planOnly = false
    let failFast = false
    let concurrency: number | undefined
    let land: string | undefined
    let keepWorktrees = false
    let list = false
    let refine = false
    let epic: string | undefined
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index] ?? ""
      if (argument === "--plan-only") {
        planOnly = true
      } else if (argument === "--fail-fast") {
        failFast = true
      } else if (argument === "--keep-worktrees") {
        keepWorktrees = true
      } else if (argument === "--list") {
        list = true
      } else if (argument === "--refine") {
        refine = true
      } else if (argument === "--epic" || argument.startsWith("--epic=")) {
        const value = argument.includes("=") ? argument.slice("--epic=".length) : argv[index + 1]
        if (!argument.includes("=")) {
          index += 1
        }
        if (value === undefined || value.trim().length === 0 || value.startsWith("--")) {
          return yield* ScriptUsage.make({ message: `--epic needs an epic id\n${epicUsage}` })
        }
        epic = value.trim()
      } else if (argument === "--land" || argument.startsWith("--land=")) {
        // `--land=<branch>`, never a separate word: the epic text may follow.
        const branch = argument.includes("=") ? argument.slice("--land=".length).trim() : "main"
        if (branch.length === 0) {
          return yield* ScriptUsage.make({ message: `--land= needs a branch name\n${epicUsage}` })
        }
        land = branch
      } else if (argument === "--concurrency" || argument.startsWith("--concurrency=")) {
        const raw = argument.includes("=")
          ? argument.slice("--concurrency=".length)
          : argv[index + 1]
        if (!argument.includes("=")) {
          index += 1
        }
        const parsed = Number.parseInt(raw ?? "", 10)
        if (!Number.isInteger(parsed) || parsed < 1) {
          return yield* ScriptUsage.make({
            message: `--concurrency requires a positive integer\n${epicUsage}`
          })
        }
        concurrency = parsed
      } else {
        rest.push(argument)
      }
    }
    return { planOnly, failFast, concurrency, land, keepWorktrees, list, epic, refine, rest }
  })

// ---- Epics in a repository ---------------------------------------------------------

/** One epic under `.llm4ts/epics/`, as `--list` shows it. */
export interface EpicSummary {
  /** The state folder's name: the epic's text as a slug plus a hash of it. */
  readonly dir: string
  readonly stateDir: string
  /** The plan's own id (`epic/<epicId>` is its branch). */
  readonly epicId: string
  readonly epic: string
  readonly stories: number
  readonly merged: number
  /** The branch it landed on, once it has. */
  readonly landed: string | undefined
  /** Its refine rounds (ADR 0021), in order. */
  readonly rounds: ReadonlyArray<RoundOnDisk>
}

/** One refine round of an epic as its folder holds it. */
export interface RoundOnDisk {
  readonly round: number
  /** `<epic state>/rounds/<n>`: the round's plan, story states, board and report. */
  readonly stateDir: string
  readonly plan: StoryPlan | undefined
  readonly merged: number
  /** Feedback items the planner left out. */
  readonly notPlanned: number
  /** Why the plan cannot be used, naming the file. */
  readonly unreadable: string | undefined
}

export const roundDir = (stateDir: string, round: number): string =>
  join(stateDir, "rounds", String(round))

const mergedStories = (files: PlainFileStoreShape, stateDir: string, plan: StoryPlan) =>
  Effect.gen(function* () {
    let merged = 0
    for (const story of plan.stories) {
      const state = yield* loadVersioned(
        files,
        join(stateDir, "stories", `${story.id}.json`),
        StoryStateVersion,
        StoryState
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (state?.status === "merged") {
        merged += 1
      }
    }
    return merged
  })

/**
 * The epic's rounds, numbered from 1 without gaps: the first `rounds/<n>`
 * without a plan ends the list. A plan that does not parse, or breaks the
 * plan's rules, is a round that cannot be used, never one silently skipped.
 */
export const loadRounds = (
  files: PlainFileStoreShape,
  stateDir: string
): Effect.Effect<ReadonlyArray<RoundOnDisk>, FlowError> =>
  Effect.gen(function* () {
    const rounds: Array<RoundOnDisk> = []
    for (let round = 1; ; round += 1) {
      const dir = roundDir(stateDir, round)
      const path = join(dir, "plan.md")
      const text = yield* files.read(path)
      if (text === undefined) {
        // A plan missing while the next round has one is a hole, not the end.
        if ((yield* files.read(join(roundDir(stateDir, round + 1), "plan.md"))) === undefined) {
          return rounds
        }
        rounds.push({
          round,
          stateDir: dir,
          plan: undefined,
          merged: 0,
          notPlanned: 0,
          unreadable: `${path} is missing while round ${round + 1} exists`
        })
        continue
      }
      const notPlanned = countNotPlanned((yield* files.read(join(dir, "not-planned.md"))) ?? "")
      const parsed = yield* Effect.result(
        parseStoryPlan(text).pipe(Effect.flatMap(validateStoryPlan))
      )
      if (Result.isSuccess(parsed)) {
        rounds.push({
          round,
          stateDir: dir,
          plan: parsed.success,
          merged: yield* mergedStories(files, dir, parsed.success),
          notPlanned,
          unreadable: undefined
        })
      } else {
        rounds.push({
          round,
          stateDir: dir,
          plan: undefined,
          merged: 0,
          notPlanned,
          unreadable: `${path}: ${parsed.failure.message}`
        })
      }
    }
  })

/** The rounds as the run decision reads them. */
export const roundProgress = (rounds: ReadonlyArray<RoundOnDisk>): ReadonlyArray<RoundProgress> =>
  rounds.map((round) => ({
    round: round.round,
    stories: round.plan?.stories.length ?? 0,
    merged: round.merged,
    ...(round.unreadable === undefined ? {} : { unreadable: round.unreadable })
  }))

const renderRound = (round: RoundOnDisk): string =>
  round.plan === undefined
    ? `round ${round.round}: unreadable plan`
    : `round ${round.round}: ${round.merged}/${round.plan.stories.length} merged${
        round.notPlanned === 0 ? "" : `, ${round.notPlanned} not planned`
      }`

export const epicsDir = (workDir: string): string => join(workDir, ".llm4ts", "epics")

/** Every epic with a plan in this repository, oldest folder name first. */
export const listEpics = (
  files: PlainFileStoreShape,
  workDir: string
): Effect.Effect<ReadonlyArray<EpicSummary>, FlowError> =>
  Effect.gen(function* () {
    const root = epicsDir(workDir)
    const entries = yield* Effect.tryPromise(() => readdir(root, { withFileTypes: true })).pipe(
      Effect.catch(() => Effect.succeed([]))
    )
    const store = makeStoryPlanStore(files)
    const summaries: Array<EpicSummary> = []
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) {
        continue
      }
      const stateDir = join(root, entry.name)
      const plan = yield* store
        .load(join(stateDir, "plan.md"))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (plan === undefined) {
        continue
      }
      const merged = yield* mergedStories(files, stateDir, plan)
      const landed = yield* loadVersioned(
        files,
        landedPath(stateDir),
        EpicLandedVersion,
        EpicLanded
      ).pipe(Effect.catch(() => Effect.succeed(undefined)))
      summaries.push({
        dir: entry.name,
        stateDir,
        epicId: plan.epicId,
        epic: plan.epic,
        stories: plan.stories.length,
        merged,
        landed: landed?.target,
        // Rounds that cannot be read are reported, never dropped: an epic
        // must not look free of rounds when it lands.
        rounds: yield* loadRounds(files, stateDir).pipe(
          Effect.catch((error) =>
            Effect.succeed<ReadonlyArray<RoundOnDisk>>([
              {
                round: 1,
                stateDir: roundDir(stateDir, 1),
                plan: undefined,
                merged: 0,
                notPlanned: 0,
                unreadable: `${join(stateDir, "rounds")}: ${error.message}`
              }
            ])
          )
        )
      })
    }
    return summaries
  })

export const renderEpicList = (epics: ReadonlyArray<EpicSummary>): string =>
  epics.length === 0
    ? "no epics in this repository yet: give an epic's text to plan one"
    : [
        `epics (${epics.length}):`,
        ...epics.flatMap((epic) => [
          `- ${epic.epicId} · ${epic.merged}/${epic.stories} stories merged · ${
            epic.landed === undefined
              ? epic.merged === epic.stories
                ? "finished, not landed"
                : "in progress"
              : `landed on ${epic.landed}`
          }${epic.rounds.map((round) => ` · ${renderRound(round)}`).join("")}  (--epic ${epic.epicId})`,
          `  "${epic.epic.length > 110 ? `${epic.epic.slice(0, 109)}…` : epic.epic}"`
        ])
      ].join("\n")

/** Which epic a run works on. */
export type EpicChoice =
  | { readonly _tag: "Text"; readonly prompt: string }
  | { readonly _tag: "Existing"; readonly epic: EpicSummary }
  /** A folder `epic-design` wrote a brief into, not planned yet. */
  | { readonly _tag: "Brief"; readonly dir: string; readonly request: string }

/** An epic folder holding a brief (`epic-design`), whatever its plan's state. */
export interface BriefSummary {
  readonly dir: string
  readonly request: string
  readonly status: BriefStatus
}

/** The names of the epic folders of a repository. */
export const epicDirs = (workDir: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise(() => readdir(epicsDir(workDir), { withFileTypes: true })).pipe(
    Effect.map(
      (entries): ReadonlyArray<string> =>
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
    ),
    Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([]))
  )

/** The briefs among `dirs`; a folder without one, or with one that does not parse, is skipped. */
export const listBriefs = (
  files: PlainFileStoreShape,
  workDir: string,
  dirs: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<BriefSummary>, FlowError> =>
  Effect.gen(function* () {
    const briefs: Array<BriefSummary> = []
    for (const dir of dirs) {
      const text = yield* files.read(join(epicsDir(workDir), dir, "brief.md"))
      if (text === undefined) continue
      const brief = yield* parseEpicBrief(text).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (brief !== undefined) briefs.push({ dir, request: brief.request, status: brief.status })
    }
    return briefs
  })

/**
 * Every brief of the repository, parsed, for the coverage ledger. A folder
 * without a brief is skipped; a brief that does not parse is reported with
 * the first thing wrong in it, never dropped silently.
 */
export const loadBriefs = (
  files: PlainFileStoreShape,
  workDir: string,
  dirs: ReadonlyArray<string>
): Effect.Effect<
  {
    readonly briefs: ReadonlyArray<LedgerBrief>
    readonly unreadable: ReadonlyArray<{ readonly dir: string; readonly reason: string }>
  },
  FlowError
> =>
  Effect.gen(function* () {
    const briefs: Array<LedgerBrief> = []
    const unreadable: Array<{ readonly dir: string; readonly reason: string }> = []
    for (const dir of dirs) {
      const path = join(epicsDir(workDir), dir, "brief.md")
      const text = yield* files.read(path)
      if (text === undefined) continue
      const parsed = yield* Effect.result(parseEpicBrief(text, path))
      if (Result.isSuccess(parsed)) {
        briefs.push({ epicId: dir, brief: parsed.success })
      } else {
        unreadable.push({ dir, reason: parsed.failure.violations[0] ?? "does not parse" })
      }
    }
    return { briefs, unreadable }
  })

/**
 * What the story planner reads in place of the one-line epic: the approved
 * brief in the epic's folder. Undefined when the plan is already written (the
 * brief has done its job) or there is no brief. A draft, or an approved brief
 * with an unanswered open point, stops the run: planning from the bare
 * sentence beside an unfinished brief would silently ignore it.
 */
export const plannerInput = (
  files: PlainFileStoreShape,
  stateDir: string,
  planPath: string
): Effect.Effect<string | undefined, FlowError> =>
  Effect.gen(function* () {
    if ((yield* files.read(planPath)) !== undefined) return undefined
    const path = join(stateDir, "brief.md")
    const text = yield* files.read(path)
    if (text === undefined) return undefined
    const brief = yield* parseEpicBrief(text, path)
    if (brief.status !== "approved") {
      return yield* EpicBriefNotApproved.make({ path })
    }
    const pending = unanswered(brief)
    if (pending.length > 0) {
      return yield* EpicBriefInvalid.make({
        path,
        violations: [
          `the brief is approved with unanswered open points: ${pending.map((point) => point.number).join(", ")}`
        ]
      })
    }
    return renderEpicBrief(brief)
  })

/**
 * The epic text given wins (a new epic, or the existing one with that exact
 * text); `--epic` picks an existing one; with neither, the one epic not yet
 * landed is chosen. Several candidates, or none left, stop the run with the
 * list — never a silent guess. With no epic at all, the flow's default text.
 */
export const chooseEpic = (args: {
  readonly text: string
  readonly epic: string | undefined
  readonly epics: ReadonlyArray<EpicSummary>
  /** Folders with a brief; one with no plan yet is reachable by `--epic`. */
  readonly briefs?: ReadonlyArray<BriefSummary>
  readonly defaultEpic: string
}): Effect.Effect<EpicChoice, ScriptUsage> => {
  if (args.epic !== undefined) {
    const found = args.epics.find((epic) => epic.dir === args.epic || epic.epicId === args.epic)
    const brief = (args.briefs ?? []).find((candidate) => candidate.dir === args.epic)
    if (found === undefined && brief !== undefined) {
      return Effect.succeed({ _tag: "Brief", dir: brief.dir, request: brief.request })
    }
    return found === undefined
      ? Effect.fail(
          ScriptUsage.make({
            message: `no epic '${args.epic}' in this repository\n${renderEpicList(args.epics)}`
          })
        )
      : Effect.succeed({ _tag: "Existing", epic: found })
  }
  if (args.text.trim().length > 0) {
    return Effect.succeed({ _tag: "Text", prompt: args.text })
  }
  const open = args.epics.filter((epic) => epic.landed === undefined)
  // A folder `epic-design` wrote a brief into and nobody planned yet is an open
  // epic too: alone it is the one to run, beside others it is never guessed.
  const planned = new Set(args.epics.map((epic) => epic.dir))
  const briefOnly = (args.briefs ?? []).filter((brief) => !planned.has(brief.dir))
  const [onlyBrief] = briefOnly
  if (briefOnly.length === 1 && open.length === 0 && onlyBrief !== undefined) {
    return Effect.succeed({ _tag: "Brief", dir: onlyBrief.dir, request: onlyBrief.request })
  }
  if (briefOnly.length > 0) {
    return Effect.fail(
      ScriptUsage.make({
        message: [
          "several epics are open here; pick one with --epic <id>, or give an epic's text",
          ...(open.length === 0 ? [] : [renderEpicList(open)]),
          ...briefOnly.map((brief) => `${brief.dir}  brief ${brief.status}  ${brief.request}`)
        ].join("\n")
      })
    )
  }
  if (open.length === 1 && open[0] !== undefined) {
    return Effect.succeed({ _tag: "Existing", epic: open[0] })
  }
  if (open.length > 1) {
    return Effect.fail(
      ScriptUsage.make({
        message: `several epics are open here; pick one with --epic <id>, or give an epic's text\n${renderEpicList(open)}`
      })
    )
  }
  if (args.epics.length > 0) {
    return Effect.fail(
      ScriptUsage.make({
        message: `every epic here has landed; give the new epic's text to plan it\n${renderEpicList(args.epics)}`
      })
    )
  }
  return Effect.succeed({ _tag: "Text", prompt: args.defaultEpic })
}

// ---- Seats --------------------------------------------------------------------

/** The reasoning seat: `LLM4TS_REASONER`, any coder id, default claude. Unknown names fail typed. */
export const reasonerFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<CliConnectorConfig, ScriptUsage> => {
  const requested = (environment.LLM4TS_REASONER ?? "").trim()
  if (requested.length === 0) {
    return Effect.succeed(claude)
  }
  const preset = coderFor(requested)
  return preset === undefined
    ? ScriptUsage.make({
        message: `unknown LLM4TS_REASONER '${requested}'; expected ${coderIds.join("|")}`
      })
    : Effect.succeed(preset)
}

/** The coder seat: `LLM4TS_CODER`, default pi — the cheap local typist under a stronger orchestrator. */
export const storyCoderFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<CliConnectorConfig, ScriptUsage> => {
  const requested = (environment.LLM4TS_CODER ?? "").trim()
  if (requested.length === 0) {
    return Effect.succeed(pi)
  }
  const preset = coderFor(requested)
  return preset === undefined
    ? ScriptUsage.make({
        message: `unknown LLM4TS_CODER '${requested}'; expected ${coderIds.join("|")}`
      })
    : Effect.succeed(preset)
}

// ---- Seat flags and local servers --------------------------------------------------

/**
 * `LLM4TS_CODER_FLAGS` / `LLM4TS_REASONING_FLAGS`: extra CLI flags for a seat as
 * `key=value;key=value` (a bare `key` is a boolean flag). The first `=` splits, so
 * a value may itself carry `=`: `config=model_provider=lmstudio` is codex's
 * `--config model_provider=lmstudio`.
 */
export const flagsFromEnvironment = (raw: string | undefined): Readonly<Record<string, string>> => {
  const flags: Record<string, string> = {}
  for (const part of (raw ?? "").split(";")) {
    const entry = part.trim()
    if (entry.length === 0) {
      continue
    }
    const at = entry.indexOf("=")
    if (at < 0) {
      flags[entry] = ""
    } else {
      flags[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
    }
  }
  return flags
}

/**
 * The local single-model server a coder seat points at, if any: pi's
 * `lmstudio/…` and `ollama/…` model specs, codex's `--config model_provider=lmstudio`,
 * a claude seat with `ANTHROPIC_BASE_URL` on a loopback host. Such a server serves
 * one generation at a time, so parallel coders queue and a queued request is cut
 * off after a few minutes — the flow warns when concurrency is above one.
 */
export const localCoderServer = (
  model: string | undefined,
  flags: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const spec = (model ?? "").trim().toLowerCase()
  for (const provider of ["lmstudio", "lm-studio", "ollama", "mlx"]) {
    if (spec.startsWith(`${provider}/`)) {
      return provider
    }
  }
  const configured = Object.entries(flags).find(
    ([key, value]) => key === "config" && /^model_provider=(lmstudio|ollama)/.test(value)
  )
  if (configured !== undefined) {
    return configured[1].slice("model_provider=".length)
  }
  const base = environment.ANTHROPIC_BASE_URL ?? environment.OPENAI_BASE_URL ?? ""
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(base)
    ? "local"
    : undefined
}

// ---- Worktrees and the serving engine -------------------------------------------

/**
 * Where an epic's story worktrees live: `LLM4TS_WORKTREE_ROOT/<epicId>`, by
 * default `<repo>.worktrees/<epicId>` BESIDE the repository. Nested inside
 * it, a coder's parent directory is the epic checkout, and coders cd there.
 */
export const worktreeRootFor = (
  workDir: string,
  epicId: string,
  environment: Readonly<Record<string, string | undefined>>
): string => {
  const configured = environment.LLM4TS_WORKTREE_ROOT?.trim()
  const root =
    configured === undefined || configured.length === 0
      ? `${workDir.replace(/[\\/]+$/, "")}.worktrees`
      : configured
  return join(root, epicId)
}

/**
 * The URL that answers when a local serving engine is up:
 * `LLM4TS_CODER_HEALTH_URL`, else the server's model list at its default
 * address. Undefined for a hosted provider — there is nothing to poll.
 */
export const serverHealthUrl = (
  server: string | undefined,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const configured = environment.LLM4TS_CODER_HEALTH_URL?.trim()
  if (configured !== undefined && configured.length > 0) {
    return configured
  }
  switch (server) {
    case "lmstudio":
    case "lm-studio":
      return "http://127.0.0.1:1234/v1/models"
    case "ollama":
      return "http://127.0.0.1:11434/api/tags"
    case "local": {
      const base = (environment.ANTHROPIC_BASE_URL ?? environment.OPENAI_BASE_URL ?? "")
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/v1$/, "")
      return base.length === 0 ? undefined : `${base}/v1/models`
    }
    default:
      return undefined
  }
}

/** Whether `url` answers 2xx within five seconds (the roster's health check). */
import { httpProbe } from "@llm4ts/runner/ExecutorRoster"
export { httpProbe }

export interface RecoveryTiming {
  readonly interval: Duration.Input
  readonly attempts: number
  /** Extra wait once the probe answers: an engine lists models before it can serve them. */
  readonly grace: Duration.Input
}

export const defaultRecoveryTiming: RecoveryTiming = {
  interval: "15 seconds",
  attempts: 60,
  grace: "30 seconds"
}

/**
 * The executor's `awaitRecovery`: polls `probe` until the engine answers
 * (then waits the grace period), or fails after `attempts`. Without a probe
 * (a hosted provider) it waits one interval-times-eight and lets the retry
 * find out.
 */
export const awaitServer =
  (
    probe: Effect.Effect<boolean> | undefined,
    events: FlowEventsShape,
    timing: RecoveryTiming = defaultRecoveryTiming
  ) =>
  (reason: string): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      yield* events.publish(
        Info.make({ message: `⏸ waiting for the coder's serving engine to recover: ${reason}` })
      )
      if (probe === undefined) {
        yield* Effect.sleep(Duration.times(Duration.fromInputUnsafe(timing.interval), 8))
        return
      }
      for (let attempt = 0; attempt < timing.attempts; attempt += 1) {
        if (yield* probe) {
          yield* Effect.sleep(timing.grace)
          yield* events.publish(
            Info.make({ message: "▶ the coder's serving engine answers again" })
          )
          return
        }
        yield* Effect.sleep(timing.interval)
      }
      return yield* FlowAborted.make({
        message: `the coder's serving engine did not answer after ${timing.attempts} probes`
      })
    })

// ---- BLOCKED_ON second opinion ----------------------------------------------------

export const blockedVerdictJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    real: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["real", "reason"]
}

const excerptLimit = 6_000

/**
 * The executor's `verifyBlocked`: the reasoning seat reads the claim, the
 * plan, and the named files as they are in the story's worktree, and decides
 * whether the plan really has a gap. Only claims the plan alone cannot
 * settle reach it.
 */
export const verifyBlockedOn =
  (
    reasoning: LlmServiceShape,
    events: FlowEventsShape,
    files: PlainFileStoreShape,
    plan: StoryPlan
  ) =>
  (story: Story, need: string, workDir: string): Effect.Effect<BlockedVerdict, FlowError> =>
    Effect.gen(function* () {
      const excerpts: Array<string> = []
      for (const path of pathsNamedIn(plan, need).slice(0, 4)) {
        const text = yield* files
          .read(join(workDir, path))
          .pipe(Effect.catch(() => Effect.succeed("(a directory, or unreadable)")))
        excerpts.push(
          `### ${path}`,
          text === undefined ? "(does not exist in the working tree)" : cap(text, excerptLimit).text
        )
      }
      const others = plan.stories
        .filter((other) => other.id !== story.id)
        .map(
          (other) =>
            `- ${other.id} (depends on: ${other.dependsOn.join(", ") || "nothing"}) owns ${other.owned.join(", ")}; provides ${other.provides.join("; ")}`
        )
      const prompt = [
        "A coding agent implementing ONE story of a parallel epic stopped and claimed it is blocked",
        "on work another story owns. Decide whether the claim is REAL.",
        "",
        "It is real only when the needed work is absent from the agent's working tree, is not",
        "within its own owned paths, and no story it depends on provides it: the plan has a gap.",
        "It is NOT real when the thing exists (perhaps in another file or under another name), when",
        "the agent can build it inside its owned paths, when a later story owns it, or when the",
        "problem is tooling or a type error the agent can fix itself.",
        "",
        `Story ${story.id}: ${story.title}`,
        story.description,
        `Depends on: ${story.dependsOn.join(", ") || "nothing"}`,
        `Owns: ${story.owned.join(", ")}`,
        `Reads: ${story.sharedReadOnly.join(", ") || "nothing"}`,
        "",
        "The other stories:",
        ...others,
        "",
        `The claim: BLOCKED_ON: ${need}`,
        "",
        "The paths the claim names, as they are in the agent's working tree:",
        ...(excerpts.length === 0 ? ["(the claim names no repository path)"] : excerpts),
        "",
        'Respond only with JSON: {"real": true|false, "reason": "..."}. The reason is shown to the',
        "agent when the claim is rejected: say concretely where to look or what to do."
      ].join("\n")
      return yield* structuredAndPublish(
        reasoning,
        events,
        prompt,
        BlockedVerdict,
        blockedVerdictJsonSchema
      )
    })

// ---- Story plan generation -----------------------------------------------------

/** A readable, stable epic id: the first words of the epic plus a content hash. */
export const epicIdFor = (epic: string): string => {
  const slug = epic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter((part) => part.length > 0)
    .slice(0, 4)
    .join("-")
  return `${slug.length === 0 ? "epic" : slug}-${stableHash(epic).slice(0, 6)}`
}

export const storyPlanJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    epicId: { type: "string" },
    epic: { type: "string" },
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          owned: { type: "array", items: { type: "string" } },
          sharedReadOnly: { type: "array", items: { type: "string" } },
          provides: { type: "array", items: { type: "string" } }
        },
        required: ["id", "title", "description", "dependsOn", "owned", "sharedReadOnly", "provides"]
      }
    }
  },
  required: ["epicId", "epic", "stories"]
}

/** The generator's hard constraints — the perimeter rules the executor will enforce. */
export const storyPlanInstructions = (epicId: string, guidance: string): string =>
  [
    "You are the orchestrator of a parallel implementation. Split the epic below into stories",
    "that independent coding agents will implement AT THE SAME TIME, each in its own git worktree,",
    "each confined to the paths it owns. Dependencies are declared here and never discovered later.",
    "",
    "Rules (violations are rejected mechanically):",
    "- Every story has a kebab-case id, a title, a description precise enough to implement alone,",
    "  `dependsOn` (ids it must wait for), `owned` (repo-relative path prefixes it may create or",
    "  change), `sharedReadOnly` (prefixes it may read but never change), and `provides` (routes,",
    "  exports, contracts other stories may rely on).",
    "- `owned` sets are pairwise DISJOINT: no path prefix appears under two stories.",
    "- Shared surfaces (the kit, the theme, house rules) are never edited by a feature story. A new",
    "  shared component is its own story, and every story using it depends on it.",
    "- Every new service domain is its own contract story (contract + fake routes) that the pages",
    "  depend on.",
    "- Exactly ONE story owns the composition point (`src/App.tsx`): the fan-in that depends on",
    "  every screen story and wires them in.",
    "- A story fits one agent session: one screen, one contract, or one component.",
    "- Every story OWNS the test files it must write (the judge asks for tests): list them",
    "  in `owned` explicitly — a story cannot add a test outside its owned paths.",
    `- Use exactly this epicId: "${epicId}". Copy the epic text into "epic".`,
    "",
    "Respond only with JSON:",
    '{"epicId":"...","epic":"...","stories":[{"id":"...","title":"...","description":"...",',
    '"dependsOn":[],"owned":[],"sharedReadOnly":[],"provides":[]}]}',
    "",
    "Target repository guidance (house rules and layout — the vocabulary to use):",
    guidance
  ].join("\n")

export const generateStoryPlan = (
  reasoning: LlmServiceShape,
  events: FlowEventsShape,
  epic: string,
  epicId: string,
  guidance: string,
  /** An approved epic brief (`epic-design`): what the planner reads in place of the sentence. */
  brief?: string
): Effect.Effect<StoryPlan, FlowLlmError> =>
  structuredAndPublish(
    reasoning,
    events,
    `${storyPlanInstructions(epicId, guidance)}\n\nEpic:\n${brief ?? epic}`,
    StoryPlan,
    storyPlanJsonSchema
  ).pipe(
    // The id and the epic text are ours, whatever the model echoed back.
    Effect.map((plan) => StoryPlan.make({ ...plan, epicId, epic }))
  )

// ---- Refine rounds (ADR 0021) ---------------------------------------------------

export interface RefinePlanInputs {
  readonly epicId: string
  readonly round: number
  readonly guidance: string
  /** Every story merged before this round: what was built, and where. */
  readonly earlier: ReadonlyArray<EarlierStory>
  /** The epic's brief, when it has one. */
  readonly brief?: string
  /** The previous round's not-planned list. */
  readonly openItems?: string
}

/** The round planner's constraints: the story planner's, for feedback on finished work. */
export const refinePlanInstructions = (inputs: RefinePlanInputs): string =>
  [
    "You are the orchestrator of a parallel implementation. The epic below is finished: every",
    "story is merged into the epic branch, which is checked out in front of you. A person tried",
    "it and gave the feedback at the end of this message. Turn the feedback into follow-up",
    "stories that independent coding agents will implement AT THE SAME TIME, each in its own git",
    "worktree, each confined to the paths it owns. Read the code before you answer.",
    "",
    "Rules (violations are rejected mechanically):",
    "- Every story has a kebab-case id, a title, a description precise enough to implement alone,",
    "  `dependsOn`, `owned` (repo-relative paths it may create or change), `sharedReadOnly`",
    "  (prefixes it may read but never change), and `provides`.",
    "- One story per feedback item, or per group of items that change the same files. The",
    "  description quotes the feedback items it answers, word for word.",
    "- `owned` lists the files the story will change, existing files included: name them from the",
    "  code. The earlier stories below are merged, so their paths are free to claim.",
    "- `owned` sets are pairwise DISJOINT within this round: items that need the same file go",
    "  into ONE story.",
    "- `dependsOn` names stories of THIS round only, and only when one needs the other's result.",
    "- `provides` says what the person who gave the feedback will see changed.",
    "- Tests that cover the changed behaviour are updated in the same story, and the test files",
    "  are in its `owned`.",
    "- Shared surfaces (the kit, the theme, house rules) are owned only by a story the feedback",
    "  asks to change them.",
    "- An item that is unclear, contradicts another item, or cannot be tied to a file is NOT",
    "  guessed: it goes to `notPlanned` with the question whose answer would make it plannable.",
    `- Ids are short; each is prefixed \`${roundPrefix(inputs.round)}\` for you (round ${inputs.round} of epic "${inputs.epicId}").`,
    "",
    "Respond only with JSON:",
    '{"stories":[{"id":"...","title":"...","description":"...","dependsOn":[],"owned":[],',
    '"sharedReadOnly":[],"provides":[]}],"notPlanned":[{"item":"...","reason":"..."}]}',
    "",
    "Earlier stories (merged: what was built, and where):",
    ...(inputs.earlier.length === 0
      ? ["(none)"]
      : inputs.earlier.map(
          (story) =>
            `- ${story.id}: ${story.title} — owns: ${story.owned.join(", ")} — provides: ${story.provides.join("; ")}`
        )),
    ...(inputs.brief === undefined ? [] : ["", "The epic's approved brief:", inputs.brief]),
    ...(inputs.openItems === undefined
      ? []
      : [
          "",
          "Left unplanned in the previous round (the new feedback may answer these):",
          inputs.openItems
        ]),
    "",
    "Target repository guidance (house rules and layout — the vocabulary to use):",
    inputs.guidance
  ].join("\n")

export const generateRefineProposal = (
  reasoning: LlmServiceShape,
  events: FlowEventsShape,
  inputs: RefinePlanInputs & { readonly feedback: string }
): Effect.Effect<RefineProposal, FlowLlmError> =>
  structuredAndPublish(
    reasoning,
    events,
    `${refinePlanInstructions(inputs)}\n\nFeedback:\n${inputs.feedback}`,
    RefineProposal,
    refineProposalJsonSchema
  )

export interface PlanRoundDeps {
  readonly files: PlainFileStoreShape
  readonly reasoning: LlmServiceShape
  readonly events: FlowEventsShape
  /** The epic's state folder. */
  readonly stateDir: string
  readonly epicId: string
  readonly round: number
  readonly feedback: string
  readonly guidance: string
  /** The epic's plan and every earlier round's. */
  readonly plans: ReadonlyArray<StoryPlan>
  readonly brief?: string
}

const bulletLines = (markdown: string): string =>
  markdown
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .join("\n")

/**
 * Plans a round from feedback and writes it: `feedback.md`, `plan.md`, and
 * `not-planned.md` when something was left out. Nothing is written unless the
 * plan is valid, and no round is created when no story could be planned.
 */
export const planRound = Effect.fn("flows/epic-stories.planRound")(function* (
  deps: PlanRoundDeps
): Effect.fn.Return<
  { readonly plan: StoryPlan | undefined; readonly notPlanned: ReadonlyArray<NotPlanned> },
  FlowError
> {
  const open =
    deps.round > 1
      ? bulletLines(
          (yield* deps.files.read(
            join(roundDir(deps.stateDir, deps.round - 1), "not-planned.md")
          )) ?? ""
        )
      : ""
  const earlier = earlierStories(deps.plans)
  const proposal = yield* generateRefineProposal(deps.reasoning, deps.events, {
    epicId: deps.epicId,
    round: deps.round,
    guidance: deps.guidance,
    earlier,
    feedback: deps.feedback,
    ...(deps.brief === undefined ? {} : { brief: deps.brief }),
    ...(open.length === 0 ? {} : { openItems: open })
  })
  if (proposal.stories.length === 0) {
    return { plan: undefined, notPlanned: proposal.notPlanned }
  }
  const plan = yield* validateStoryPlan(
    assembleRound({
      epicId: deps.epicId,
      round: deps.round,
      feedback: deps.feedback,
      proposal,
      earlier: earlier.map((story) => story.id)
    })
  )
  const dir = roundDir(deps.stateDir, deps.round)
  yield* deps.files.writeAtomic(join(dir, "feedback.md"), `${deps.feedback}\n`)
  // Always written: a reused folder must not keep an older round's list.
  yield* deps.files.writeAtomic(
    join(dir, "not-planned.md"),
    renderNotPlanned(deps.round, proposal.notPlanned)
  )
  // The plan goes last: it is what makes the folder a round.
  yield* makeStoryPlanStore(deps.files).save(join(dir, "plan.md"), plan)
  return { plan, notPlanned: proposal.notPlanned }
})

/**
 * The epic a `--refine` run works on. The text on the command line is
 * feedback, so it never names or creates an epic: only one with a story plan
 * can take a round.
 */
export const refineEpic = (
  choice: EpicChoice
): Effect.Effect<EpicSummary, RefineRefused | ScriptUsage> =>
  choice._tag === "Existing"
    ? Effect.succeed(choice.epic)
    : choice._tag === "Brief"
      ? Effect.fail(
          RefineRefused.make({
            epicId: choice.dir,
            reason: "it has no story plan yet: run the epic first"
          })
        )
      : Effect.fail(
          ScriptUsage.make({
            message: `--refine needs a finished epic, and this repository has none to pick: run an epic first, or name one with --epic <id>\n${epicUsage}`
          })
        )

/**
 * The planned epic a choice lands on: the one picked, or the one whose folder
 * the given text derives (an epic rerun by its text is still that epic).
 */
export const epicOnDisk = (
  choice: EpicChoice,
  epics: ReadonlyArray<EpicSummary>
): EpicSummary | undefined =>
  choice._tag === "Existing"
    ? choice.epic
    : choice._tag === "Text"
      ? epics.find((epic) => epic.dir === epicIdFor(choice.prompt))
      : undefined

/** The rounds as the landing takes them; one whose plan cannot be read stops it. */
export const landRounds = (
  epicId: string,
  target: string,
  rounds: ReadonlyArray<RoundOnDisk>
): Effect.Effect<
  ReadonlyArray<{ readonly plan: StoryPlan; readonly stateDir: string }>,
  LandingFailed
> =>
  Effect.forEach(rounds, (round) =>
    round.plan === undefined
      ? Effect.fail(
          LandingFailed.make({
            epicBranch: `epic/${epicId}`,
            target,
            reason: `round ${round.round}'s plan cannot be read (${round.unreadable ?? ""}); ${roundRepair(round.round)}`
          })
        )
      : Effect.succeed({ plan: round.plan, stateDir: round.stateDir })
  )

// ---- Usage ---------------------------------------------------------------------

/** Sums two meters into one per-story estimate. */
export const combineTotals = (
  first: Effect.Effect<TokenUsage | undefined>,
  second: Effect.Effect<TokenUsage | undefined>
): Effect.Effect<TokenUsage | undefined> =>
  Effect.map(Effect.all([first, second]), ([left, right]) => {
    if (left === undefined) return right
    if (right === undefined) return left
    const cost = [left.costUsd, right.costUsd].flatMap((value) =>
      value === undefined ? [] : [value]
    )
    return TokenUsage.make({
      prompt: left.prompt + right.prompt,
      completion: left.completion + right.completion,
      total: left.total + right.total,
      ...(cost.length === 0 ? {} : { costUsd: cost.reduce((sum, value) => sum + value, 0) })
    })
  })

// ---- Judge ---------------------------------------------------------------------

export const storyDimensions: ReadonlyArray<Dimension> = [
  Dimension.make({
    name: "provides",
    rubric:
      "Everything the story promised to provide (routes, exports, contracts) exists in the diff and is complete enough for a dependent story to use. 2 = all present and complete; 1 = present but partial; 0 = missing."
  }),
  Dimension.make({
    name: "scope",
    rubric:
      "The diff does only what the story describes, inside its owned paths, and does not reimplement what the shared kit already offers. 2 = focused; 1 = minor drift; 0 = unrelated or duplicated work."
  }),
  Dimension.make({
    name: "house-style",
    rubric:
      "The code follows the target's house rules: kit components and hooks only, per-feature messages in both languages, contract-first domains, tests beside the feature. 2 = follows them; 1 = mostly; 0 = ignores them."
  }),
  Dimension.make({
    name: "tests",
    rubric:
      "The story ships deterministic tests in the house style covering its screens or contract. 2 = yes; 1 = thin; 0 = none."
  })
]

const subBar = (scored: EvalResult, story: Story): ReviewResult =>
  ReviewResult.make({
    issues: scored.scores
      .filter(
        (score) =>
          score.score <
          (storyDimensions.find((dimension) => dimension.name === score.name)?.maxScore ?? 2)
      )
      .map((score) =>
        ReviewIssue.make({
          severity: "Critical",
          title: `judge[${story.id}]: ${score.name} scored ${score.score}`,
          description: score.reasoning
        })
      ),
    summary: `judge:${story.id}`
  })

/**
 * What the story judge reads beside the diff: the story, and what every
 * story it depends on provides. Without the dependencies the judge cannot
 * tell the house pattern from a mistake — it once failed a screen for
 * importing `paymentsDomain` from `payments.fake.ts`, exactly where the
 * payments contract story declared it.
 */
export const storyJudgeQuery = (
  story: Story,
  plan?: StoryPlan,
  subject: "diff" | "code" = "diff"
): string => {
  const dependencies =
    plan === undefined
      ? []
      : dependenciesOf(plan, story.id).flatMap((id) => {
          const dependency = plan.story(id)
          return dependency === undefined
            ? []
            : [`- ${dependency.id}: ${dependency.provides.join("; ") || "(nothing declared)"}`]
        })
  return [
    `Story: ${story.title}`,
    story.description,
    "",
    `Provides: ${story.provides.join(", ") || "(none)"}`,
    `Owned paths: ${story.owned.join(", ")}`,
    `Shared read-only: ${story.sharedReadOnly.join(", ") || "(none)"}`,
    ...(dependencies.length === 0
      ? []
      : [
          "",
          "Already merged, from the stories this one depends on (their declared interface):",
          ...dependencies,
          "Using these exactly as declared (the same module, the same export) is correct and is",
          "never a house-style or scope problem, even where the module is a fake transport."
        ]),
    ...(subject === "code"
      ? [
          "",
          "The story's branch has no changes. Below is the current code of its owned paths on",
          "the epic branch, shown as additions: judge whether the story is already in place —",
          "everything it provides exists and is tested — not the diff's size or novelty."
        ]
      : [])
  ].join("\n")
}

/** The story-level judge over the branch diff, bounded by the character budget. */
export const judgeStory = (
  reasoning: LlmServiceShape,
  story: Story,
  diff: string,
  budget: number,
  plan?: StoryPlan,
  subject: "diff" | "code" = "diff"
): Effect.Effect<StoryVerdict, FlowError> =>
  judge(reasoning, storyDimensions)
    .evaluate(
      Sample.make({
        query: storyJudgeQuery(story, plan, subject),
        response: cap(diff, budget).text
      })
    )
    .pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.map((scored) =>
        StoryVerdict.make({
          ...subBar(scored, story),
          dimensions: scored.scores.map((score) => ({
            id: score.name,
            score: score.score,
            max: storyDimensions.find((dimension) => dimension.name === score.name)?.maxScore ?? 2
          }))
        })
      )
    )

// ---- App directory ----------------------------------------------------------------

/** Folders never taken for the application: dependencies, build output, llm4ts state. */
const ignoredAppDirs = new Set(["node_modules", "dist", "build", "out", "coverage"])

const hasPackageJson = (dir: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => readdir(dir)).pipe(
    Effect.map((names) => names.includes("package.json")),
    Effect.catch(() => Effect.succeed(false))
  )

/**
 * Where setup and gates run, relative to a checkout: `LLM4TS_APP_DIR` when set
 * (`.` for the root); otherwise the root when it has a `package.json`, else
 * its ONE first-level subfolder that has one (a Next.js app in `frontend/`).
 * Several candidates, or none, keep the root — the setup error then names it.
 * The value is relative so it applies to every worktree and the epic checkout.
 */
export const appDirFor = (
  workDir: string,
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<string, ScriptUsage> =>
  Effect.gen(function* () {
    const configured = environment.LLM4TS_APP_DIR?.trim()
    if (configured !== undefined && configured.length > 0) {
      const normalized = normalize(configured)
      const relative = normalized.replace(/[\\/]+$/, "")
      if (isAbsolute(normalized) || relative === ".." || /^\.\.[\\/]/.test(relative)) {
        return yield* ScriptUsage.make({
          message: `LLM4TS_APP_DIR must be a folder inside the repository, got '${configured}'`
        })
      }
      return relative.length === 0 ? "." : relative
    }
    if (yield* hasPackageJson(workDir)) {
      return "."
    }
    const entries = yield* Effect.tryPromise(() => readdir(workDir, { withFileTypes: true })).pipe(
      Effect.catch(() => Effect.succeed([]))
    )
    const candidates: Array<string> = []
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !ignoredAppDirs.has(entry.name)) {
        if (yield* hasPackageJson(join(workDir, entry.name))) {
          candidates.push(entry.name)
        }
      }
    }
    return candidates.length === 1 ? (candidates[0] ?? ".") : "."
  })

/** Runs a per-checkout step in the app directory of whichever checkout it is given. */
export const inAppDir =
  <A>(appDir: string, step: (workDir: string) => Effect.Effect<A, FlowError>) =>
  (workDir: string): Effect.Effect<A, FlowError> =>
    step(appDir === "." ? workDir : join(workDir, appDir))

// ---- Worktree setup --------------------------------------------------------------

export const defaultWorktreeSetup: ReadonlyArray<string> = ["pnpm", "install", "--offline"]

/**
 * `LLM4TS_WORKTREE_SETUP="pnpm install --offline"` (the default) prepares
 * each story worktree; an empty value disables the step. Offline by default:
 * the runbook warms the pnpm store once, and a workshop stage has no network.
 */
export const worktreeSetupCommand = (
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> | undefined => {
  const raw = environment.LLM4TS_WORKTREE_SETUP
  if (raw === undefined) {
    return defaultWorktreeSetup
  }
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0)
  return parts.length === 0 ? undefined : parts
}

/**
 * `LLM4TS_SETUP_AGENT=1` (or `true`/`on`): a failed setup gets one coder turn
 * to make the worktree ready, then runs again as the check. Off by default.
 */
export const setupAgentEnabled = (
  environment: Readonly<Record<string, string | undefined>>
): boolean => /^(1|true|on|yes)$/i.test(environment.LLM4TS_SETUP_AGENT?.trim() ?? "")

const output = (result: ReviewResult): string =>
  result.issues.map((issue) => issue.description).join("\n")

/** Runs the setup command in a worktree; a non-zero exit fails the story with the output. */
export const setupIn =
  (process: ProcessExecutorShape, events: FlowEventsShape, command: ReadonlyArray<string>) =>
  (workDir: string, laneEvents?: FlowEventsShape): Effect.Effect<void, FlowError> =>
    Effect.flatMap(lintCommand(process, laneEvents ?? events, command, workDir), (result) =>
      result.isClean
        ? Effect.void
        : FlowAborted.make({
            message: `worktree setup failed (${command.join(" ")}):\n${output(result)}${
              /ERR_PNPM_NO_PKG_MANIFEST|ENOENT.*package\.json/.test(output(result))
                ? "\n(the application is not at this folder: set LLM4TS_APP_DIR to its subfolder)"
                : ""
            }`
          })
    )

// ---- Gates ---------------------------------------------------------------------

export const defaultGateCommands: ReadonlyArray<ReadonlyArray<string>> = [
  ["pnpm", "typecheck"],
  ["pnpm", "lint"],
  ["pnpm", "test"],
  ["pnpm", "build"]
]

/** The part of an application's package.json the gates care about. */
const PackageScripts = Schema.fromJsonString(
  Schema.Struct({
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String))
  })
)

/**
 * The script names in `<appRoot>/package.json`; undefined when it is missing
 * or unreadable, which keeps every default gate (the failure then says why).
 */
export const appScripts = (
  files: PlainFileStoreShape,
  appRoot: string
): Effect.Effect<ReadonlySet<string> | undefined> =>
  files.read(join(appRoot, "package.json")).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : Effect.map(
            Schema.decodeUnknownEffect(PackageScripts)(text),
            (manifest) => new Set(Object.keys(manifest.scripts ?? {}))
          )
    ),
    Effect.catch(() => Effect.succeed(undefined))
  )

/**
 * `LLM4TS_GATES="pnpm typecheck;pnpm test"` overrides the four defaults.
 * Without it, a default gate runs only when the application defines that
 * script: a Next.js app has `lint` and `build` but seldom `typecheck`, and
 * `pnpm typecheck` there fails with "Command not found", not a red gate.
 */
export const gateCommands = (
  environment: Readonly<Record<string, string | undefined>>,
  scripts?: ReadonlySet<string>
): ReadonlyArray<ReadonlyArray<string>> => {
  const raw = environment.LLM4TS_GATES?.trim()
  if (raw === undefined || raw.length === 0) {
    return scripts === undefined
      ? defaultGateCommands
      : defaultGateCommands.filter((command) => scripts.has(command[1] ?? ""))
  }
  return raw
    .split(";")
    .map((command) =>
      command
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0)
    )
    .filter((command) => command.length > 0)
}

/** Runs the gates in a directory, stopping at the first red one (later output would be noise). */
export const gatesIn =
  (
    process: ProcessExecutorShape,
    events: FlowEventsShape,
    commands: ReadonlyArray<ReadonlyArray<string>>
  ) =>
  (workDir: string, laneEvents?: FlowEventsShape): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const results: Array<ReviewResult> = []
      for (const command of commands) {
        const result = yield* lintCommand(process, laneEvents ?? events, command, workDir)
        results.push(result)
        if (!result.isClean) {
          break
        }
      }
      return mergeReviewResults(results)
    })

// ---- The flow program, shared by epic-stories and its forks -------------------

export type StoryJudge = NonNullable<StoriesOptions["judge"]>

/** What a story judge is built from, once per run. */
export interface StoryJudgeContext {
  readonly plan: StoryPlan
  readonly budget: number
  /** The metered reasoning seat; a roster's judge seat wins per story when present. */
  readonly reasoning: LlmServiceShape
  readonly events: FlowEventsShape
  readonly files: PlainFileStoreShape
  readonly houseRules: string
}

/**
 * Deletes the transcripts (`--transcript`) of these runs; returns how many
 * there were. A landed epic keeps no copy of its customer code in them.
 */
export const removeTranscripts = (
  workDir: string,
  runIds: ReadonlyArray<string>
): Effect.Effect<number> =>
  Effect.reduce(
    runIds,
    () => 0,
    (removed, runId) => {
      const directory = join(workDir, ".llm4ts", "transcripts", runId)
      return Effect.tryPromise(() => stat(directory)).pipe(
        Effect.andThen(Effect.tryPromise(() => rm(directory, { recursive: true, force: true }))),
        Effect.as(removed + 1),
        Effect.orElseSucceed(() => removed)
      )
    }
  )

/**
 * LLM4TS_STORY_CONTEXT_CHARS: how much of the code a story starts from its
 * coder sees up front (0 leaves it out); the executor's default otherwise.
 */
export const storyContextChars = (
  environment: Readonly<Record<string, string | undefined>>
): { readonly contextChars?: number } => {
  const value = Number(environment.LLM4TS_STORY_CONTEXT_CHARS?.trim() ?? "")
  return environment.LLM4TS_STORY_CONTEXT_CHARS === undefined ||
    !Number.isInteger(value) ||
    value < 0
    ? {}
    : { contextChars: value }
}

/** Today's story judge: the rubric judge over the four dimensions. */
export const rubricStoryJudge =
  (context: StoryJudgeContext): StoryJudge =>
  (story, diff, seats, subject) =>
    judgeStory(
      // The story's own seat, not the run's: its time counts for the story.
      // And the judge seat, never the writing reasoner: a judge reads.
      seats.context.roster?.forRole("judge") ?? seats.context.judge ?? seats.context.reasoning,
      story,
      diff,
      context.budget,
      context.plan,
      subject
    )

export interface EpicStoriesOptions {
  readonly storyJudge: (context: StoryJudgeContext) => StoryJudge
  /**
   * Resolve the judgment seat from LLM4TS_JUDGMENT_PROVIDER / _MODEL (ADR
   * 0017) and pass it to the runner. Off, the runner derives one from the
   * reasoning seat — what epic-stories has always done.
   */
  readonly judgmentFromEnvironment?: boolean
  /** Write every JudgmentObserved to .llm4ts/judgments/<consumer>.jsonl. */
  readonly judgmentLog?: boolean
}

/** The runner options the two flags above add; empty when neither is set. */
export const epicRunnerOptions = Effect.fn("epic-stories.runnerOptions")(function* (
  options: EpicStoriesOptions,
  environment: Readonly<Record<string, string | undefined>>
): Effect.fn.Return<
  { readonly judgment?: ApiConnectorConfig; readonly judgmentLog?: boolean },
  ScriptUsage
> {
  const judgment =
    options.judgmentFromEnvironment === true
      ? yield* judgmentConnectorFromEnvironment(environment)
      : undefined
  return {
    ...(judgment === undefined ? {} : { judgment }),
    ...(options.judgmentLog === true ? { judgmentLog: true } : {})
  }
})

/** `LLM4TS_CODER_MODEL` / `LLM4TS_REASONING_MODEL`: pi takes `provider/model` (e.g. `openai-codex/gpt-5.5`). */
const withOptionalModel = (
  config: CliConnectorConfig,
  model: string | undefined
): CliConnectorConfig => {
  const trimmed = model?.trim()
  return trimmed === undefined || trimmed.length === 0 ? config : withModel(config, trimmed)
}

/** Extra CLI flags on top of a preset's own (`LLM4TS_CODER_FLAGS`). */
const withExtraFlags = (
  config: CliConnectorConfig,
  flags: Readonly<Record<string, string>>
): CliConnectorConfig =>
  Object.keys(flags).length === 0
    ? config
    : CliConnectorConfig.make({ ...config, flags: { ...config.flags, ...flags } })

const defaultEpic =
  "Add the retail customer's current account (Conto) with balance and movements, and wire " +
  "transfers (Bonifico) with beneficiary, review, SCA confirmation, and history."

export const runEpicStories = (options: EpicStoriesOptions) =>
  Effect.gen(function* () {
    const flags = yield* parseEpicArgs(process.argv.slice(2))
    // The epic is chosen before any seat is resolved: the text given, `--epic`,
    // or the one epic not landed yet (`chooseEpic`); `--list` only lists.
    const given = yield* resolveFlowInput("", flags.rest)
    const files = nodePlainFileStore
    const epics = yield* listEpics(files, given.workDir)
    if (flags.list) {
      yield* Console.log(renderEpicList(epics))
      return
    }
    // With `--refine` the text is feedback on a finished epic, never an epic's text.
    const feedback = flags.refine ? given.prompt.trim() : ""
    const choice = yield* chooseEpic({
      text: flags.refine ? "" : given.prompt,
      epic: flags.epic,
      epics,
      briefs: yield* listBriefs(files, given.workDir, yield* epicDirs(given.workDir)),
      defaultEpic
    })
    if (flags.refine) {
      yield* refineEpic(choice)
    }
    // What this run does (ADR 0021): the plan's stories, the open refine round,
    // a new round, or the landing. Refusals come before any seat is resolved.
    const existing = epicOnDisk(choice, epics)
    const rounds = existing?.rounds ?? []
    const action =
      existing !== undefined
        ? runAction({
            planned: true,
            stories: existing.stories,
            merged: existing.merged,
            landed: existing.landed,
            rounds: roundProgress(rounds),
            refine: flags.refine,
            feedback,
            land: flags.land !== undefined
          })
        : flags.land !== undefined
          ? { _tag: "Land" as const }
          : { _tag: "RunPlan" as const }
    if (action._tag === "Refused") {
      return yield* RefineRefused.make({
        epicId: existing?.epicId ?? "",
        reason: action.reason
      })
    }
    if (action._tag === "Usage") {
      return yield* ScriptUsage.make({ message: `${action.message}\n${epicUsage}` })
    }
    const input = {
      ...given,
      prompt:
        choice._tag === "Existing"
          ? choice.epic.epic
          : choice._tag === "Brief"
            ? choice.request
            : choice.prompt
    }
    const coderFlags = flagsFromEnvironment(process.env.LLM4TS_CODER_FLAGS)
    const reasoning = withExtraFlags(
      withOptionalModel(
        yield* reasonerFromEnvironment(process.env),
        process.env.LLM4TS_REASONING_MODEL
      ),
      flagsFromEnvironment(process.env.LLM4TS_REASONING_FLAGS)
    )
    const coder = withExtraFlags(
      withOptionalModel(
        yield* storyCoderFromEnvironment(process.env),
        process.env.LLM4TS_CODER_MODEL
      ),
      coderFlags
    )
    const localServer = localCoderServer(process.env.LLM4TS_CODER_MODEL, coderFlags, process.env)
    // A new epic's id (and state folder) is derived from its text; an existing
    // one keeps its folder, whatever text is on the command line.
    const epicId =
      choice._tag === "Existing"
        ? choice.epic.dir
        : choice._tag === "Brief"
          ? choice.dir
          : epicIdFor(input.prompt)
    const stateDir = join(epicsDir(input.workDir), epicId)
    const planPath = join(stateDir, "plan.md")
    const estimateOptions = estimatedUsageOptionsFromEnv(process.env)
    const contextBudget = budget(process.env)

    const runnerOptions = yield* epicRunnerOptions(options, process.env)
    yield* runNode(
      {
        workDir: input.workDir,
        workspace: input.workspace,
        userPrompt: input.prompt,
        coder,
        reasoning,
        reviewers: [asReadOnly(reasoning)],
        environment: process.env,
        ...runnerOptions
      },
      (context) =>
        Effect.gen(function* () {
          const events = context.events
          // The epic remembers which trace each run wrote (`llm4ts watch --epic`).
          if (context.trace !== undefined) {
            yield* appendEpicRun(
              files,
              stateDir,
              EpicRun.make({
                runId: context.trace.runId,
                tracePath: context.trace.path,
                action: action._tag,
                ...("round" in action ? { round: action.round } : {}),
                startedAt: yield* Clock.currentTimeMillis
              })
            )
          }
          const reasoningMeter = yield* makeEstimatedUsageMeter(context.reasoning, estimateOptions)
          const guidance = yield* Effect.map(
            files.read(join(input.workDir, "CONTRIBUTING.md")),
            (text) => cap(text ?? "(no CONTRIBUTING.md in the target repository)", 24_000).text
          )

          // An approved epic brief in the epic's folder is what the planner reads.

          const brief = yield* plannerInput(files, stateDir, planPath)

          if (brief !== undefined) {
            yield* events.publish(
              Info.make({
                message: `planning from the approved brief at ${join(stateDir, "brief.md")}`
              })
            )
          }

          const store = makeStoryPlanStore(files)
          const plan = yield* stage(
            events,
            "story plan",
            store
              .recoverOrCreate(
                planPath,
                generateStoryPlan(
                  reasoningMeter.service,
                  events,
                  input.prompt,
                  epicId,
                  guidance,
                  brief
                )
              )
              .pipe(Effect.flatMap(validateStoryPlan))
          )
          yield* events.publish(
            Info.make({
              message: `story plan: ${plan.stories.length} stories at ${planPath} (edit and rerun to re-plan)`
            })
          )
          if (flags.planOnly && action._tag !== "PlanRound") {
            return
          }
          const epicBranch = `epic/${plan.epicId}`
          // The unit the executor works on: the epic's plan, or one refine round.
          // Same branch, seats, gates and judge; its own plan and state folder.
          let unit = { plan, stateDir, label: `Epic: ${plan.epicId}` }
          if (action._tag === "RunRound") {
            const open = rounds.find((round) => round.round === action.round)
            if (open?.plan !== undefined) {
              unit = {
                plan: open.plan,
                stateDir: open.stateDir,
                label: `Epic: ${plan.epicId} · round ${open.round}`
              }
              yield* events.publish(
                Info.make({
                  message: `refine round ${open.round}: ${open.merged}/${open.plan.stories.length} stories merged; finishing it`
                })
              )
            }
          }
          if (action._tag === "PlanRound") {
            // The planner reads the code as the person tried it: the epic
            // branch, with nothing uncommitted carried over onto it.
            const stray = statusPaths(yield* context.git.status)
            if (stray.length > 0) {
              return yield* EpicCheckoutDirty.make({ checkout: input.workDir, paths: stray })
            }
            yield* stage(events, "epic branch", context.git.checkoutOrCreate(epicBranch))
            const roundBrief = yield* files.read(join(stateDir, "brief.md"))
            const planned = yield* stage(
              events,
              `refine round ${action.round} plan`,
              planRound({
                files,
                reasoning: reasoningMeter.service,
                events,
                stateDir,
                epicId: plan.epicId,
                round: action.round,
                feedback,
                guidance,
                plans: [
                  plan,
                  ...rounds.flatMap((round) => (round.plan === undefined ? [] : [round.plan]))
                ],
                ...(roundBrief === undefined ? {} : { brief: roundBrief })
              })
            )
            for (const left of planned.notPlanned) {
              yield* events.publish(
                Info.make({ message: `not planned: ${left.item} — ${left.reason}` })
              )
            }
            if (planned.plan === undefined) {
              yield* events.publish(
                Info.make({
                  message: `refine round ${action.round}: no feedback item could be planned; answer the questions above and run --refine again`
                })
              )
              return
            }
            const dir = roundDir(stateDir, action.round)
            yield* events.publish(
              Info.make({
                message: `refine round ${action.round}: ${planned.plan.stories.length} follow-up stories at ${join(dir, "plan.md")} (edit and rerun to re-plan)${planned.notPlanned.length === 0 ? "" : `; ${planned.notPlanned.length} item(s) not planned, listed in ${join(dir, "not-planned.md")}`}`
              })
            )
            if (flags.planOnly) {
              return
            }
            unit = {
              plan: planned.plan,
              stateDir: dir,
              label: `Epic: ${plan.epicId} · round ${action.round}`
            }
          }
          // Setup and gates run where the application is, in every checkout.
          const appDir = yield* appDirFor(input.workDir, process.env)
          if (appDir !== ".") {
            yield* events.publish(
              Info.make({
                message: `app dir: ${appDir} (setup and gates run there; LLM4TS_APP_DIR)`
              })
            )
          }
          const commands = gateCommands(
            process.env,
            yield* appScripts(files, join(input.workDir, appDir))
          )
          yield* events.publish(
            Info.make({
              message:
                commands.length === 0
                  ? "gates: none (the app defines none of typecheck, lint, test, build; set LLM4TS_GATES)"
                  : `gates: ${commands.map((command) => command.join(" ")).join(" · ")}`
            })
          )
          // The Node the gates would run on is the one on PATH, not the one
          // the application pins; a mismatch is a red first story that says
          // nothing about Node. Ask now, and name both.
          if (commands.length > 0) {
            yield* nodePreflight(
              nodeProcessExecutor,
              files,
              events,
              join(input.workDir, appDir),
              process.env
            )
          }
          if (flags.land !== undefined) {
            const landed = yield* landEpic(context, {
              plan,
              files,
              stateDir,
              target: flags.land,
              rounds: yield* landRounds(plan.epicId, flags.land, rounds),
              keepWorktrees: flags.keepWorktrees,
              gates: inAppDir(appDir, gatesIn(nodeProcessExecutor, events, commands)),
              system: ["House rules of the target repository (CONTRIBUTING.md):", guidance].join(
                "\n"
              )
            })
            // The epic's earlier runs' transcripts go with it; this run's may still be read.
            const earlier = (yield* readEpicRuns(files, stateDir))
              .map((run) => run.runId)
              .filter((runId) => runId !== context.trace?.runId)
            const removed = yield* removeTranscripts(input.workDir, earlier)
            if (removed > 0) {
              yield* events.publish(
                Info.make({ message: `epic ${plan.epicId}: removed ${removed} run transcript(s)` })
              )
            }
            yield* events.publish(
              Info.make({
                message: `epic ${plan.epicId}: landed on ${landed.target}${landed.conflicts.length === 0 ? "" : ` (${landed.conflicts.length} conflicted file(s) resolved in ${landed.rounds} round(s))`}`
              })
            )
            return
          }
          // With a roster, the default is every coder slot it has; the flag caps it.
          const concurrency = flags.concurrency ?? context.roster?.slots("coder") ?? 3
          if (context.roster === undefined && localServer !== undefined && concurrency > 1) {
            yield* events.publish(
              Info.make({
                message:
                  `⚠ the coder is served by a local single-model server (${localServer}): it generates one ` +
                  `reply at a time, so ${concurrency} parallel coders queue behind each other and a queued ` +
                  'request is cut off after a few minutes ("terminated"). Prefer --concurrency 1, or give ' +
                  "the server parallel slots."
              })
            )
          }

          const contextFor = context.contextFor
          if (contextFor === undefined) {
            return yield* FlowAborted.make({
              message: "this runner cannot rebind seats to a worktree (no contextFor)"
            })
          }
          const appDirNote =
            appDir === "."
              ? []
              : [
                  `The application lives in ${appDir}/ — its package.json, sources and tests; the gates run there.`
                ]
          const gates = inAppDir(appDir, gatesIn(nodeProcessExecutor, events, commands))
          const setupCommand = worktreeSetupCommand(process.env)
          const healthUrl = serverHealthUrl(localServer, process.env)
          const report = yield* implementStoriesFlow(
            { ...context, reasoning: reasoningMeter.service },
            {
              plan: unit.plan,
              files,
              stateDir: unit.stateDir,
              epicBranch,
              worktreeRoot: worktreeRootFor(input.workDir, plan.epicId, process.env),
              board: makeLocalBoardSync(files, unit.stateDir, unit.label),
              contextFor: (workDir, contextOptions) =>
                Effect.gen(function* () {
                  const rebound = yield* contextFor(workDir, contextOptions)
                  const coderMeter = yield* makeEstimatedUsageMeter(rebound.coder, estimateOptions)
                  const reviewMeter = yield* makeEstimatedUsageMeter(
                    rebound.reasoning,
                    estimateOptions
                  )
                  const seats: StorySeats = {
                    context: {
                      ...rebound,
                      coder: coderMeter.service,
                      reasoning: reviewMeter.service
                    },
                    totals: combineTotals(coderMeter.totals, reviewMeter.totals)
                  }
                  return seats
                }),
              ...(setupCommand === undefined
                ? {}
                : {
                    setup: inAppDir(appDir, setupIn(nodeProcessExecutor, events, setupCommand)),
                    setupAgent: setupAgentEnabled(process.env)
                  }),
              gates,
              // With a roster, the judge and the verifier are leased per story,
              // away from the executor coding it (ADR 0019).
              ...storyContextChars(process.env),
              judge: options.storyJudge({
                plan: unit.plan,
                budget: contextBudget,
                reasoning: reasoningMeter.service,
                events,
                files,
                houseRules: guidance
              }),
              verifyBlocked: (story, need, workDir, seats) =>
                verifyBlockedOn(
                  seats.context.roster?.forRole("verifier") ?? seats.context.reasoning,
                  events,
                  files,
                  unit.plan
                )(story, need, workDir),
              // A roster waits for its own executors (the story's next lease
              // does); without one, poll the single coder's engine.
              awaitRecovery:
                context.roster === undefined
                  ? awaitServer(healthUrl === undefined ? undefined : httpProbe(healthUrl), events)
                  : () => Effect.void,
              system: (story) =>
                Effect.succeed(
                  [
                    "House rules of the target repository (CONTRIBUTING.md):",
                    guidance,
                    "",
                    `Imitate the exemplar feature before inventing anything. Story id: ${story.id}.`,
                    ...appDirNote
                  ].join("\n")
                ),
              concurrency,
              failFast: flags.failFast
            }
          )
          yield* events.publish(
            Info.make({
              message: `${unit.label.replace("Epic: ", "epic ")}: ${report.count("done")} done, ${report.count("failed")} failed, ${report.count("waiting")} waiting — report at ${join(unit.stateDir, "report.md")} (usage figures estimated)`
            })
          )
        })
    )
  })
