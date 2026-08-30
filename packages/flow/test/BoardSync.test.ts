import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { WorkItem, type AzureDevOpsToolShape } from "@llm4ts/flow/AzureDevOpsTool"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import {
  Board,
  BoardItem,
  makeAdoBoardSync,
  makeLocalBoardSync,
  renderBoard
} from "@llm4ts/flow/BoardSync"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

const planned = (id: string, title: string, wave?: string): BoardItem =>
  BoardItem.make({ id, title, status: "planned", ...(wave === undefined ? {} : { wave }) })

describe("BoardSync local adapter", () => {
  it.effect("walks the lifecycle and keeps board.json and board.md in step", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const board = makeLocalBoardSync(memory.store, ".llm4ts/convert", "DemoBank conversion")

      yield* board.plan([
        planned("accountOverview", "Account overview", "wave-1"),
        planned("transferStep1", "Wire transfer", "wave-2")
      ])
      yield* board.start("accountOverview")
      yield* board.complete("accountOverview", {
        branch: "convert/accountOverview",
        reportPath: "reports/accountOverview.md",
        estimatedTokens: 1234,
        estimatedCostUsd: 0.42
      })
      yield* board.fail("transferStep1", "verify gate failed")

      const snapshot = yield* board.snapshot
      const files = yield* memory.files
      const markdown = files[".llm4ts/convert/board.md"] ?? ""

      assert.strictEqual(snapshot.items.length, 2)
      assert.strictEqual(snapshot.items[0]?.status, "done")
      assert.strictEqual(snapshot.items[0]?.branch, "convert/accountOverview")
      assert.strictEqual(snapshot.items[1]?.status, "failed")
      assert.strictEqual(snapshot.items[1]?.detail, "verify gate failed")
      assert.include(markdown, "# Board: DemoBank conversion")
      assert.include(markdown, "ESTIMATES")
      assert.include(markdown, "~1234 tokens")
      assert.include(markdown, "~$0.42")
      assert.isDefined(files[".llm4ts/convert/board.json"])
    })
  )

  it.effect("re-planning never demotes lived state, and unknown ids fail typed", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const board = makeLocalBoardSync(memory.store, ".llm4ts", "board")

      yield* board.plan([planned("a", "Page A")])
      yield* board.start("a")
      yield* board.plan([planned("a", "Page A"), planned("b", "Page B")])
      const snapshot = yield* board.snapshot
      const missing = yield* Effect.flip(board.start("nope"))

      assert.strictEqual(snapshot.items.find((item) => item.id === "a")?.status, "active")
      assert.strictEqual(snapshot.items.find((item) => item.id === "b")?.status, "planned")
      assert.strictEqual(missing._tag, "Aborted")
      assert.include(missing.message, "nope")
    })
  )

  it("renders sections in board order with counts", () => {
    const markdown = renderBoard(
      Board.make({
        title: "b",
        items: [
          BoardItem.make({ id: "x", title: "X", status: "done" }),
          BoardItem.make({ id: "y", title: "Y", status: "planned" })
        ]
      })
    )

    assert.include(markdown, "planned: 1")
    assert.include(markdown, "done: 1")
    assert.include(markdown, "## Planned")
    assert.include(markdown, "## Done")
  })
})

// A hand-rolled tool fake: the adapter depends only on the shape, and the az
// CLI protocol behind it is covered by AzureDevOpsTool's own tests.
interface FakeAdo {
  readonly tool: AzureDevOpsToolShape
  readonly calls: Effect.Effect<ReadonlyArray<string>>
}

const makeFakeAdo = Effect.fn("test.makeFakeAdo")(function* (): Effect.fn.Return<FakeAdo> {
  const calls = yield* Ref.make<ReadonlyArray<string>>([])
  const state = yield* Ref.make<{
    readonly createdId: number | undefined
    readonly workItemState: string
    readonly tags: ReadonlyArray<string>
  }>({ createdId: undefined, workItemState: "New", tags: [] })
  const record = (call: string): Effect.Effect<void> =>
    Ref.update(calls, (current) => [...current, call])
  const unused = (name: string): Effect.Effect<never, FlowAborted> =>
    Effect.fail(FlowAborted.make({ message: `unexpected call: ${name}` }))

  const tool: AzureDevOpsToolShape = {
    readWorkItem: (id) =>
      Effect.gen(function* () {
        yield* record(`readWorkItem:${id}`)
        const current = yield* Ref.get(state)
        return WorkItem.make({
          id,
          title: "[accountOverview] Account overview",
          description: "",
          acceptanceCriteria: "",
          state: current.workItemState,
          tags: ["llm4ts-convert", ...current.tags],
          createdBy: "Demo",
          changedDate: "2026-08-30T00:00:00Z"
        })
      }),
    listWorkItems: () => unused("listWorkItems"),
    wiqlIds: (query) =>
      Effect.gen(function* () {
        yield* record(`wiql:${query}`)
        const current = yield* Ref.get(state)
        return current.createdId === undefined ? [] : [current.createdId]
      }),
    readComments: () => unused("readComments"),
    developmentLinks: () => unused("developmentLinks"),
    linkArtifact: () => unused("linkArtifact"),
    workItemLinks: () => unused("workItemLinks"),
    linkWorkItem: () => unused("linkWorkItem"),
    repository: () => unused("repository"),
    setFields: () => unused("setFields"),
    setState: (id, value) =>
      record(`setState:${id}:${value}`).pipe(
        Effect.andThen(Ref.update(state, (current) => ({ ...current, workItemState: value })))
      ),
    setAcceptanceCriteria: () => unused("setAcceptanceCriteria"),
    editTags: (id, add, _remove) =>
      record(`editTags:${id}:${add.join(",")}`).pipe(
        Effect.andThen(
          Ref.update(state, (current) => ({ ...current, tags: [...current.tags, ...add] }))
        )
      ),
    writeComment: (id, text) => record(`comment:${id}:${text}`),
    createWorkItem: (workItemType, title, description, tags) =>
      Effect.gen(function* () {
        yield* record(`create:${workItemType}:${title}:${(tags ?? []).join(",")}`)
        yield* Ref.update(state, (current) => ({ ...current, createdId: 42 }))
        return WorkItem.make({
          id: 42,
          title,
          description,
          acceptanceCriteria: "",
          state: "New",
          tags: tags ?? [],
          createdBy: "Demo",
          changedDate: "2026-08-30T00:00:00Z"
        })
      }),
    createPr: () => unused("createPr"),
    openPrForBranch: () => unused("openPrForBranch"),
    updatePr: () => unused("updatePr"),
    writePrComment: () => unused("writePrComment"),
    prPolicies: () => unused("prPolicies"),
    completePr: () => unused("completePr")
  }
  return { tool, calls: Ref.get(calls) }
})

describe("BoardSync ADO adapter", () => {
  it.effect("plans idempotently, transitions state, and marks failures with tags", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAdo()
      const board = yield* makeAdoBoardSync(fake.tool, "DemoBank conversion")

      yield* board.plan([planned("accountOverview", "Account overview")])
      yield* board.plan([planned("accountOverview", "Account overview")])
      yield* board.start("accountOverview")
      yield* board.complete("accountOverview", { branch: "convert/accountOverview" })
      yield* board.fail("accountOverview", "gate broke")
      const snapshot = yield* board.snapshot
      const calls = yield* fake.calls

      const creates = calls.filter((call) => call.startsWith("create:"))
      assert.strictEqual(creates.length, 1, "re-planning must not duplicate the work item")
      assert.include(creates[0], "create:Task:[accountOverview] Account overview:llm4ts-convert")
      assert.include(calls, "setState:42:Active")
      assert.include(calls, "setState:42:Closed")
      assert.include(calls, "editTags:42:llm4ts-convert-failed")
      assert.isTrue(calls.some((call) => call.includes("Branch: convert/accountOverview")))
      assert.isTrue(calls.some((call) => call.includes("FAILED: gate broke")))
      // WIQL values go through quoteWiql — quoted, injection-safe.
      assert.isTrue(calls.some((call) => call.includes("CONTAINS '[accountOverview]'")))
      assert.strictEqual(snapshot.items[0]?.id, "accountOverview")
      assert.strictEqual(snapshot.items[0]?.status, "failed")
    })
  )
})
