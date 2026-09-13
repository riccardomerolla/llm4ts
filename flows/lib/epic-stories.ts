// Shared core of the epic-stories flow (ADR 0013): the operator flags, the
// story-plan generator prompt and schema, the story judge, the gate runner,
// and seat selection. The executor itself is `@llm4ts/flow/Stories`.
import * as Effect from "effect/Effect"
import { Dimension, Sample, type EvalResult } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"
import type { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { TokenUsage, type JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { cap } from "@llm4ts/flow/Context"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { FlowAborted, FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { stableHash } from "@llm4ts/flow/Plan"
import { lintCommand, mergeReviewResults, ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { StoryPlan, type Story } from "@llm4ts/flow/StoryPlan"
import { claude, coderFor, coderIds, pi } from "@llm4ts/runner/Connectors"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"

// ---- Flags ------------------------------------------------------------------

export interface EpicArgs {
  readonly planOnly: boolean
  readonly failFast: boolean
  readonly concurrency: number | undefined
  /** Everything else, for `resolveFlowInput` (`--repo`, the epic text). */
  readonly rest: ReadonlyArray<string>
}

export const epicUsage = [
  "epic-stories flags:",
  "  --plan-only         write (or re-validate) the story plan and stop",
  "  --concurrency <n>   stories implemented at once (default 3)",
  "  --fail-fast         stop the epic at the first failed story",
  "Seats: LLM4TS_REASONER (claude|gemini|…, default claude) splits, reviews, judges;",
  "       LLM4TS_CODER (default pi) implements; LLM4TS_REASONING_MODEL / LLM4TS_CODER_MODEL",
  "       pick their models (pi: provider/model). LLM4TS_GATES overrides the gate commands;",
  "       LLM4TS_WORKTREE_SETUP (default: pnpm install --offline) prepares each worktree."
].join("\n")

/** The flow's own flags, taken out before the shared `--repo`/prompt parsing sees the rest. */
export const parseEpicArgs = (argv: ReadonlyArray<string>): Effect.Effect<EpicArgs, ScriptUsage> =>
  Effect.gen(function* () {
    let planOnly = false
    let failFast = false
    let concurrency: number | undefined
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index] ?? ""
      if (argument === "--plan-only") {
        planOnly = true
      } else if (argument === "--fail-fast") {
        failFast = true
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
    return { planOnly, failFast, concurrency, rest }
  })

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

/** The story-level judge over the branch diff, bounded by the character budget. */
export const judgeStory = (
  reasoning: LlmServiceShape,
  story: Story,
  diff: string,
  budget: number
): Effect.Effect<ReviewResult, FlowError> =>
  judge(reasoning, storyDimensions)
    .evaluate(
      Sample.make({
        query: [
          `Story: ${story.title}`,
          story.description,
          "",
          `Provides: ${story.provides.join(", ") || "(none)"}`,
          `Owned paths: ${story.owned.join(", ")}`,
          `Shared read-only: ${story.sharedReadOnly.join(", ") || "(none)"}`
        ].join("\n"),
        response: cap(diff, budget).text
      })
    )
    .pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.map((scored) => subBar(scored, story))
    )

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

/** Runs the setup command in a worktree; a non-zero exit fails the story with the output. */
export const setupIn =
  (process: ProcessExecutorShape, events: FlowEventsShape, command: ReadonlyArray<string>) =>
  (workDir: string): Effect.Effect<void, FlowError> =>
    Effect.flatMap(lintCommand(process, events, command, workDir), (result) =>
      result.isClean
        ? Effect.void
        : FlowAborted.make({
            message: `worktree setup failed (${command.join(" ")}):\n${result.issues
              .map((issue) => issue.description)
              .join("\n")}`
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
