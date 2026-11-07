import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { defineTool, parseJsonDocument, readToolFile, report } from "./Tool.ts"
import { diffJson } from "./TreeDiff.ts"

const name = "diff"

const Input = Schema.Struct({
  expected: Schema.String,
  actual: Schema.String,
  ordering: Schema.Literals(["ordered", "per-key", "unordered"]),
  ignore: Schema.String
})

/** Structural compare of two JSON documents, with the pack's ordering and ignore rules. */
export const diff = defineTool({
  name,
  purpose:
    "Compare two JSON documents structurally and list every missing, unexpected or changed value",
  args: {
    expected: { description: "Path of the expected JSON document", kind: "path", required: true },
    actual: { description: "Path of the actual JSON document", kind: "path", required: true },
    ordering: {
      description:
        "How arrays are matched: ordered (by position), per-key (by id/key/name/code), unordered (as a multiset)",
      kind: "string",
      default: "ordered"
    },
    ignore: {
      description:
        "Comma-separated dot paths to skip, * matches one segment (meta.requestId, items.*.updatedAt)",
      kind: "string",
      default: ""
    }
  },
  input: Input,
  run: (input) =>
    Effect.gen(function* () {
      const expected = yield* parseJsonDocument(
        name,
        input.expected,
        yield* readToolFile(name, input.expected)
      )
      const actual = yield* parseJsonDocument(
        name,
        input.actual,
        yield* readToolFile(name, input.actual)
      )
      const ignore = input.ignore
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      const issues = diffJson(expected, actual, { ordering: input.ordering, ignore }).map(
        (issue) => ({
          path: issue.path,
          detail: `${issue.kind}: ${issue.detail}`
        })
      )
      return report(name, issues, `${input.actual} matches ${input.expected}`)
    })
})
