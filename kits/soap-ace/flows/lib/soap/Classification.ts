import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import { choice } from "@llm4ts/core/judgment/Schemas"
import { certaintyOf, decide } from "@llm4ts/flow/Judgment"
import {
  ComplexTypeDef,
  elementByName,
  type Operation,
  typeByName,
  type WsdlCatalog
} from "./Catalog.ts"

// Operation classification (read / mutating) decides two things: whether
// the tool may call an operation at all in a given environment, and which
// REST verb the design gives it. The tool only proposes: a name heuristic
// always, a `Judgment` answer when a judgment seat is configured. The human
// confirms by editing `operations.md` and flipping its status to
// `confirmed`; until then every operation counts as unclassified and cannot
// be called. An existing file is never overwritten.

export const OperationClass = Schema.Literals(["read", "mutating", "unclassified"])
export type OperationClass = typeof OperationClass.Type

export class OperationsFileError extends Schema.TaggedError<OperationsFileError>()(
  "OperationsFileError",
  {
    line: Schema.Int,
    detail: Schema.String
  }
) {
  get message(): string {
    return `operations.md:${this.line}: ${this.detail}`
  }
}

// Italian and English verbs seen in bank SOAP estates. Matched against the
// operation name's leading word (camelCase, snake_case, or PascalCase).
const readVerbs = [
  "cerca",
  "ricerca",
  "leggi",
  "lettura",
  "lista",
  "elenca",
  "elenco",
  "dettaglio",
  "visualizza",
  "consulta",
  "verifica",
  "controlla",
  "calcola",
  "simula",
  "stato",
  "get",
  "list",
  "find",
  "search",
  "read",
  "inquiry",
  "inquire",
  "query",
  "retrieve",
  "check",
  "validate",
  "fetch",
  "lookup",
  "view",
  "count"
]

const mutatingVerbs = [
  "inserisci",
  "inserimento",
  "crea",
  "creazione",
  "aggiorna",
  "aggiornamento",
  "modifica",
  "cancella",
  "elimina",
  "revoca",
  "annulla",
  "conferma",
  "esegui",
  "blocca",
  "sblocca",
  "autorizza",
  "invia",
  "registra",
  "apri",
  "chiudi",
  "attiva",
  "disattiva",
  "storna",
  "create",
  "insert",
  "add",
  "update",
  "modify",
  "set",
  "delete",
  "remove",
  "cancel",
  "confirm",
  "execute",
  "submit",
  "approve",
  "authorize",
  "block",
  "unblock",
  "open",
  "close",
  "activate",
  "deactivate",
  "send",
  "register",
  "post",
  "put",
  "transfer",
  "pay"
]

/** The operation name's first word, lower-cased. */
export const leadingWord = (name: string): string => {
  const match = /^[a-z]+|^[A-Z][a-z]+|^[A-Z]+(?![a-z])/.exec(name.replace(/^[_\W]+/, ""))
  return (match?.[0] ?? name).toLowerCase()
}

export interface HeuristicClass {
  readonly class: OperationClass
  readonly reason: string
}

export const heuristicClass = (name: string): HeuristicClass => {
  const word = leadingWord(name)
  if (readVerbs.includes(word)) return { class: "read", reason: `name starts with "${word}"` }
  if (mutatingVerbs.includes(word)) {
    return { class: "mutating", reason: `name starts with "${word}"` }
  }
  return { class: "unclassified", reason: `no known verb in "${word}"` }
}

export interface JudgedClass {
  readonly class: "read" | "mutating"
  readonly confidence: number
  readonly decision: "act" | "caution" | "hold"
}

export interface ClassProposal {
  readonly operation: string
  readonly proposed: OperationClass
  readonly heuristic: HeuristicClass
  readonly judged: JudgedClass | undefined
}

const fieldNames = (catalog: WsdlCatalog, element: string | undefined): ReadonlyArray<string> => {
  if (element === undefined) return []
  const type = typeByName(catalog, elementByName(catalog, element)?.type ?? "")
  return type instanceof ComplexTypeDef ? type.fields.map((field) => field.name) : []
}

const classQuestion = choice(
  "Classify this SOAP operation of a bank's backend service. Would calling it change state in the backend (create, update, delete, confirm, execute, block, send), or does it only read?",
  {
    read: "Only reads or computes: inquiries, lists, details, checks, simulations. Calling it twice has no additional effect.",
    mutating:
      "Changes state: creates, updates, deletes, confirms, executes, blocks, revokes, or sends something."
  }
)

/** Ask the judgment for one operation; `undefined` when it fails or does not answer. */
export const judgeClass = (
  judgment: JudgmentShape,
  catalog: WsdlCatalog,
  operation: Operation
): Effect.Effect<JudgedClass | undefined> =>
  judgment
    .judge({
      state: {
        operation: operation.name,
        soapAction: operation.soapAction,
        documentation: operation.documentation ?? "",
        requestFields: fieldNames(catalog, operation.input),
        responseFields: fieldNames(catalog, operation.output),
        faults: operation.faults.map((fault) => fault.name)
      },
      questions: { class: classQuestion }
    })
    .pipe(
      Effect.map((result): JudgedClass | undefined => {
        const answer = result.answers["class"]
        if (answer?.type !== "choice") return undefined
        if (answer.choice !== "read" && answer.choice !== "mutating") return undefined
        return { class: answer.choice, confidence: certaintyOf(answer), decision: decide(answer) }
      }),
      Effect.orElseSucceed(() => undefined)
    )

/**
 * Combine the two signals. A judgment the policy would act on wins; one it
 * would hold is ignored; in between, it wins only when the heuristic had no
 * opinion. Disagreement stays visible in the file for the human to settle.
 */
export const proposeClass = (
  operation: string,
  heuristic: HeuristicClass,
  judged: JudgedClass | undefined
): ClassProposal => {
  const proposed =
    judged === undefined || judged.decision === "hold"
      ? heuristic.class
      : judged.decision === "act" || heuristic.class === "unclassified"
        ? judged.class
        : heuristic.class
  return { operation, proposed, heuristic, judged }
}

export const classifyOperations = (
  catalog: WsdlCatalog,
  judgment: JudgmentShape | undefined
): Effect.Effect<ReadonlyArray<ClassProposal>> =>
  Effect.forEach(catalog.operations, (operation) =>
    Effect.map(
      judgment === undefined
        ? Effect.succeed<JudgedClass | undefined>(undefined)
        : judgeClass(judgment, catalog, operation),
      (judged) => proposeClass(operation.name, heuristicClass(operation.name), judged)
    )
  )

// ---------------------------------------------------------------------------
// operations.md

export interface OperationsFile {
  readonly confirmed: boolean
  readonly classes: ReadonlyMap<string, OperationClass>
}

const describeProposal = (proposal: ClassProposal): string => {
  const judged =
    proposal.judged === undefined
      ? ""
      : `; judgment: ${proposal.judged.class} ${proposal.judged.confidence.toFixed(2)} (${proposal.judged.decision})`
  return `heuristic: ${proposal.heuristic.class}, ${proposal.heuristic.reason}${judged}`
}

export const renderOperationsFile = (
  service: string,
  catalog: WsdlCatalog,
  proposals: ReadonlyArray<ClassProposal>
): string => {
  const lines = [
    `# Operations: ${service}`,
    "",
    "Status: proposed",
    "",
    "Review every `class:` below (read | mutating | unclassified), then change the",
    "status above to `confirmed`. Until then every operation is unclassified:",
    "nothing can be called, and the design cannot choose REST verbs. An",
    "unclassified operation stays uncallable after confirmation. This file is",
    "never overwritten; delete it to get fresh proposals.",
    ""
  ]
  for (const proposal of proposals) {
    const operation = catalog.operations.find((candidate) => candidate.name === proposal.operation)
    lines.push(`## ${proposal.operation}`, "")
    if (operation?.documentation !== undefined) lines.push(operation.documentation, "")
    lines.push(`- class: ${proposal.proposed}`, `- evidence: ${describeProposal(proposal)}`, "")
  }
  return lines.join("\n")
}

export const parseOperationsFile = (
  text: string
): Effect.Effect<OperationsFile, OperationsFileError> =>
  Effect.suspend(() => {
    const lines = text.split(/\r?\n/)
    let confirmed: boolean | undefined
    let current: string | undefined
    const classes = new Map<string, OperationClass>()
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim()
      const status = /^status:\s*(\S+)\s*$/i.exec(line)
      if (status !== null && current === undefined) {
        const value = status[1]?.toLowerCase()
        if (value !== "proposed" && value !== "confirmed") {
          return Effect.fail(
            new OperationsFileError({
              line: index + 1,
              detail: `status must be proposed or confirmed, found ${status[1] ?? ""}`
            })
          )
        }
        confirmed = value === "confirmed"
        continue
      }
      const heading = /^##\s+(\S+)\s*$/.exec(line)
      if (heading !== null) {
        current = heading[1]
        continue
      }
      const declared = /^-\s*class:\s*(\S+)\s*$/i.exec(line)
      if (declared !== null) {
        if (current === undefined) {
          return Effect.fail(
            new OperationsFileError({ line: index + 1, detail: "class: outside an operation" })
          )
        }
        const value = declared[1]?.toLowerCase()
        if (value !== "read" && value !== "mutating" && value !== "unclassified") {
          return Effect.fail(
            new OperationsFileError({
              line: index + 1,
              detail: `class of ${current} must be read, mutating, or unclassified`
            })
          )
        }
        if (classes.has(current)) {
          return Effect.fail(
            new OperationsFileError({ line: index + 1, detail: `${current} is classified twice` })
          )
        }
        classes.set(current, value)
      }
    }
    if (confirmed === undefined) {
      return Effect.fail(new OperationsFileError({ line: 1, detail: "missing Status: line" }))
    }
    return Effect.succeed({ confirmed, classes })
  })

/** The class the tool acts on: only a confirmed file counts. */
export const effectiveClass = (
  file: OperationsFile | undefined,
  operation: string
): OperationClass =>
  file === undefined || !file.confirmed
    ? "unclassified"
    : (file.classes.get(operation) ?? "unclassified")

/** Catalog operations the file does not mention, and file entries the catalog lacks. */
export const operationsDrift = (
  file: OperationsFile,
  catalog: WsdlCatalog
): { readonly missing: ReadonlyArray<string>; readonly unknown: ReadonlyArray<string> } => {
  const names = new Set(catalog.operations.map((operation) => operation.name))
  return {
    missing: [...names].filter((name) => !file.classes.has(name)),
    unknown: [...file.classes.keys()].filter((name) => !names.has(name))
  }
}
