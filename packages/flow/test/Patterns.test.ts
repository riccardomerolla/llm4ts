import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  PatternCard,
  loadPatternCards,
  matchingPatternCards,
  parsePatternCard,
  taggedPatternIds
} from "@llm4ts/flow/Patterns"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"

const comp3Card = [
  "---",
  "match: PIC S9\\(\\d+\\)V9\\(\\d+\\) +COMP-3",
  "---",
  "",
  "# Packed decimal money",
  "",
  "Translate COMP-3 amounts to BigDecimal with explicit scale."
].join("\n")

describe("parsePatternCard", () => {
  it("reads the match regex from frontmatter and keeps the body", () => {
    const card = parsePatternCard("PAT-COBOL-001-comp3-money", comp3Card)
    assert.strictEqual(card.id, "PAT-COBOL-001-comp3-money")
    assert.strictEqual(card.matches, "PIC S9\\(\\d+\\)V9\\(\\d+\\) +COMP-3")
    assert.include(card.body, "# Packed decimal money")
    assert.notInclude(card.body, "match:")
  })

  it("treats a card without frontmatter as body-only and never matching", () => {
    const card = parsePatternCard("PAT-FREEFORM", "# Just prose\n\nNo frontmatter here.")
    assert.strictEqual(card.matches, "")
    assert.include(card.body, "# Just prose")
  })

  it("treats an unterminated frontmatter block as body-only", () => {
    const card = parsePatternCard("PAT-BROKEN", "---\nmatch: FOO\n\nstill frontmatter?")
    assert.strictEqual(card.matches, "")
  })
})

describe("matchingPatternCards", () => {
  const cards = [
    PatternCard.make({ id: "PAT-A", matches: "COMP-3", body: "packed decimal" }),
    PatternCard.make({ id: "PAT-B", matches: "^ {7}EXEC SQL", body: "embedded sql" }),
    PatternCard.make({ id: "PAT-NONE", matches: "", body: "no regex" }),
    PatternCard.make({ id: "PAT-BAD", matches: "([unclosed", body: "invalid regex" })
  ]

  it("selects only the cards whose regex hits the source", () => {
    const source = [
      "       01 WS-AMOUNT PIC S9(7)V99 COMP-3.",
      "       MOVE ZERO TO WS-AMOUNT."
    ].join("\n")
    assert.deepStrictEqual(
      matchingPatternCards(source, cards).map((card) => card.id),
      ["PAT-A"]
    )
  })

  it("matches multiline anchors against any line", () => {
    const source = ["       IDENTIFICATION DIVISION.", "       EXEC SQL SELECT 1 END-EXEC."].join(
      "\n"
    )
    assert.deepStrictEqual(
      matchingPatternCards(source, cards).map((card) => card.id),
      ["PAT-B"]
    )
  })

  it("never matches a card with no regex, and skips an invalid one", () => {
    assert.deepStrictEqual(matchingPatternCards("([unclosed no regex", cards), [])
  })
})

describe("taggedPatternIds", () => {
  it("collects cited ids in first-appearance order, deduplicated", () => {
    const spec = [
      "Patterns: PAT-COBOL-001-comp3-money, PAT-COBOL-007-validation-order",
      "See PAT-COBOL-001-comp3-money again for rounding."
    ].join("\n")
    assert.deepStrictEqual(
      [...taggedPatternIds(spec)],
      ["PAT-COBOL-001-comp3-money", "PAT-COBOL-007-validation-order"]
    )
  })

  it("returns nothing for a spec citing no pattern", () => {
    assert.deepStrictEqual([...taggedPatternIds("# ACCTXFR\n\nNo patterns cited.")], [])
  })
})

describe("loadPatternCards", () => {
  it.effect("loads every card under the directory, sorted by id", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({
        initial: {
          "patterns/PAT-B.md": "---\nmatch: BBB\n---\nbeta",
          "patterns/PAT-A.md": comp3Card,
          "patterns/notes.txt": "not a card"
        }
      })
      const cards = yield* loadPatternCards(workspace, "patterns")
      assert.deepStrictEqual(
        cards.map((card) => card.id),
        ["PAT-A", "PAT-B"]
      )
    })
  )

  it.effect("treats an absent directory as an empty card set", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace({ initial: {} })
      assert.deepStrictEqual(yield* loadPatternCards(workspace, "patterns"), [])
    })
  )
})
