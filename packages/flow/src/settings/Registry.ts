// @internal: the settings table; Settings is the public face
import * as Duration from "effect/Duration"
import {
  apiProviderNames,
  coderNames,
  offeredApiProviderNames,
  offeredCoderNames
} from "@llm4ts/core/Models"
import * as Value from "./Value.ts"

/** @internal */
export type SettingScope = "global" | "project" | "run" | "secret" | "internal"

/**
 * Docs sections and `config show --all` groups, in this order.
 *
 * @internal
 */
export const settingGroups = [
  ["seats", "Seats and models"],
  ["repositories", "Repositories, packs and worktrees"],
  ["gates", "Gates"],
  ["review", "Review, judging and stalls"],
  ["context", "Context and estate bounds"],
  ["modernization", "Modernization flows"],
  ["ports", "Port flows"],
  ["soap-ace", "Kit: soap-ace"],
  ["j2ee-nextjs", "Kit: j2ee-nextjs"],
  ["terminal", "Terminal, transcripts and the agent tree"],
  ["telemetry", "OpenTelemetry and usage estimates"],
  ["gemini-bridge", "Gemini bridge"],
  ["operator", "MCP operator"],
  ["launch", "Set by llm4ts"]
] as const

/** @internal */
export type SettingGroup = (typeof settingGroups)[number][0]

/** @internal */
export type Fallback<A> =
  /** One default for every reader; `settingValue` returns it when unset. */
  | { readonly _tag: "Default"; readonly value: A; readonly text: string }
  /** The reader decides (per flow, or derived from the repository); the text says how. */
  | { readonly _tag: "PerFlow"; readonly value: undefined; readonly text: string }
  /** Unset means the feature is off or absent. */
  | { readonly _tag: "Off"; readonly value: undefined; readonly text: string }

/** @internal */
export interface Setting<A, F extends Fallback<A>> {
  readonly group: SettingGroup
  readonly scope: SettingScope
  readonly value: Value.SettingValue<A>
  readonly fallback: F
  /** One or two sentences: what it changes. Rendered into the docs and `config show NAME`. */
  readonly doc: string
  /** The `llm4ts run` flag that also sets it. */
  readonly flag?: `--${string}`
  /** Flows that stop without it whatever their arguments. */
  readonly requiredBy?: ReadonlyArray<string>
  /** Read by the shell only; never handed to a flow. */
  readonly shellOnly?: true
}

const setting = <A, F extends Fallback<A>>(spec: Setting<A, F>): Setting<A, F> => spec

const fallback = {
  value: <const A>(value: A, text: string): Fallback<A> & { readonly _tag: "Default" } => ({
    _tag: "Default",
    value,
    text
  }),
  perFlow: (text: string) => ({ _tag: "PerFlow", value: undefined, text }) as const,
  off: (text: string) => ({ _tag: "Off", value: undefined, text }) as const
}

/**
 * Every `LLM4TS_*` name llm4ts reads. `examples/test/settings-sync.test.ts`
 * fails when the code reads a name this table lacks, or the table holds a
 * name the code no longer mentions.
 *
 * @internal
 */
export const settings = {
  // ---- seats ------------------------------------------------------------------
  LLM4TS_CODER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(coderNames),
    fallback: fallback.perFlow("claude; pi in the epic flows"),
    doc: `The coding agent that edits files: ${Value.listed(offeredCoderNames)}.`
  }),
  LLM4TS_REASONER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(coderNames),
    fallback: fallback.perFlow("claude"),
    doc: "The agent that plans, reviews and judges in the epic, soap, roundtable and taskforce flows; any coder name."
  }),
  LLM4TS_CODER_MODEL: setting({
    group: "seats",
    scope: "global",
    value: Value.text,
    fallback: fallback.perFlow("the agent's own default; the local and sdd flows name theirs"),
    doc: "The coder seat's model in every flow, unless the flow names one. pi takes provider/model, such as openai-codex/gpt-5.5."
  }),
  LLM4TS_REASONING_MODEL: setting({
    group: "seats",
    scope: "global",
    value: Value.text,
    fallback: fallback.perFlow("the agent's own default; the local and sdd flows name theirs"),
    doc: "The model of the reasoning seat and of every reviewer or judge on its agent, unless the flow names one. Unset, a seat on the coder's agent takes LLM4TS_CODER_MODEL."
  }),
  LLM4TS_CODER_FLAGS: setting({
    group: "seats",
    scope: "global",
    value: Value.cliFlags,
    fallback: fallback.off("none"),
    doc: "Extra CLI flags for the coder seat in every flow, on top of its preset's own. A flag the flow sets keeps its value."
  }),
  LLM4TS_REASONING_FLAGS: setting({
    group: "seats",
    scope: "global",
    value: Value.cliFlags,
    fallback: fallback.off("none"),
    doc: "Extra CLI flags for the reasoning seat and every reviewer or judge on its agent, as LLM4TS_CODER_FLAGS does for the coder."
  }),
  LLM4TS_CODER_HEALTH_URL: setting({
    group: "seats",
    scope: "global",
    value: Value.url,
    fallback: fallback.perFlow("the local server's model list at its default address"),
    doc: "The URL polled until a local serving engine answers again after it went down."
  }),
  LLM4TS_PROVIDER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(apiProviderNames),
    fallback: fallback.value("mock", "mock"),
    doc: `The API provider of provider-driven flows such as hello: ${Value.listed(offeredApiProviderNames)}. Any provider but mock needs LLM4TS_MODEL.`
  }),
  LLM4TS_MODEL: setting({
    group: "seats",
    scope: "global",
    value: Value.text,
    fallback: fallback.off("none; required unless the provider is mock"),
    doc: "The model LLM4TS_PROVIDER serves."
  }),
  LLM4TS_JUDGMENT_PROVIDER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(apiProviderNames),
    fallback: fallback.off("the reasoning seat answers typed judgments"),
    doc: "The API provider of the judgment seat, named the way LLM4TS_PROVIDER is."
  }),
  LLM4TS_JUDGMENT_MODEL: setting({
    group: "seats",
    scope: "global",
    value: Value.text,
    fallback: fallback.off("none; required with a judgment provider other than mock"),
    doc: "The model LLM4TS_JUDGMENT_PROVIDER serves."
  }),
  LLM4TS_JUDGMENT_BACKEND: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(["llm", "typesafe"]),
    fallback: fallback.value("llm", "llm"),
    doc: "What answers typed judgments: an LLM seat, or the TypeSafe API (needs TYPESAFE_API_KEY)."
  }),
  LLM4TS_JUDGMENT_BATCHING: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(["independent", "shared-prefix"]),
    fallback: fallback.value("independent", "independent"),
    doc: "shared-prefix sends the questions of one judgment request behind one shared prompt prefix, for a local model that caches it."
  }),
  LLM4TS_ISOLATED: setting({
    group: "seats",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Asks every CLI seat to leave the repository's own hooks, MCP servers, settings and instruction files unloaded."
  }),
  LLM4TS_ROSTER: setting({
    group: "seats",
    scope: "project",
    value: Value.text,
    fallback: fallback.off("the user's and the repository's roster.json, merged"),
    flag: "--roster",
    doc: "The executor roster in place of the roster.json files: a roster file, or none for one executor per seat."
  }),
  LLM4TS_EXECUTORS: setting({
    group: "seats",
    scope: "run",
    value: Value.names,
    fallback: fallback.off("every executor of the roster"),
    flag: "--executors",
    doc: "Narrows the roster to these executor ids."
  }),

  // ---- repositories -----------------------------------------------------------
  LLM4TS_PACK: setting({
    group: "repositories",
    scope: "project",
    value: Value.text,
    fallback: fallback.perFlow(
      "cobol-springboot in the modernization flows; j2ee-nextjs-spa in the convert flows; none in the epic flows"
    ),
    flag: "--pack",
    doc: "The pack: a kit pack name, kit/pack, or a directory holding pack.md."
  }),
  LLM4TS_LEGACY_REPO: setting({
    group: "repositories",
    scope: "project",
    value: Value.path,
    fallback: fallback.off("none"),
    requiredBy: ["modernize-seed", "convert-page", "convert-all", "convert-feature"],
    doc: "The legacy repository holding docs/modernization/, for flows rooted at the target. epic-design needs it too, except with --list."
  }),
  LLM4TS_TARGET_REPO: setting({
    group: "repositories",
    scope: "project",
    value: Value.path,
    fallback: fallback.off("none: a refine proposal claims nothing as provided by the target"),
    doc: "The target repository, mounted read-only by modernize-refine; `llm4ts refine --target` sets it."
  }),
  LLM4TS_WORKTREE_ROOT: setting({
    group: "repositories",
    scope: "project",
    value: Value.path,
    fallback: fallback.perFlow("<repo>.worktrees beside the repository"),
    doc: "Where the epic flows and taskforce keep their worktrees, one folder per epic."
  }),
  LLM4TS_WORKTREE_SETUP: setting({
    group: "repositories",
    scope: "project",
    value: Value.commandOrNone,
    fallback: fallback.perFlow("the pack's setup:, else pnpm install --offline"),
    doc: "Prepares each story worktree before its coder starts; empty skips setup."
  }),
  LLM4TS_SETUP_AGENT: setting({
    group: "repositories",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Gives the coder one turn to repair a failed worktree setup, then runs the setup again."
  }),
  LLM4TS_APP_DIR: setting({
    group: "repositories",
    scope: "project",
    value: Value.text,
    fallback: fallback.perFlow(
      "the repository root, or its one first-level folder with a package.json"
    ),
    doc: "The folder inside the repository where setup and gates run, relative to it (frontend)."
  }),
  LLM4TS_NODE_CHECK: setting({
    group: "repositories",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(true, "on"),
    doc: "Checks the node on PATH against the repository's pin before gates run; off runs anyway."
  }),

  // ---- gates ------------------------------------------------------------------
  LLM4TS_GATES: setting({
    group: "gates",
    scope: "project",
    value: Value.commands,
    fallback: fallback.perFlow(
      "the pack's ## Gates, else pnpm typecheck, lint, test and build where the app defines them"
    ),
    doc: "The gate commands of the epic flows, overriding the pack's."
  }),
  LLM4TS_GATE_TIMEOUT: setting({
    group: "gates",
    scope: "project",
    value: Value.seconds,
    fallback: fallback.value(Duration.seconds(1200), "1200 seconds"),
    doc: "How long a gate may run before it is killed and reported as a hang."
  }),
  LLM4TS_GATE_TAIL_CHARS: setting({
    group: "gates",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(4000, "4000"),
    doc: "How many characters of a red gate's output the fix prompt carries; at least 500 in port-tests."
  }),
  LLM4TS_TEST_REPORT: setting({
    group: "gates",
    scope: "project",
    value: Value.text,
    fallback: fallback.off("none; epic-mvp needs this or LLM4TS_TEST_ONE"),
    doc: "The JUnit XML report the test gate writes, relative to the app folder; epic-mvp reads its evidence there."
  }),
  LLM4TS_TEST_ONE: setting({
    group: "gates",
    scope: "project",
    value: Value.command,
    fallback: fallback.off("none; epic-mvp needs this or LLM4TS_TEST_REPORT"),
    doc: "A test command run once per outcome in epic-mvp, with {tag} or {tagRegex} replaced by the outcome's tag."
  }),

  // ---- review -----------------------------------------------------------------
  LLM4TS_JUDGE_ROUNDS: setting({
    group: "review",
    scope: "project",
    value: Value.positive,
    fallback: fallback.perFlow(
      "3 story-review rounds in the epic flows; 2 judge attempts elsewhere"
    ),
    doc: "Judge attempts before a story, page or program fails; in the epic flows --review-rounds and --judge-rounds set it too."
  }),
  LLM4TS_REVIEW_VOTES: setting({
    group: "review",
    scope: "project",
    value: Value.positive,
    fallback: fallback.perFlow("1; 2 in the port flows"),
    doc: "Independent votes of the adversarial review lens per round."
  }),
  LLM4TS_REVIEW_FIXER: setting({
    group: "review",
    scope: "project",
    value: Value.oneOf(["separate"]),
    fallback: fallback.off("the implementer's own chat fixes review findings"),
    doc: "separate sends review findings to a fresh fixer chat."
  }),
  LLM4TS_MERGE_REVISIONS: setting({
    group: "review",
    scope: "project",
    value: Value.count,
    fallback: fallback.value(1, "1"),
    doc: "Times a story whose merge turns the epic gates red goes back to be fixed; 0 fails at once. --merge-revisions sets it too."
  }),
  LLM4TS_TASK_CONCURRENCY: setting({
    group: "review",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(1, "1"),
    doc: "Coders working on one story at once; --task-concurrency sets it too."
  }),
  LLM4TS_DEFER_FINDINGS: setting({
    group: "review",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Fixes only Critical review findings in place and defers the rest to one refine round after the last merge; --defer-findings sets it too."
  }),
  LLM4TS_DEFER_TESTS: setting({
    group: "review",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Records the judge's tests score as debt instead of failing the story; --defer-tests sets it too."
  }),
  LLM4TS_STALL_REPEATS: setting({
    group: "review",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(5, "5"),
    doc: "Ends a coder turn that repeats one tool call this many times in a row; at least 2."
  }),
  LLM4TS_STALL_MINUTES: setting({
    group: "review",
    scope: "project",
    value: Value.minutes,
    fallback: fallback.off("no silence limit"),
    doc: "Ends a coder turn that prints nothing for this long."
  }),

  // ---- context ----------------------------------------------------------------
  LLM4TS_CONTEXT_BUDGET: setting({
    group: "context",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(400_000, "400000"),
    doc: "The character budget of the evidence one prompt may carry."
  }),
  LLM4TS_ORIENTATION_CHARS: setting({
    group: "context",
    scope: "project",
    value: Value.count,
    fallback: fallback.value(8000, "8000"),
    doc: "How much of the repository digest the planner and every coder see; 0 leaves it out."
  }),
  LLM4TS_STORY_CONTEXT_CHARS: setting({
    group: "context",
    scope: "project",
    value: Value.count,
    fallback: fallback.value(40_000, "40000"),
    doc: "How much of the code a story starts from its coder sees up front; 0 leaves it out."
  }),
  LLM4TS_RETRO_CHARS: setting({
    group: "context",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(60_000, "60000"),
    doc: "The character budget of the digest epic-retro reads."
  }),
  LLM4TS_MAX_READ_BYTES: setting({
    group: "context",
    scope: "project",
    value: Value.positive,
    fallback: fallback.perFlow("the workspace's cap; 8388608 for a legacy estate"),
    doc: "The per-file read cap, for estates whose sources exceed it."
  }),
  LLM4TS_MAX_DISCOVER_RESULTS: setting({
    group: "context",
    scope: "project",
    value: Value.positive,
    fallback: fallback.perFlow("the workspace's cap; 20000 for a legacy estate"),
    doc: "How many files a discovery may return before it fails."
  }),
  LLM4TS_EXCLUDE_DIRS: setting({
    group: "context",
    scope: "project",
    value: Value.names,
    fallback: fallback.perFlow("the built-in pruned list (.git, node_modules, …)"),
    doc: "Directory names discovery prunes, replacing the built-in list."
  }),

  // ---- modernization ----------------------------------------------------------
  LLM4TS_WAVE: setting({
    group: "modernization",
    scope: "run",
    value: Value.text,
    fallback: fallback.off("every wave, with estate-wide coverage"),
    doc: "Scopes modernize-extract to one wave of the approved plan."
  }),
  LLM4TS_EXTRACT_CONCURRENCY: setting({
    group: "modernization",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(1, "1"),
    doc: "Programs modernize-extract extracts and judges at once."
  }),
  LLM4TS_ANALYST_TURNS: setting({
    group: "modernization",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(48, "48"),
    doc: "The turn budget of one program's analyst in modernize-extract and modernize-refine."
  }),
  LLM4TS_MAX_CLOSURE_FILES: setting({
    group: "modernization",
    scope: "project",
    value: Value.positive,
    fallback: fallback.perFlow("40 in the modernization flows; 12 in the convert flows"),
    doc: "How many files of a program's include closure are named as evidence."
  }),
  LLM4TS_GRAPH_REFINE: setting({
    group: "modernization",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(true, "on"),
    doc: "The LLM pass that refines modernize-survey's code graph; off ships the regex graph."
  }),
  LLM4TS_REGROUP: setting({
    group: "modernization",
    scope: "run",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Makes modernize-refine consolidate domains again even when domains.md is current; `llm4ts refine` sets it for its regroup action."
  }),
  LLM4TS_MARK_DEEPEN: setting({
    group: "modernization",
    scope: "run",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Makes modernize-pack-upgrade add a ## Deepen request to every incompatible program."
  }),
  LLM4TS_APPROVER: setting({
    group: "modernization",
    scope: "global",
    value: Value.text,
    fallback: fallback.off("the OS user"),
    doc: "The name that signs refine decisions and the seed's provenance."
  }),
  LLM4TS_BENCH_MODE: setting({
    group: "modernization",
    scope: "run",
    value: Value.oneOf(["measure", "report"]),
    fallback: fallback.perFlow("measure; report when the task is `report`"),
    doc: "Whether modernize-bench measures a run or prints the comparison report."
  }),
  LLM4TS_BENCH_PROJECT: setting({
    group: "modernization",
    scope: "run",
    value: Value.positive,
    fallback: fallback.off("no projection"),
    doc: "A program count the bench report projects its measured cost onto."
  }),
  LLM4TS_TARGET_KIND: setting({
    group: "modernization",
    scope: "run",
    value: Value.oneOf(["frontend", "backend"]),
    fallback: fallback.off("none"),
    requiredBy: ["pack-fork"],
    doc: "Which side of the target repository pack-fork reads conventions from."
  }),
  LLM4TS_FORK_AS: setting({
    group: "modernization",
    scope: "run",
    value: Value.text,
    fallback: fallback.off("none"),
    requiredBy: ["pack-fork"],
    doc: "The forked pack's name, lowercase kebab-case."
  }),
  LLM4TS_FEEDBACK: setting({
    group: "modernization",
    scope: "run",
    value: Value.text,
    fallback: fallback.off("none: a fresh fork"),
    doc: "What to fix in the fork LLM4TS_FORK_AS names, revising it instead of starting over."
  }),

  // ---- ports ------------------------------------------------------------------
  LLM4TS_PORT_PILOT: setting({
    group: "ports",
    scope: "run",
    value: Value.count,
    fallback: fallback.value(0, "0: no pilot"),
    doc: "Ports this many files first, then stops for an approval of the pilot report."
  }),
  LLM4TS_PORT_CONCURRENCY: setting({
    group: "ports",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(4, "4"),
    doc: "Files the port flows work on at once."
  }),
  LLM4TS_PORT_BATCH: setting({
    group: "ports",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(100, "100"),
    doc: "Files port-files takes from the queue per run."
  }),
  LLM4TS_PORT_SOURCE_CHARS: setting({
    group: "ports",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(120_000, "120000"),
    doc: "How many characters of one source file a port prompt carries; at least 1000."
  }),
  LLM4TS_PORT_SHARDS: setting({
    group: "ports",
    scope: "project",
    value: Value.count,
    fallback: fallback.value(0, "0: one checkout"),
    doc: "Worktrees port-files spreads its work over, under .llm4ts/port/shards."
  }),
  LLM4TS_PORT_TEST_ROUNDS: setting({
    group: "ports",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(4, "4"),
    doc: "Fix rounds port-tests gives a red test gate."
  }),
  LLM4TS_PORT_COMPILE_ROUNDS: setting({
    group: "ports",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(6, "6"),
    doc: "Fix rounds port-compile gives a red build."
  }),
  LLM4TS_PORT_GUIDE_SAMPLE: setting({
    group: "ports",
    scope: "project",
    value: Value.positive,
    fallback: fallback.value(3, "3"),
    doc: "Files port-guide samples to draft the porting guide."
  }),
  LLM4TS_PORT_GUIDE_TRIAL: setting({
    group: "ports",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(true, "on"),
    doc: "The trial port that proves port-guide's draft; off skips it."
  }),

  // ---- kit: soap-ace ----------------------------------------------------------
  LLM4TS_SOAP_SERVICE: setting({
    group: "soap-ace",
    scope: "project",
    value: Value.text,
    fallback: fallback.off("the only service discovered; several need the name"),
    doc: "The SOAP service the soap flows work on, and the folder of its auth.json."
  }),
  LLM4TS_SOAP_ENV: setting({
    group: "soap-ace",
    scope: "run",
    value: Value.text,
    fallback: fallback.off("the default profile, auth.json"),
    doc: "The environment whose auth.<env>.json the soap flows use; `-- --env` sets it too."
  }),
  LLM4TS_SOAP_STUB: setting({
    group: "soap-ace",
    scope: "project",
    value: Value.path,
    fallback: fallback.off("calls go to the network"),
    doc: "A folder of recorded <operation>.xml responses that answers SOAP calls instead of the network."
  }),
  LLM4TS_ACE_API: setting({
    group: "soap-ace",
    scope: "project",
    value: Value.text,
    fallback: fallback.perFlow("derived from the service: DemoBankService gives DemoBankApi"),
    doc: "The name of the ACE API project soap-epic builds."
  }),

  // ---- kit: j2ee-nextjs -------------------------------------------------------
  LLM4TS_ADO_ORG_URL: setting({
    group: "j2ee-nextjs",
    scope: "project",
    value: Value.url,
    fallback: fallback.off("no Azure DevOps mirror"),
    doc: "The Azure DevOps organization convert-all mirrors its board to; needs LLM4TS_ADO_PROJECT."
  }),
  LLM4TS_ADO_PROJECT: setting({
    group: "j2ee-nextjs",
    scope: "project",
    value: Value.text,
    fallback: fallback.off("no Azure DevOps mirror"),
    doc: "The Azure DevOps project of the work-item mirror."
  }),
  LLM4TS_ADO_REPO: setting({
    group: "j2ee-nextjs",
    scope: "project",
    value: Value.text,
    fallback: fallback.perFlow("the project's name"),
    doc: "The Azure DevOps repository the mirrored work items link to."
  }),
  LLM4TS_FAIL_FAST: setting({
    group: "j2ee-nextjs",
    scope: "run",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Stops convert-all at the first page that fails instead of marking it and going on."
  }),

  // ---- terminal ---------------------------------------------------------------
  LLM4TS_VERBOSITY: setting({
    group: "terminal",
    scope: "global",
    value: Value.oneOf(["quiet", "normal", "verbose", "debug"]),
    fallback: fallback.value("normal", "normal"),
    flag: "--verbose",
    doc: "How much the terminal shows."
  }),
  LLM4TS_UI: setting({
    group: "terminal",
    scope: "global",
    value: Value.oneOf(["classic", "tree"]),
    fallback: fallback.value("classic", "classic"),
    flag: "--ui",
    doc: "tree draws the agent tree full-screen on a terminal; q returns to the classic view."
  }),
  LLM4TS_TIMESTAMPS: setting({
    group: "terminal",
    scope: "global",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Prefixes every terminal line with the time."
  }),
  LLM4TS_TRANSCRIPT: setting({
    group: "terminal",
    scope: "global",
    value: Value.toggle,
    fallback: fallback.perFlow("off; on in the epic flows"),
    flag: "--transcript",
    doc: "Records what each seat is told and answers under .llm4ts/transcripts/, for `llm4ts watch --tail`."
  }),
  LLM4TS_IDLE_AFTER: setting({
    group: "terminal",
    scope: "global",
    value: Value.span,
    fallback: fallback.value(Duration.minutes(2), "2m"),
    doc: "How long a lane of the agent tree may be silent before it is marked idle."
  }),
  LLM4TS_TOOL_BRIEF: setting({
    group: "terminal",
    scope: "project",
    value: Value.toggle,
    fallback: fallback.value(true, "on"),
    doc: "The paragraph of a coder's brief that lists the pack's tool presets; off drops it."
  }),

  // ---- telemetry --------------------------------------------------------------
  LLM4TS_OTEL: setting({
    group: "telemetry",
    scope: "global",
    value: Value.toggle,
    fallback: fallback.off("off, unless OTEL_EXPORTER_OTLP_ENDPOINT is set"),
    flag: "--otel",
    doc: "Exports spans over OTLP, to a local Phoenix unless the OTEL_* variables say otherwise; off silences export even with an endpoint set."
  }),
  LLM4TS_OTEL_CONTENT: setting({
    group: "telemetry",
    scope: "global",
    value: Value.oneOf(["off", "on", "full"]),
    fallback: fallback.value("off", "off"),
    flag: "--otel-content",
    doc: "What exported spans carry besides usage: on adds prompts, replies and tool I/O; full the system prompt too."
  }),
  LLM4TS_ESTIMATE_USAGE: setting({
    group: "telemetry",
    scope: "global",
    value: Value.toggle,
    fallback: fallback.value(true, "on"),
    doc: "Estimates token usage from character counts for seats whose backend reports none."
  }),
  LLM4TS_ESTIMATE_MODEL: setting({
    group: "telemetry",
    scope: "global",
    value: Value.text,
    fallback: fallback.value("claude-sonnet-4", "claude-sonnet-4"),
    doc: "The price-list model usage estimates are priced as."
  }),
  LLM4TS_ESTIMATE_CHARS_PER_TOKEN: setting({
    group: "telemetry",
    scope: "global",
    value: Value.positive,
    fallback: fallback.value(4, "4"),
    doc: "Characters per token in usage estimates."
  }),

  // ---- gemini bridge ----------------------------------------------------------
  LLM4TS_GEMINI_BRIDGE: setting({
    group: "gemini-bridge",
    scope: "global",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Starts the local Gemini bridge for pi seats during a run."
  }),
  LLM4TS_GEMINI_BRIDGE_MODE: setting({
    group: "gemini-bridge",
    scope: "global",
    value: Value.oneOf(["acp", "model"]),
    fallback: fallback.value("acp", "acp"),
    doc: "The route the bridge serves: acp, a Gemini ACP session, or model, one locked-down gemini call per request."
  }),
  LLM4TS_GEMINI_BRIDGE_MODEL: setting({
    group: "gemini-bridge",
    scope: "global",
    value: Value.text,
    fallback: fallback.perFlow("the one bridge model pi's models.json offers"),
    doc: "The provider/model pi is started with when its models.json offers several bridge models."
  }),
  LLM4TS_GEMINI_BRIDGE_PORT: setting({
    group: "gemini-bridge",
    scope: "global",
    value: Value.positive,
    fallback: fallback.value(8731, "8731"),
    doc: "The port on 127.0.0.1 the bridge listens on."
  }),
  LLM4TS_GEMINI_BRIDGE_TOKEN: setting({
    group: "gemini-bridge",
    scope: "secret",
    value: Value.text,
    fallback: fallback.off("no token required"),
    doc: "The bearer every bridge request must carry in model mode; also pi's apiKey."
  }),
  LLM4TS_GEMINI_MODEL: setting({
    group: "gemini-bridge",
    scope: "global",
    value: Value.text,
    fallback: fallback.off("the model pi's request names"),
    doc: "The Gemini model the bridge reasons with."
  }),

  // ---- operator ---------------------------------------------------------------
  LLM4TS_MCP_TOKEN: setting({
    group: "operator",
    scope: "secret",
    shellOnly: true,
    value: Value.text,
    fallback: fallback.off("no HTTP transport without --token-file"),
    doc: "The bearer token of `llm4ts mcp --http`; never reaches a flow."
  }),

  // ---- launch -----------------------------------------------------------------
  LLM4TS_FLOW: setting({
    group: "launch",
    scope: "internal",
    value: Value.text,
    fallback: fallback.off("set by the launcher"),
    doc: "The running flow's name, for its spans."
  }),
  LLM4TS_RUN_ID: setting({
    group: "launch",
    scope: "internal",
    value: Value.text,
    fallback: fallback.off("the runner makes one"),
    doc: "The run's id, set by the MCP operator so it can find the run it started."
  }),
  LLM4TS_TRACE_PATH: setting({
    group: "launch",
    scope: "internal",
    value: Value.path,
    fallback: fallback.off(".llm4ts/trace-<start>.jsonl in the repository"),
    doc: "Where the run writes its trace, set by the MCP operator."
  })
} as const
