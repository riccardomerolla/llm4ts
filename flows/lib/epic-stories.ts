// Shared core of the epic-stories flow (ADR 0013): the operator flags, the
// story-plan generator prompt and schema, the story judge, the gate runner,
// and seat selection. The executor itself is `@llm4ts/flow/Stories`.
import { readdir } from "node:fs/promises"
import { isAbsolute, join, normalize } from "node:path"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { Dimension, Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { TokenUsage, type JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { cap } from "@llm4ts/flow/Context"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { type FlowError } from "@llm4ts/flow/FlowError"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { EpicLanded, EpicLandedVersion, landedPath } from "@llm4ts/flow/Landing"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { BlockedVerdict, StoryState, StoryStateVersion } from "@llm4ts/flow/Stories"
import { stableHash } from "@llm4ts/flow/Plan"
import { ReviewIssue } from "@llm4ts/flow/Review"
import {
  StoryPlan,
  dependenciesOf,
  makeStoryPlanStore,
  pathsNamedIn,
  type Story
} from "@llm4ts/flow/StoryPlan"
import { claude, coderIds, pi } from "@llm4ts/runner/Connectors"
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
  "  --concurrency <n>   stories implemented at once (default 3)",
  "  --fail-fast         stop the epic at the first failed story",
  "Seats: LLM4TS_REASONER (claude|gemini|…, default claude) splits, reviews, judges;",
  "       LLM4TS_CODER (default pi) implements; LLM4TS_REASONING_MODEL / LLM4TS_CODER_MODEL",
  "       pick their models (pi: provider/model); LLM4TS_CODER_FLAGS / LLM4TS_REASONING_FLAGS",
  "       add CLI flags (key=value;key=value). LLM4TS_GATES overrides the gate commands;",
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
    return { planOnly, failFast, concurrency, land, keepWorktrees, list, epic, rest }
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
}

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
        landed: landed?.target
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
          }  (--epic ${epic.epicId})`,
          `  "${epic.epic.length > 110 ? `${epic.epic.slice(0, 109)}…` : epic.epic}"`
        ])
      ].join("\n")

/** Which epic a run works on. */
export type EpicChoice =
  | { readonly _tag: "Text"; readonly prompt: string }
  | { readonly _tag: "Existing"; readonly epic: EpicSummary }

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
  readonly defaultEpic: string
}): Effect.Effect<EpicChoice, ScriptUsage> => {
  if (args.epic !== undefined) {
    const found = args.epics.find((epic) => epic.dir === args.epic || epic.epicId === args.epic)
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
export { httpProbe } from "@llm4ts/runner/ExecutorRoster"

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
  guidance: string
): Effect.Effect<StoryPlan, FlowLlmError> =>
  structuredAndPublish(
    reasoning,
    events,
    `${storyPlanInstructions(epicId, guidance)}\n\nEpic:\n${epic}`,
    StoryPlan,
    storyPlanJsonSchema
  ).pipe(
    // The id and the epic text are ours, whatever the model echoed back.
    Effect.map((plan) => StoryPlan.make({ ...plan, epicId, epic }))
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
export const storyJudgeQuery = (story: Story, plan?: StoryPlan): string => {
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
        ])
  ].join("\n")
}

/** The story-level judge over the branch diff, bounded by the character budget. */
export const judgeStory = (
  reasoning: LlmServiceShape,
  story: Story,
  diff: string,
  budget: number,
  plan?: StoryPlan
): Effect.Effect<ReviewResult, FlowError> =>
  judge(reasoning, storyDimensions)
    .evaluate(
      Sample.make({
        query: storyJudgeQuery(story, plan),
        response: cap(diff, budget).text
      })
    )
    .pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.map((scored) => subBar(scored, story))
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
  (workDir: string): Effect.Effect<void, FlowError> =>
    Effect.flatMap(lintCommand(process, events, command, workDir), (result) =>
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

/** `LLM4TS_GATES="pnpm typecheck;pnpm test"` overrides the four defaults. */
export const gateCommands = (
  environment: Readonly<Record<string, string | undefined>>
): ReadonlyArray<ReadonlyArray<string>> => {
  const raw = environment.LLM4TS_GATES?.trim()
  if (raw === undefined || raw.length === 0) {
    return defaultGateCommands
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
  (workDir: string): Effect.Effect<ReviewResult, FlowError> =>
    Effect.gen(function* () {
      const results: Array<ReviewResult> = []
      for (const command of commands) {
        const result = yield* lintCommand(process, events, command, workDir)
        results.push(result)
        if (!result.isClean) {
          break
        }
      }
      return mergeReviewResults(results)
    })
