import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import {
  makeFakeProcessExecutor,
  processCommandKey,
  ProcessResult
} from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { Reviewer } from "@llm4ts/flow/Reviewer"
import { parseNote } from "@llm4ts/flow/Memory"
import { parsePlan, parseReport } from "@llm4ts/flow/Taskforce"
import {
  declaredCommands,
  ejectPersonas,
  engineerReport,
  parseTaskforceArgs,
  resolveCast,
  runDir,
  runTaskforce,
  shellWords,
  type TaskforceDeps
} from "../lib/taskforce.ts"
import { replying, scripted } from "./support.ts"

const workDir = "/repo"
const dir = runDir(workDir, "gateway")

const proposedBrief = (
  title: string,
  owner: string,
  extra: { dependsOn?: ReadonlyArray<string>; verify?: ReadonlyArray<string>; report?: string } = {}
) => ({
  title,
  owner,
  dependsOn: extra.dependsOn ?? [],
  goal: `Do: ${title}`,
  scope: "src/auth",
  context: "Start from src/auth/index.ts.",
  acceptance: ["It is done."],
  verify: extra.verify ?? [],
  timebox: "10 turns",
  forbidden: "Anything else.",
  report: extra.report ?? "reports with the findings for result.md"
})

const reportReply = (
  status: "PASS" | "ISSUES" | "BLOCKED",
  summary: string,
  extra: { questions?: ReadonlyArray<{ question: string; assumption: string }> } = {}
) => ({
  status,
  evidence: ["src/auth/index.ts"],
  summary,
  questions: extra.questions ?? [],
  body: `## Findings\n\n${summary}`
})

const draftReply = (answer: string) => ({
  documents: [
    {
      name: "result.md",
      content: `# Result\n\n## Answer\n\n${answer}\n\n## Sources\n\n- reports/B1.md`
    }
  ]
})

const setup = (
  options: {
    truth?: number
    memory?: boolean
    allowed?: boolean
    agents?: ReadonlyArray<string>
  } = {}
) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const files = memory.store
    const events = yield* makeCollectingFlowEvents
    const fake = yield* makeFakeJudgment({ defaultTruth: options.truth ?? 0.9 })
    const processes = yield* makeFakeProcessExecutor({
      responses: new Map([
        [
          processCommandKey(["pnpm", "test"]),
          ProcessResult.make({ stdout: ["3 passed"], exitCode: 0 })
        ]
      ])
    })
    const removed = yield* Ref.make<ReadonlyArray<string>>([])
    const cast = yield* resolveCast(
      {},
      options.agents ?? ["Researcher", "Engineer", "Operator", "Reviewer"],
      options.memory ?? false
    )
    const run = (
      toolless: ReadonlyArray<unknown>,
      readOnly: ReadonlyArray<unknown>,
      overrides: Partial<TaskforceDeps> = {}
    ) =>
      Effect.gen(function* () {
        const chief = yield* scripted(toolless)
        const reader = yield* scripted(readOnly)
        const outcome = yield* runTaskforce({
          files,
          events,
          workDir,
          runId: "gateway",
          goal: "Can the auth module move behind the gateway?",
          cast,
          context: [{ path: "standards/api.md", text: "Every API is versioned." }],
          notes: [parseNote("auth", "# Auth module\n\n## Gateway\n\nKong fronts it.")],
          caps: { waves: 3, briefs: 12 },
          parallel: 1,
          noPause: true,
          keepWork: false,
          memory: options.memory ?? false,
          budget: 20_000,
          seats: { toolless: chief.service, readOnly: reader.service },
          judgment: fake.judgment,
          lenses: [Reviewer.make({ name: "evidence", systemPrompt: "Every claim has a report." })],
          processes: processes.executor,
          allowedCommand: () => options.allowed ?? true,
          workspaceFor: (brief) =>
            Effect.succeed({
              dir: `/work/${brief.id}`,
              coder: replying(
                "Built a spike behind the gateway; ran it.\n\nREPORT: PASS — the spike answers on /auth behind Kong"
              ),
              diff: Effect.succeed(
                "diff --git a/src/auth/spike.ts b/src/auth/spike.ts\n+export const spike = 1\n"
              )
            }),
          removeWorkspace: (path) => Ref.update(removed, (all) => [...all, path]),
          now: () => "2026-10-31T09:00:00.000Z",
          ...overrides
        })
        return { outcome, prompts: yield* chief.prompts, readerPrompts: yield* reader.prompts }
      })
    const read = (path: string) => Effect.map(files.read(`${dir}/${path}`), (text) => text ?? "")
    return { files, events, run, read, processes, removed, cast }
  })

describe("taskforce flags and cast", () => {
  it.effect("parses its flags and passes the rest on", () =>
    Effect.gen(function* () {
      const flags = yield* parseTaskforceArgs([
        "--agents",
        "Researcher, Engineer",
        "--run=x",
        "--waves",
        "2",
        "--parallel",
        "3",
        "--no-pause",
        "--keep-work",
        "--no-memory",
        "--repo",
        "/r"
      ])
      assert.deepStrictEqual(flags.agents, ["Researcher", "Engineer"])
      assert.strictEqual(flags.run, "x")
      assert.strictEqual(flags.waves, 2)
      assert.strictEqual(flags.parallel, 3)
      assert.isTrue(flags.noPause && flags.keepWork && flags.noMemory)
      assert.deepStrictEqual(flags.rest, ["--repo", "/r"])
      const bad = yield* Effect.flip(parseTaskforceArgs(["--waves", "zero"]))
      assert.strictEqual(bad._tag, "ScriptUsage")
    })
  )

  it.effect(
    "the Chief of Staff and the Doc Writer are always in; memory adds the Memory Manager; unknown names refuse",
    () =>
      Effect.gen(function* () {
        const cast = yield* resolveCast({}, ["Researcher"], true)
        assert.deepStrictEqual(
          cast.all.map((persona) => persona.name),
          ["Chief of Staff", "Researcher", "Doc Writer", "Memory Manager"]
        )
        const lean = yield* resolveCast({}, ["Researcher"], false)
        assert.deepStrictEqual(
          lean.all.map((persona) => persona.name),
          ["Chief of Staff", "Researcher", "Doc Writer"]
        )
        const custom = yield* resolveCast(
          {
            Researcher:
              "---\nname: Researcher\n---\n\n## Mandate\n\nRead only the ADRs.\n\n## Tools\n\nread-only\n"
          },
          ["Researcher"],
          false
        )
        assert.strictEqual(
          custom.all.find((persona) => persona.name === "Researcher")?.mandate,
          "Read only the ADRs."
        )
        const unknown = yield* Effect.flip(resolveCast({}, ["Plumber"], false))
        assert.strictEqual(unknown._tag, "ScriptUsage")
        assert.include(unknown.message, "Plumber")
      })
  )

  it.effect("ejects the bundled cards once", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const first = yield* ejectPersonas(memory.store, workDir)
      assert.strictEqual(first.length, 7)
      assert.include(first, "/repo/.llm4ts/personas/Chief of Staff.md")
      const again = yield* ejectPersonas(memory.store, workDir)
      assert.deepStrictEqual(again, [])
    })
  )

  it("commands: shell words, declared scripts, the Engineer's REPORT line", () => {
    assert.deepStrictEqual(shellWords(`pnpm test -- --grep "auth module" 'x y'`), [
      "pnpm",
      "test",
      "--",
      "--grep",
      "auth module",
      "x y"
    ])
    const allowed = declaredCommands(
      '{"scripts": {"test": "vitest", "lint": "eslint ."}}',
      "# ok\n- `make smoke`\nrm -rf x\n"
    )
    assert.isTrue(allowed(["pnpm", "test"]))
    assert.isTrue(allowed(["npm", "run", "lint"]))
    assert.isTrue(allowed(["npm", "test"]))
    assert.isTrue(allowed(["make", "smoke"]))
    assert.isTrue(allowed(["rm", "-rf", "x"]))
    assert.isFalse(allowed(["pnpm", "deploy"]))
    assert.isFalse(allowed(["curl", "x"]))
    assert.isFalse(declaredCommands(undefined, undefined)(["pnpm", "test"]))
    assert.deepStrictEqual(engineerReport("did things\nREPORT: ISSUES — one test red\n"), {
      status: "ISSUES",
      summary: "one test red"
    })
    assert.isUndefined(engineerReport("ran out"))
  })
})

describe("runTaskforce (ADR 0047)", () => {
  it.effect(
    "runs a whole taskforce: plan, wave, check, draft, review, fix wave, redraft, done",
    () =>
      Effect.gen(function* () {
        const t = yield* setup({
          memory: true,
          agents: ["Researcher", "Engineer", "Operator", "Reviewer", "Memory Manager"]
        })
        const { outcome, prompts, readerPrompts } = yield* t.run(
          [
            // The Chief of Staff's plan: the Engineer's VERIFY is routed to an Operator brief.
            {
              deliverables: ["result.md"],
              briefs: [
                proposedBrief("Survey the auth module", "Researcher"),
                proposedBrief("Spike auth behind the gateway", "Engineer", {
                  dependsOn: ["B1"],
                  verify: ["pnpm test"]
                })
              ]
            },
            // The Operator's write-up after code ran pnpm test in the Engineer's worktree.
            reportReply("PASS", "pnpm test: exit 0, 3 passed"),
            // The goal check.
            { reached: true, note: "The spike answers; the survey found no blocker.", briefs: [] },
            // The Doc Writer's draft.
            draftReply("Yes: the module moves behind the gateway in one release."),
            // The Doc Writer's redraft after the fix wave.
            draftReply("Yes, behind the gateway, with the session store kept; see the spike diff."),
            // The Memory Manager's run note.
            {
              decisions: ["Gateway: Kong, sessions kept."],
              preferences: [],
              failed: [],
              pointers: ["reports/B2.md"]
            }
          ],
          [
            // The Researcher's report, with a question for the owner.
            reportReply("PASS", "Sessions live in Redis; the gateway terminates TLS.", {
              questions: [
                { question: "Keep server-side sessions?", assumption: "Yes, for the first release" }
              ]
            }),
            // The evidence lens: one finding about the Engineer's work.
            {
              findings: [
                {
                  title: "The spike has no test",
                  where: "work/B2.diff",
                  brief: "B2",
                  detail: "The diff adds code and no test."
                }
              ]
            }
          ]
        )
        assert.strictEqual(outcome._tag, "Finished")
        const plan = yield* parsePlan(yield* t.read("plan.md"))
        assert.strictEqual(plan.status, "done")
        assert.deepStrictEqual(
          plan.briefs.map((brief) => [brief.id, brief.owner, brief.wave]),
          [
            ["B1", "Researcher", 1],
            ["B2", "Engineer", 1],
            ["B3", "Operator", 1],
            ["B4", "Engineer", 2]
          ]
        )
        assert.strictEqual(plan.briefs[3]?.title, "Fix: The spike has no test")
        assert.deepStrictEqual(
          plan.checks.map((check) => [check.wave, check.reached]),
          [[1, true]]
        )
        assert.strictEqual(plan.drafts, 2)
        assert.deepStrictEqual(
          plan.answers.map((point) => point.question),
          ["Keep server-side sessions? (B1, assuming: Yes, for the first release)"]
        )
        const b2 = yield* parseReport(yield* t.read("reports/B2.md"))
        assert.strictEqual(b2.status, "PASS")
        assert.deepStrictEqual(b2.evidence, ["work/B2.diff"])
        assert.include(yield* t.read("work/B2.diff"), "spike.ts")
        const b3 = yield* parseReport(yield* t.read("reports/B3.md"))
        assert.include(b3.evidence.join(","), "reports/B3-commands.log")
        assert.include(yield* t.read("reports/B3-commands.log"), "$ pnpm test\nexit 0\n3 passed")
        // The Operator ran in the Engineer's worktree, which was removed once its dependents ended.
        const invocations = yield* t.processes.recorded
        assert.deepStrictEqual(
          invocations.map((call) => [call.argv, call.cwd]),
          [[["pnpm", "test"], "/work/B2"]]
        )
        assert.deepStrictEqual(yield* Ref.get(t.removed), ["/work/B2", "/work/B4"])
        assert.include(yield* t.read("result.md"), "session store kept")
        const review = yield* t.read("review.md")
        assert.include(
          review,
          "## Act on\n\n- 1. The spike has no test (evidence, B2; work/B2.diff)"
        )
        const trail = yield* t.read("decisions.tsv")
        assert.isTrue(trail.startsWith("ts\tphase\tdecision\twhy\tevidence\tresult\n"))
        assert.include(trail, "\twave 1\tdispatched B1 to Researcher\t")
        assert.include(trail, "\tcheck\twave 1: reached\t")
        assert.include(trail, "\treview\tfinding 1 act-on: The spike has no test\t")
        assert.include(yield* t.read("open-questions.md"), "Keep server-side sessions?")
        const note = (yield* t.files.read("/repo/.llm4ts/memory/runs/gateway.md")) ?? ""
        assert.include(note, "## Decisions\n\n- Gateway: Kong, sessions kept.")
        // Memory was recalled into the prompts; the context documents too.
        assert.include(prompts[0], "Kong fronts it.")
        assert.include(readerPrompts[0], "Every API is versioned.")
        assert.include(readerPrompts[0], "Brief B1: Survey the auth module")
        // The run is visible: a lane per specialist, a report per brief, the waves as stages.
        const recorded = yield* t.events.recorded
        const started = recorded.flatMap((event) =>
          event._tag === "StageStarted" ? [event.stage] : []
        )
        assert.deepStrictEqual(
          started.filter((stage) => stage.startsWith("specialist ")),
          [
            "specialist Chief of Staff",
            "specialist Researcher",
            "specialist Engineer",
            "specialist Operator",
            "specialist Reviewer",
            "specialist Doc Writer",
            "specialist Memory Manager"
          ]
        )
        assert.deepStrictEqual(
          started.filter((stage) => stage.startsWith("wave ")),
          ["wave 1", "wave 1", "wave 1", "wave 2"]
        )
        const reports = recorded.flatMap((event) => (event._tag === "BriefReported" ? [event] : []))
        assert.deepStrictEqual(
          reports.map((event) => [event.lane, event.brief, event.status, event.wave]),
          [
            ["Researcher", "B1", "PASS", 1],
            ["Engineer", "B2", "PASS", 1],
            ["Operator", "B3", "PASS", 1],
            ["Engineer", "B4", "PASS", 2]
          ]
        )
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "StageCompleted" && event.stage === "specialist Engineer"
          )
        )
        // A second run finds nothing to do.
        const again = yield* t.run([], [])
        assert.strictEqual(again.outcome._tag, "NothingToDo")
      })
  )

  it.effect("stops after the plan for the owner, and a rerun opens the edited plan", () =>
    Effect.gen(function* () {
      const t = yield* setup({ agents: ["Researcher"] })
      const halted = yield* Effect.flip(
        t.run(
          [
            {
              deliverables: [],
              briefs: [proposedBrief("One", "Researcher"), proposedBrief("Two", "Researcher")]
            }
          ],
          [],
          { noPause: false }
        )
      )
      assert.strictEqual(halted._tag, "PlanPending")
      const text = yield* t.read("plan.md")
      assert.include(text, "Status: planned")
      assert.include(text, "### B1. One")
      // The owner drops a brief and reruns; the plan now needs two briefs, so it is refused.
      yield* t.files.writeAtomic(
        `${dir}/plan.md`,
        text.replace(/### B2\. Two[\s\S]*?(?=## Goal checks)/, "")
      )
      const refused = yield* Effect.flip(t.run([], [], { noPause: false }))
      assert.strictEqual(refused._tag, "PlanInvalid")
      assert.include(refused.message, "2 to 12 briefs, got 1")
    })
  )

  it.effect("a plan refused twice stops the run with the violations", () =>
    Effect.gen(function* () {
      const t = yield* setup({ agents: ["Researcher"] })
      const one = { deliverables: [], briefs: [proposedBrief("Only", "Plumber")] }
      const error = yield* Effect.flip(t.run([one, one], []))
      assert.strictEqual(error._tag, "PlanInvalid")
      assert.include(error.message, "owner Plumber is not in the cast")
      assert.include(yield* t.read("decisions.tsv"), "plan refused twice")
    })
  )

  it.effect(
    "under --no-pause an undeclared command blocks the Operator without a seat, twice, and the run goes on",
    () =>
      Effect.gen(function* () {
        const t = yield* setup({
          allowed: false,
          truth: 0.1,
          agents: ["Researcher", "Operator", "Reviewer"]
        })
        const { outcome } = yield* t.run(
          [
            {
              deliverables: [],
              briefs: [
                proposedBrief("Survey", "Researcher", { verify: ["make deploy"] }),
                proposedBrief("Read the ADRs", "Researcher")
              ]
            },
            { reached: true, note: "Enough.", briefs: [] },
            draftReply("Yes.")
          ],
          [
            reportReply("PASS", "Surveyed."),
            reportReply("PASS", "Read."),
            {
              findings: [
                {
                  title: "Vague answer",
                  where: "result.md",
                  brief: "",
                  detail: "Says yes without a reason."
                }
              ]
            },
            { verdicts: [{ id: 1, bucket: "dismissed", reason: "The reports carry the reason." }] }
          ]
        )
        assert.strictEqual(outcome._tag, "Finished")
        const plan = yield* parsePlan(yield* t.read("plan.md"))
        assert.strictEqual(plan.status, "done")
        assert.deepStrictEqual(
          plan.briefs.map((brief) => [brief.id, brief.owner]),
          [
            ["B1", "Researcher"],
            ["B2", "Researcher"],
            ["B3", "Operator"]
          ]
        )
        const b3 = yield* parseReport(yield* t.read("reports/B3.md"))
        assert.strictEqual(b3.status, "BLOCKED")
        assert.strictEqual(b3.attempt, 2)
        assert.include(b3.summary, "make deploy")
        assert.deepStrictEqual(yield* t.processes.recorded, [])
        assert.include(
          yield* t.read("open-questions.md"),
          "- B3 Verify B1 (Operator): command not declared"
        )
        assert.include(yield* t.read("review.md"), "## Dismissed\n\n- 1. Vague answer")
        assert.strictEqual(plan.drafts, 1)
      })
  )

  it.effect("a BLOCKED brief is retried once with its report in the prompt", () =>
    Effect.gen(function* () {
      const t = yield* setup({ agents: ["Researcher"] })
      const { outcome, readerPrompts } = yield* t.run(
        [
          {
            deliverables: [],
            briefs: [proposedBrief("Survey", "Researcher"), proposedBrief("Read", "Researcher")]
          },
          { reached: true, note: "ok", briefs: [] },
          draftReply("Yes.")
        ],
        [
          reportReply("BLOCKED", "No access to src/auth yet."),
          reportReply("PASS", "Read."),
          reportReply("PASS", "Surveyed on the second try."),
          { findings: [] }
        ]
      )
      assert.strictEqual(outcome._tag, "Finished")
      const b1 = yield* parseReport(yield* t.read("reports/B1.md"))
      assert.strictEqual(b1.attempt, 2)
      assert.strictEqual(b1.status, "PASS")
      assert.include(
        readerPrompts[2],
        "Your previous attempt was BLOCKED: No access to src/auth yet."
      )
      assert.include(yield* t.read("decisions.tsv"), "dispatched B1 to Researcher again")
    })
  )

  it.effect(
    "an answer written after done reopens the brief that asked, one wave on, and redrafts",
    () =>
      Effect.gen(function* () {
        const t = yield* setup({ agents: ["Researcher"] })
        yield* t.files.writeAtomic(
          `${dir}/plan.md`,
          [
            "# Taskforce: gateway",
            "",
            "Status: done",
            "Goal: Can the auth module move behind the gateway?",
            "Deliverables: result.md",
            "Cast: Chief of Staff, Researcher, Doc Writer",
            "Drafts: 1",
            "Folded: -",
            "",
            "## Briefs",
            "",
            "### B1. Survey",
            "Owner: Researcher",
            "Depends on: -",
            "Wave: 1",
            "",
            "GOAL: Survey the module",
            "SCOPE: src/auth",
            "CONTEXT: none",
            "ACCEPTANCE:",
            "- done",
            "VERIFY:",
            "TIMEBOX: 10 turns",
            "FORBIDDEN: nothing",
            "REPORT: reports/B1.md for result.md",
            "",
            "### B2. Read",
            "Owner: Researcher",
            "Depends on: -",
            "Wave: 1",
            "",
            "GOAL: Read the ADRs",
            "SCOPE: docs",
            "CONTEXT: none",
            "ACCEPTANCE:",
            "- done",
            "VERIFY:",
            "TIMEBOX: 10 turns",
            "FORBIDDEN: nothing",
            "REPORT: reports/B2.md for result.md",
            "",
            "## Goal checks",
            "",
            "- wave 1: reached — fine",
            "",
            "## Answers",
            "",
            "1. Keep sessions? (B1, assuming: yes)",
            "   answer: No, drop them",
            "",
            "## Feedback",
            ""
          ].join("\n")
        )
        for (const id of ["B1", "B2"]) {
          yield* t.files.writeAtomic(
            `${dir}/reports/${id}.md`,
            `# ${id}: x\nStatus: PASS\nAttempt: 1\nEvidence: -\nSummary: done\n\nbody\n`
          )
        }
        yield* t.files.writeAtomic(`${dir}/result.md`, "# Result\n\nSessions kept.\n")
        const { outcome, readerPrompts } = yield* t.run(
          [{ reached: true, note: "folded", briefs: [] }, draftReply("Sessions dropped.")],
          [reportReply("PASS", "Redone without sessions.")]
        )
        assert.strictEqual(outcome._tag, "Finished")
        const plan = yield* parsePlan(yield* t.read("plan.md"))
        assert.strictEqual(plan.status, "done")
        assert.deepStrictEqual(plan.folded, [1])
        assert.strictEqual(plan.briefs[2]?.id, "B3")
        assert.strictEqual(plan.briefs[2]?.wave, 2)
        assert.include(plan.briefs[2]?.context ?? "", "No, drop them")
        assert.include(readerPrompts[0], "Brief B3: Rework B1: Survey")
        assert.include(yield* t.read("result.md"), "Sessions dropped.")
        assert.strictEqual(plan.drafts, 2)
      })
  )
})
