import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { settingValue, type SettingName } from "@llm4ts/flow/Settings"
import { parseStoriesFlags } from "../lib/debt.ts"
import {
  deferFindingsEnabled,
  gateCommands,
  gateTailChars,
  gateTimeoutSeconds,
  judgeRoundsOption,
  mergeRevisionsOption,
  reviewFixer,
  reviewVotes,
  serverHealthUrl,
  setupAgentEnabled,
  stallOptions,
  storiesEnvironment,
  storyContextChars,
  taskConcurrencyOption
} from "../lib/epic-stories.ts"
import { analystTurns, maxClosureFiles } from "../lib/modernize-extract.ts"
import { parseFeedback, parseForkAs, parseTargetKind } from "../lib/pack-fork.ts"
import { portEnv } from "../lib/port.ts"

const onWords = ["1", "true", "on", "yes", "TRUE", " On "]
const offWords = ["0", "false", "off", "no", "FALSE", " Off "]
const unreadable = ["maybe", "2", "enabled"]

type Environment = Readonly<Record<string, string | undefined>>

const deferTests = (environment: Environment): boolean =>
  Effect.runSync(parseStoriesFlags([], environment)).deferTests

/**
 * Each toggle as "is it on". The flow scripts cannot be imported (they run on
 * import), so a toggle a script reads inline is checked as the exact call the
 * script makes: `settingValue(name, process.env)`.
 */
const inline =
  (name: SettingName) =>
  (environment: Environment): boolean =>
    settingValue(name, environment) === true

const toggles: ReadonlyArray<{
  readonly name: string
  readonly unset: boolean
  readonly on: (environment: Environment) => boolean
}> = [
  {
    name: "LLM4TS_DEFER_FINDINGS",
    unset: false,
    on: (environment) => deferFindingsEnabled(false, environment)
  },
  { name: "LLM4TS_DEFER_TESTS", unset: false, on: deferTests },
  { name: "LLM4TS_SETUP_AGENT", unset: false, on: setupAgentEnabled },
  { name: "LLM4TS_MARK_DEEPEN", unset: false, on: inline("LLM4TS_MARK_DEEPEN") },
  { name: "LLM4TS_REGROUP", unset: false, on: inline("LLM4TS_REGROUP") },
  { name: "LLM4TS_FAIL_FAST", unset: false, on: inline("LLM4TS_FAIL_FAST") },
  { name: "LLM4TS_GRAPH_REFINE", unset: true, on: inline("LLM4TS_GRAPH_REFINE") },
  { name: "LLM4TS_PORT_GUIDE_TRIAL", unset: true, on: inline("LLM4TS_PORT_GUIDE_TRIAL") }
]

describe("toggle readers of the flows and kits", () => {
  for (const toggle of toggles) {
    it(`${toggle.name} takes 1|true|on|yes and 0|false|off|no in any case`, () => {
      assert.strictEqual(toggle.on({}), toggle.unset, "unset")
      assert.strictEqual(toggle.on({ [toggle.name]: "" }), toggle.unset, "empty")
      for (const word of onWords) {
        assert.isTrue(toggle.on({ [toggle.name]: word }), word)
      }
      for (const word of offWords) {
        assert.isFalse(toggle.on({ [toggle.name]: word }), word)
      }
      for (const word of unreadable) {
        assert.strictEqual(toggle.on({ [toggle.name]: word }), toggle.unset, word)
      }
    })
  }

  it("epic-stories turns transcripts on unless the run says otherwise", () => {
    assert.strictEqual(storiesEnvironment({}).LLM4TS_TRANSCRIPT, "on")
    assert.strictEqual(storiesEnvironment({ LLM4TS_TRANSCRIPT: " " }).LLM4TS_TRANSCRIPT, "on")
    for (const word of [...onWords, ...offWords, ...unreadable]) {
      assert.strictEqual(storiesEnvironment({ LLM4TS_TRANSCRIPT: word }).LLM4TS_TRANSCRIPT, word)
    }
  })
})

describe("an unreadable value counts as unset, one case per grammar", () => {
  it("toggle", () => {
    assert.isFalse(deferFindingsEnabled(false, { LLM4TS_DEFER_FINDINGS: "sometimes" }))
  })

  it("integer: text after the digits, a sign or a fraction is not a number", () => {
    for (const text of ["12abc", "+12", "12.5", "1e3", "-12"]) {
      assert.strictEqual(gateTailChars({ LLM4TS_GATE_TAIL_CHARS: text }), 4000, text)
      assert.deepStrictEqual(judgeRoundsOption(undefined, { LLM4TS_JUDGE_ROUNDS: text }), {}, text)
      assert.deepStrictEqual(
        mergeRevisionsOption(undefined, { LLM4TS_MERGE_REVISIONS: text }),
        {},
        text
      )
      assert.deepStrictEqual(storyContextChars({ LLM4TS_STORY_CONTEXT_CHARS: text }), {}, text)
      assert.strictEqual(portEnv({ LLM4TS_PORT_BATCH: text }).batch, 100, text)
    }
    assert.strictEqual(gateTailChars({ LLM4TS_GATE_TAIL_CHARS: " 12 " }), 12)
  })

  it("choice", () => {
    assert.deepStrictEqual(reviewFixer({ LLM4TS_REVIEW_FIXER: "joint" }), {})
  })

  it("duration", () => {
    assert.strictEqual(gateTimeoutSeconds({ LLM4TS_GATE_TIMEOUT: "90s" }), 1200)
    assert.deepStrictEqual(stallOptions({ LLM4TS_STALL_MINUTES: "20m" }), { repeats: 5 })
    assert.deepStrictEqual(stallOptions({ LLM4TS_STALL_MINUTES: "0" }), { repeats: 5 })
    assert.deepStrictEqual(
      stallOptions({ LLM4TS_STALL_MINUTES: "0.5" }).silence,
      Duration.seconds(30)
    )
  })

  it("an empty command list and a URL that is not one", () => {
    assert.deepStrictEqual(gateCommands({ LLM4TS_GATES: "  " }, undefined, [["make", "check"]]), [
      ["make", "check"]
    ])
    assert.strictEqual(
      serverHealthUrl("ollama", { LLM4TS_CODER_HEALTH_URL: "gpu:8080/health" }),
      "http://127.0.0.1:11434/api/tags"
    )
  })
})

describe("rules a flow keeps after the read", () => {
  it("the port flows take two review votes by default, and at least 1000 source characters", () => {
    assert.deepStrictEqual(portEnv({}), {
      pilot: 0,
      concurrency: 4,
      batch: 100,
      votes: 2,
      sourceChars: 120_000,
      shards: 0
    })
    assert.deepStrictEqual(
      portEnv({
        LLM4TS_PORT_PILOT: "3",
        LLM4TS_PORT_CONCURRENCY: "8",
        LLM4TS_PORT_BATCH: "25",
        LLM4TS_REVIEW_VOTES: "1",
        LLM4TS_PORT_SOURCE_CHARS: "1000",
        LLM4TS_PORT_SHARDS: "2"
      }),
      { pilot: 3, concurrency: 8, batch: 25, votes: 1, sourceChars: 1000, shards: 2 }
    )
    assert.strictEqual(portEnv({ LLM4TS_PORT_SOURCE_CHARS: "999" }).sourceChars, 120_000)
    assert.strictEqual(portEnv({ LLM4TS_PORT_CONCURRENCY: "0" }).concurrency, 4)
  })

  it("epic-stories asks for votes only above one, and a stall only from two repeats", () => {
    assert.deepStrictEqual(reviewVotes({ LLM4TS_REVIEW_VOTES: "3" }), { votes: 3 })
    assert.deepStrictEqual(reviewVotes({ LLM4TS_REVIEW_VOTES: "1" }), {})
    assert.strictEqual(stallOptions({ LLM4TS_STALL_REPEATS: "2" }).repeats, 2)
    assert.strictEqual(stallOptions({ LLM4TS_STALL_REPEATS: "1" }).repeats, 5)
  })

  it("an unset count leaves the executor's default; a flag wins over the setting", () => {
    assert.deepStrictEqual(mergeRevisionsOption(undefined, {}), {})
    assert.deepStrictEqual(mergeRevisionsOption(undefined, { LLM4TS_MERGE_REVISIONS: "0" }), {
      mergeRevisions: 0
    })
    assert.deepStrictEqual(taskConcurrencyOption(undefined, {}), {})
    assert.deepStrictEqual(taskConcurrencyOption(2, { LLM4TS_TASK_CONCURRENCY: "4" }), {
      taskConcurrency: 2
    })
    assert.deepStrictEqual(judgeRoundsOption(4, { LLM4TS_JUDGE_ROUNDS: "9" }), { judgeRounds: 4 })
  })

  it.effect("pack-fork names what it was given when it refuses", () =>
    Effect.gen(function* () {
      const kind = yield* Effect.flip(parseTargetKind({ LLM4TS_TARGET_KIND: " Mobile " }))
      assert.strictEqual(
        kind.message,
        "LLM4TS_TARGET_KIND must be 'frontend' or 'backend' (got 'mobile')"
      )
      const unset = yield* Effect.flip(parseTargetKind({ LLM4TS_TARGET_KIND: " " }))
      assert.include(unset.message, "(got unset)")
      const name = yield* Effect.flip(parseForkAs({ LLM4TS_FORK_AS: "Acme_Next" }))
      assert.include(name.message, "(got 'Acme_Next')")
      assert.include((yield* Effect.flip(parseForkAs({}))).message, "(got unset)")
      assert.strictEqual(parseFeedback({ LLM4TS_FEEDBACK: " tighter gates " }), "tighter gates")
    })
  )
})

describe("budgets the extraction flows read from the process environment", () => {
  const withEnvironment = <A>(values: Readonly<Record<string, string>>, read: () => A): A => {
    const before = Object.keys(values).map((name) => [name, process.env[name]] as const)
    Object.assign(process.env, values)
    try {
      return read()
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  }

  it("48 analyst turns and 40 closure files unless set to a positive integer", () => {
    assert.strictEqual(analystTurns(), 48)
    assert.strictEqual(maxClosureFiles(), 40)
    assert.strictEqual(withEnvironment({ LLM4TS_ANALYST_TURNS: "12" }, analystTurns), 12)
    assert.strictEqual(withEnvironment({ LLM4TS_ANALYST_TURNS: "12abc" }, analystTurns), 48)
    assert.strictEqual(withEnvironment({ LLM4TS_MAX_CLOSURE_FILES: "7" }, maxClosureFiles), 7)
    assert.strictEqual(withEnvironment({ LLM4TS_MAX_CLOSURE_FILES: "0" }, maxClosureFiles), 40)
  })
})
