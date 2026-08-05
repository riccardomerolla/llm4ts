import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  BasecampProjectRef,
  Column,
  cardAssignArgs,
  cardColumnsArgs,
  cardCommentCreateArgs,
  cardCommentsArgs,
  cardCreateArgs,
  cardListArgs,
  cardMoveArgs,
  cardShowArgs,
  cardStepCompleteArgs,
  cardStepsArgs,
  makeBasecampTool,
  parseCard,
  parseCardComments,
  parseCardSteps,
  parseCards,
  parseColumns
} from "@llm4ts/flow/BasecampTool"

const board = BasecampProjectRef.make({ project: "46683286" })
const ready = Column.make({ id: 9729692922, title: "Figuring it out" })

// Trimmed from real `basecamp … --json --quiet` output: extra fields stay to
// prove the decoders tolerate the full payloads.
const columnsJson =
  "[" +
  '{"id":9729692920,"title":"Triage","type":"Kanban::Triage","cards_count":0,' +
  '"bucket":{"id":46683286,"name":"LLM4ZIO","type":"Project"}},' +
  '{"id":9729692924,"title":"Done","type":"Kanban::DoneColumn","cards_count":3}' +
  "]"

const cardJson =
  '{"id":9953237984,"title":"Schema derivation","type":"Kanban::Card",' +
  '"content":"<div>A minimal endpoint</div>","completed":false,' +
  '"parent":{"id":9729692922,"title":"Figuring it out","type":"Kanban::Column"},' +
  '"assignees":[{"id":27418068,"name":"Riccardo Merolla"}],"comments_count":1,' +
  '"created_at":"2026-03-29T09:00:57.296Z","updated_at":"2026-08-01T10:00:00.000Z",' +
  '"app_url":"https://app.basecamp.com/4335725/buckets/46683286/card_tables/cards/9953237984"}'

const commentsJson =
  "[" +
  '{"id":9953911001,"title":"Re: Schema derivation","type":"Comment",' +
  '"content":"<p dir=\\"auto\\">Moved to Figuring it out</p>",' +
  '"creator":{"id":27418068,"name":"Riccardo Merolla","admin":true},' +
  '"created_at":"2026-08-01T09:00:00.000Z","updated_at":"2026-08-01T09:00:00.000Z"}' +
  "]"

const stepsJson =
  '[{"id":11,"title":"Wire the endpoint","completed":false,"position":1},' +
  '{"id":12,"title":"Add tests","completed":true,"position":2}]'

describe("Basecamp tool protocol", () => {
  it("builds deterministic card-table argv", () => {
    const scoped = BasecampProjectRef.make({ project: "46683286", cardTable: "9729692919" })

    assert.deepStrictEqual(cardColumnsArgs(board), [
      "cards",
      "columns",
      "--project",
      "46683286",
      "--json",
      "--quiet"
    ])
    assert.deepStrictEqual(cardColumnsArgs(scoped).slice(2, 6), [
      "--project",
      "46683286",
      "--card-table",
      "9729692919"
    ])
    assert.deepStrictEqual(cardListArgs(board, ready), [
      "cards",
      "list",
      "--column",
      "9729692922",
      "--all",
      "--project",
      "46683286",
      "--json",
      "--quiet"
    ])
    assert.deepStrictEqual(cardShowArgs(board, 9953237984).slice(0, 3), [
      "cards",
      "show",
      "9953237984"
    ])
    assert.deepStrictEqual(cardMoveArgs(board, 9953237984, ready), [
      "cards",
      "move",
      "9953237984",
      "--to",
      "9729692922",
      "--project",
      "46683286",
      "--quiet"
    ])
    assert.deepStrictEqual(cardCreateArgs(board, ready, "T", "B"), [
      "cards",
      "create",
      "T",
      "B",
      "--column",
      "9729692922",
      "--project",
      "46683286",
      "--json",
      "--quiet"
    ])
    assert.deepStrictEqual(cardCreateArgs(board, ready, "T", "B", "bot").slice(6, 8), [
      "--assignee",
      "bot"
    ])
    assert.deepStrictEqual(cardAssignArgs(board, 9953237984, "bot").slice(0, 5), [
      "cards",
      "update",
      "9953237984",
      "--assignee",
      "bot"
    ])
    // Comments hang off the card alone; `basecamp comments` rejects --project.
    assert.deepStrictEqual(cardCommentsArgs(9953237984), [
      "comments",
      "list",
      "9953237984",
      "--all",
      "--json",
      "--quiet"
    ])
    assert.deepStrictEqual(cardCommentCreateArgs(9953237984, "Done ✅"), [
      "comments",
      "create",
      "9953237984",
      "Done ✅",
      "--quiet"
    ])
    assert.deepStrictEqual(cardStepsArgs(board, 9953237984).slice(0, 3), [
      "cards",
      "steps",
      "9953237984"
    ])
    assert.deepStrictEqual(cardStepCompleteArgs(board, 11), [
      "cards",
      "step",
      "complete",
      "11",
      "--project",
      "46683286",
      "--quiet"
    ])
  })

  it.effect("decodes columns, cards, comments, and steps from CLI JSON", () =>
    Effect.gen(function* () {
      const columns = yield* parseColumns(columnsJson)
      const card = yield* parseCard(cardJson)
      const cards = yield* parseCards(`[${cardJson}]`)
      const comments = yield* parseCardComments(commentsJson)
      const steps = yield* parseCardSteps(stepsJson)
      const noSteps = yield* parseCardSteps("null")
      const invalid = yield* Effect.flip(parseCards('[{"id":"x"}]'))

      assert.deepStrictEqual(columns, [
        Column.make({ id: 9729692920, title: "Triage" }),
        Column.make({ id: 9729692924, title: "Done" })
      ])
      assert.strictEqual(card.id, 9953237984)
      assert.strictEqual(card.contentHtml, "<div>A minimal endpoint</div>")
      assert.deepStrictEqual(card.column, ready)
      assert.deepStrictEqual(card.assignees, ["Riccardo Merolla"])
      assert.strictEqual(card.commentsCount, 1)
      assert.strictEqual(cards.length, 1)
      assert.strictEqual(comments[0]?.author, "Riccardo Merolla")
      assert.include(comments[0]?.contentHtml, "Figuring it out")
      assert.deepStrictEqual(
        steps.map((step) => step.completed),
        [false, true]
      )
      assert.deepStrictEqual(noSteps, [])
      assert.strictEqual(invalid._tag, "Process")
    })
  )

  it.effect("decodes cards without assignees or body", () =>
    Effect.gen(function* () {
      const card = yield* parseCard(
        '{"id":7,"title":"Bare","content":null,"parent":{"id":1,"title":"Triage"},' +
          '"assignees":null,"comments_count":0,"updated_at":"2026-08-01T10:00:00.000Z",' +
          '"app_url":"https://example.test/cards/7"}'
      )

      assert.strictEqual(card.contentHtml, "")
      assert.deepStrictEqual(card.assignees, [])
    })
  )

  it.effect("resolves columns case-insensitively from one cached board fetch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["basecamp", ...cardColumnsArgs(board)]),
            ProcessResult.make({ stdout: [columnsJson], exitCode: 0 })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const basecamp = yield* makeBasecampTool(fake.executor, "/repo", events, board)

      const done = yield* basecamp.resolveColumn("done")
      const triage = yield* basecamp.resolveColumn("Triage")
      const missing = yield* Effect.flip(basecamp.resolveColumn("Shipped"))

      assert.strictEqual(done.id, 9729692924)
      assert.strictEqual(triage.title, "Triage")
      assert.strictEqual(missing._tag, "ColumnNotFound")
      assert.match(missing.message, /Shipped/)
      assert.match(missing.message, /Triage/)
      assert.strictEqual((yield* fake.recorded).length, 1)
    })
  )

  it.effect("moves cards via the CLI and denies writes without the basecamp grant", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["basecamp", ...cardMoveArgs(board, 9953237984, ready)]),
            ProcessResult.make({ stdout: [], exitCode: 0 })
          ],
          [
            processCommandKey(["basecamp", ...cardCreateArgs(board, ready, "T", "B")]),
            ProcessResult.make({ stdout: [cardJson], exitCode: 0 })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const basecamp = yield* makeBasecampTool(fake.executor, "/repo", events, board)

      yield* basecamp.moveCard(9953237984, ready)
      const created = yield* basecamp.createCard(ready, "T", "B")
      const readOnly = new Grants({ ...allGrants, basecamp: "Read" })
      const denied = yield* Effect.flip(restricted(readOnly)(basecamp.moveCard(9953237984, ready)))

      assert.strictEqual(created.title, "Schema derivation")
      assert.strictEqual(denied._tag, "CapabilityDenied")
      assert.strictEqual((yield* fake.recorded).length, 2)
    })
  )

  it.effect("maps process failures to typed errors", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["basecamp", ...cardShowArgs(board, 404)]),
            ProcessResult.make({ stdout: [], stderr: ["not found"], exitCode: 1 })
          ]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const basecamp = yield* makeBasecampTool(fake.executor, "/repo", events, board)

      const failed = yield* Effect.flip(basecamp.readCard(404))

      assert.isTrue(failed._tag === "Process" && failed.detail.includes("not found"))
    })
  )
})
