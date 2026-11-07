import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { validateJson } from "./JsonSchemaCheck.ts"
import { ToolError, defineTool, parseJsonDocument, readToolFile, report } from "./Tool.ts"

const name = "json-validate"

const Input = Schema.Struct({
  document: Schema.String,
  schema: Schema.optionalKey(Schema.String),
  openapi: Schema.optionalKey(Schema.String),
  component: Schema.optionalKey(Schema.String)
})

const componentOf = (
  openapi: unknown,
  component: string,
  path: string
): Effect.Effect<unknown, ToolError> => {
  const schemas =
    typeof openapi === "object" &&
    openapi !== null &&
    "components" in openapi &&
    typeof openapi.components === "object" &&
    openapi.components !== null &&
    "schemas" in openapi.components &&
    typeof openapi.components.schemas === "object" &&
    openapi.components.schemas !== null
      ? openapi.components.schemas
      : undefined
  if (schemas === undefined) {
    return Effect.fail(new ToolError({ tool: name, message: `${path} has no components.schemas` }))
  }
  const found = Object.entries(schemas).find(([key]) => key === component)
  if (found === undefined) {
    const known = Object.keys(schemas).sort().slice(0, 20).join(", ")
    return Effect.fail(
      new ToolError({
        tool: name,
        message: `${path} has no component schema '${component}'; known: ${known}`
      })
    )
  }
  return Effect.succeed(found[1])
}

/**
 * Validates a JSON document against a JSON Schema file, or against one
 * component schema of an OpenAPI document (`$ref`s resolve inside it).
 */
export const jsonValidate = defineTool({
  name,
  purpose:
    "Validate a JSON document against a JSON Schema file, or against a component schema of an OpenAPI document",
  args: {
    document: { description: "Path of the JSON document to check", kind: "path", required: true },
    schema: { description: "Path of a JSON Schema file", kind: "path" },
    openapi: {
      description: "Path of an OpenAPI document (JSON); use with --component",
      kind: "path"
    },
    component: {
      description: "Name under components.schemas of the OpenAPI document",
      kind: "string"
    }
  },
  input: Input,
  run: (input) =>
    Effect.gen(function* () {
      const document = yield* parseJsonDocument(
        name,
        input.document,
        yield* readToolFile(name, input.document)
      )
      let schema: unknown
      let root: unknown
      let against: string
      if (input.schema !== undefined) {
        schema = yield* parseJsonDocument(
          name,
          input.schema,
          yield* readToolFile(name, input.schema)
        )
        root = schema
        against = input.schema
      } else if (input.openapi !== undefined) {
        if (input.component === undefined) {
          return yield* new ToolError({ tool: name, message: "--openapi needs --component <name>" })
        }
        root = yield* parseJsonDocument(
          name,
          input.openapi,
          yield* readToolFile(name, input.openapi)
        )
        schema = yield* componentOf(root, input.component, input.openapi)
        against = `${input.openapi}#/components/schemas/${input.component}`
      } else {
        return yield* new ToolError({
          tool: name,
          message: "give --schema <file> or --openapi <file> --component <name>"
        })
      }
      const issues = validateJson(schema, document, { root })
      return report(name, issues, `${input.document} is valid against ${against}`)
    })
})
