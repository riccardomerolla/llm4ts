import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { parseFromText } from "@llm4ts/core/StructuredOutput"
import * as Stream from "effect/Stream"
import { DocumentLoader, makeFileDocumentLoader, readCatalog } from "../flows/lib/soap/Wsdl.ts"

export const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "demo-bank-soap"
)
export const demoWsdl = join(fixtureRoot, "wsdl", "DemoBank.wsdl")
export const demoResponses = join(fixtureRoot, "responses")
export const demoSoapUi = join(fixtureRoot, "soapui", "DemoBank-soapui-project.xml")

export const demoCatalog = readCatalog(demoWsdl).pipe(
  Effect.provideService(DocumentLoader, makeFileDocumentLoader())
)

export const fixedKey = new Uint8Array(32).fill(7)

const unused = InvalidRequestError.make({ message: "unused" })

/** A reasoning seat that answers every structured request with `reply`. */
export const replyingService = (reply: string): LlmServiceShape => ({
  executeStream: () => Stream.empty,
  executeStreamWithHistory: () => Stream.empty,
  executeWithTools: () => Effect.fail(unused),
  executeStructured: (_prompt, schema, jsonSchema) => parseFromText(reply, schema, jsonSchema),
  executeStructuredWithUsage: () => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})
