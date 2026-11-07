// Validate an XML document against an XSD: `llm4ts tool xml-validate --schema
// <xsd> --document <xml>` (ADR 0048). Imports and includes of the schema are
// followed from its own directory; the document's root element must be a
// global element the schema declares (or `--root <local-name>` names one).
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { defineTool, readToolFile, report, ToolError } from "@llm4ts/flow/tools/Tool"
import { runToolMain } from "@llm4ts/runner/ToolMain"
import { splitClark } from "../flows/lib/soap/Catalog.ts"
import { instanceFromXml, validateInstance } from "../flows/lib/soap/Instance.ts"
import { parseXml } from "../flows/lib/soap/Xml.ts"
import {
  DocumentLoader,
  makeFileDocumentLoader,
  readSchemaCatalog
} from "../flows/lib/soap/Wsdl.ts"

const name = "xml-validate"

const Input = Schema.Struct({
  schema: Schema.String,
  document: Schema.String,
  root: Schema.optionalKey(Schema.String)
})

export const xmlValidate = defineTool({
  name,
  purpose: "Validate an XML document against an XSD schema (imports and includes followed)",
  args: {
    schema: { description: "Path of the XSD file", kind: "path", required: true },
    document: { description: "Path of the XML document to check", kind: "path", required: true },
    root: {
      description:
        "Local name of the global element to validate against; default: the document's root",
      kind: "string"
    }
  },
  input: Input,
  run: (input) =>
    Effect.gen(function* () {
      const catalog = yield* readSchemaCatalog(input.schema).pipe(
        Effect.provideService(DocumentLoader, makeFileDocumentLoader()),
        Effect.mapError(
          (error) =>
            new ToolError({
              tool: name,
              message: `cannot read schema ${input.schema}: ${error.message}`
            })
        )
      )
      const text = yield* readToolFile(name, input.document)
      const xml = yield* parseXml(text, { source: input.document }).pipe(
        Effect.mapError(
          (error) => new ToolError({ tool: name, message: `${input.document}: ${error.message}` })
        )
      )
      const wanted = input.root ?? xml.name.local
      const element = catalog.elements.find(
        (candidate) => splitClark(candidate.name).local === wanted
      )
      if (element === undefined) {
        const known = catalog.elements
          .map((candidate) => splitClark(candidate.name).local)
          .sort()
          .slice(0, 20)
          .join(", ")
        return yield* new ToolError({
          tool: name,
          message: `${input.schema} declares no global element '${wanted}'; known: ${known}`
        })
      }
      const read = instanceFromXml(catalog, element, xml)
      const issues = [...read.issues, ...validateInstance(catalog, element, read.value)]
      const unresolved = catalog.openQuestions.map((question) => ({
        path: "(schema)",
        detail: `${question.code}: ${question.detail}`
      }))
      return report(
        name,
        [...unresolved, ...issues],
        `${input.document} is valid against ${input.schema}`
      )
    })
})

runToolMain(xmlValidate)
