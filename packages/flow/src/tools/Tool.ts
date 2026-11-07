import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { SoapTransport } from "../endpoint/Transport.ts"
import { PlainFileStore } from "../Persistence.ts"

/**
 * A tool is one repeatable action a coding agent would otherwise improvise
 * — validate a document, compare two outputs, probe an endpoint — packaged
 * as a module with a typed input, a typed report and an Effect `run`
 * (ADR 0048). The `llm4ts tool` CLI lists, describes and runs them; a pack
 * names presets over them so a story sees the same command every run.
 */

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  tool: Schema.String,
  message: Schema.String
}) {}

export class ToolIssue extends Schema.Class<ToolIssue>("ToolIssue")({
  path: Schema.String,
  detail: Schema.String
}) {}

/** What every tool prints: a verdict, one line, and the issues behind it. */
export class ToolReport extends Schema.Class<ToolReport>("ToolReport")({
  tool: Schema.String,
  ok: Schema.Boolean,
  summary: Schema.String,
  issues: Schema.Array(ToolIssue),
  /** Issues cut from `issues` by the output cap; `--all` lifts it. */
  truncated: Schema.Int,
  data: Schema.optionalKey(Schema.Json)
}) {}

export const ToolArgKind = Schema.Literals(["string", "path", "integer", "boolean", "json"])
export type ToolArgKind = typeof ToolArgKind.Type

export interface ToolArg {
  readonly description: string
  readonly kind: ToolArgKind
  readonly required?: boolean
  readonly default?: string
}

export interface ToolContextShape {
  /** The project the tool runs for: the main checkout of a worktree (`.llm4ts/` lives here). */
  readonly projectRoot: string
  /** The process environment, for `env:NAME` secret references; never printed. */
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** Where a tool runs: provided by the CLI, or by `runToolMain` from its arguments. */
export class ToolContext extends Context.Service<ToolContext, ToolContextShape>()(
  "@llm4ts/flow/tools/ToolContext"
) {}

/**
 * The services a tool may use: file reads, its context, and the endpoint
 * transport (3.2, ADR 0048) — nothing else.
 */
export type ToolServices = PlainFileStore | ToolContext | SoapTransport

/** A tool with its input type erased: what a catalog holds and the CLI runs. */
export interface ToolShape {
  readonly name: string
  readonly purpose: string
  readonly args: Readonly<Record<string, ToolArg>>
  /** Decodes parsed arguments with the tool's schema, then runs it. */
  readonly execute: (
    values: Record<string, unknown>
  ) => Effect.Effect<ToolReport, ToolError | ToolArgsError, ToolServices>
}

export interface Tool<I> extends ToolShape {
  readonly input: Schema.Codec<I, unknown>
  readonly run: (input: I) => Effect.Effect<ToolReport, ToolError, ToolServices>
}

export interface ToolDefinition<I> {
  readonly name: string
  readonly purpose: string
  readonly args: Readonly<Record<string, ToolArg>>
  readonly input: Schema.Codec<I, unknown>
  readonly run: (input: I) => Effect.Effect<ToolReport, ToolError, ToolServices>
}

export const defineTool = <I>(definition: ToolDefinition<I>): Tool<I> => ({
  ...definition,
  execute: (values) =>
    withArgDefaults(definition, values).pipe(
      Effect.flatMap((complete) => decodeToolInput(definition, complete)),
      Effect.flatMap(definition.run)
    )
})

/** The argument table's defaults, coerced by kind, under every key the caller left out. */
const withArgDefaults = (
  tool: Pick<ToolShape, "name" | "args">,
  values: Record<string, unknown>
): Effect.Effect<Record<string, unknown>, ToolArgsError> =>
  Effect.gen(function* () {
    const complete: Record<string, unknown> = { ...values }
    for (const [name, arg] of Object.entries(tool.args)) {
      if (arg.default !== undefined && !(name in complete)) {
        complete[name] = yield* coerce(tool.name, name, arg.kind, arg.default)
      }
    }
    return complete
  })

/** The spec the CLI prints for `describe` and the brief quotes per preset. */
export class ToolSpec extends Schema.Class<ToolSpec>("ToolSpec")({
  name: Schema.String,
  purpose: Schema.String,
  args: Schema.Record(
    Schema.String,
    Schema.Struct({
      description: Schema.String,
      kind: ToolArgKind,
      required: Schema.optionalKey(Schema.Boolean),
      default: Schema.optionalKey(Schema.String)
    })
  )
}) {}

export const specOf = (tool: Pick<ToolShape, "name" | "purpose" | "args">): ToolSpec =>
  ToolSpec.make({
    name: tool.name,
    purpose: tool.purpose,
    args: Object.fromEntries(
      Object.entries(tool.args).map(([name, arg]) => [
        name,
        {
          description: arg.description,
          kind: arg.kind,
          ...(arg.required === undefined ? {} : { required: arg.required }),
          ...(arg.default === undefined ? {} : { default: arg.default })
        }
      ])
    )
  })

const toolNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u

export const isToolName = (name: string): boolean => toolNamePattern.test(name)

/** `describe` text: purpose, then one line per argument. */
export const renderSpec = (spec: ToolSpec): string =>
  [
    `${spec.name}: ${spec.purpose}`,
    ...Object.entries(spec.args).map(
      ([name, arg]) =>
        `  --${name} <${arg.kind}>${arg.required === true ? " (required)" : ""}${
          arg.default === undefined ? "" : ` [default ${arg.default}]`
        }: ${arg.description}`
    )
  ].join("\n")

/** The one-line usage the brief quotes: `name --a <kind> [--b <kind>]`. */
export const renderUsage = (spec: ToolSpec): string =>
  [
    spec.name,
    ...Object.entries(spec.args).map(([name, arg]) =>
      arg.required === true ? `--${name} <${arg.kind}>` : `[--${name} <${arg.kind}>]`
    )
  ].join(" ")

export class ToolArgsError extends Schema.TaggedError<ToolArgsError>()("ToolArgsError", {
  tool: Schema.String,
  message: Schema.String
}) {}

/**
 * `--name value` pairs (a boolean flag stands alone) to the record a tool's
 * input schema decodes: kinds coerce the text, unknown names and a missing
 * required argument are errors that quote the spec.
 */
export const parseToolArgs = (
  spec: ToolSpec,
  argv: ReadonlyArray<string>
): Effect.Effect<Record<string, unknown>, ToolArgsError> =>
  Effect.gen(function* () {
    const fail = (message: string) =>
      new ToolArgsError({ tool: spec.name, message: `${message}\n${renderSpec(spec)}` })
    const values: Record<string, unknown> = {}
    for (const [name, arg] of Object.entries(spec.args)) {
      if (arg.default !== undefined) {
        values[name] = yield* coerce(spec.name, name, arg.kind, arg.default)
      }
    }
    let index = 0
    while (index < argv.length) {
      const token = argv[index] ?? ""
      if (!token.startsWith("--")) {
        return yield* fail(`unexpected argument '${token}'`)
      }
      const equals = token.indexOf("=")
      const name = equals > 0 ? token.slice(2, equals) : token.slice(2)
      const arg = spec.args[name]
      if (arg === undefined) {
        return yield* fail(`unknown argument '--${name}'`)
      }
      let text: string
      if (equals > 0) {
        text = token.slice(equals + 1)
        index += 1
      } else if (
        arg.kind === "boolean" &&
        (index + 1 >= argv.length || argv[index + 1]?.startsWith("--"))
      ) {
        text = "true"
        index += 1
      } else if (index + 1 < argv.length) {
        text = argv[index + 1] ?? ""
        index += 2
      } else {
        return yield* fail(`argument '--${name}' needs a value`)
      }
      values[name] = yield* coerce(spec.name, name, arg.kind, text)
    }
    for (const [name, arg] of Object.entries(spec.args)) {
      if (arg.required === true && !(name in values)) {
        return yield* fail(`missing required argument '--${name}'`)
      }
    }
    return values
  })

const coerce = (
  tool: string,
  name: string,
  kind: ToolArgKind,
  text: string
): Effect.Effect<unknown, ToolArgsError> => {
  switch (kind) {
    case "string":
    case "path":
      return Effect.succeed(text)
    case "integer": {
      const value = Number.parseInt(text, 10)
      return Number.isInteger(value) && String(value) === text.trim()
        ? Effect.succeed(value)
        : Effect.fail(
            new ToolArgsError({
              tool,
              message: `argument '--${name}' expects an integer, got '${text}'`
            })
          )
    }
    case "boolean":
      return text === "true" || text === "false"
        ? Effect.succeed(text === "true")
        : Effect.fail(
            new ToolArgsError({
              tool,
              message: `argument '--${name}' expects true or false, got '${text}'`
            })
          )
    case "json":
      return Effect.try({
        try: (): unknown => JSON.parse(text),
        catch: () => new ToolArgsError({ tool, message: `argument '--${name}' is not valid JSON` })
      })
  }
}

/** Decodes parsed arguments with the tool's own schema; a failure quotes the spec. */
export const decodeToolInput = <I>(
  tool: ToolDefinition<I>,
  values: Record<string, unknown>
): Effect.Effect<I, ToolArgsError> =>
  Schema.decodeUnknownEffect(tool.input)(values).pipe(
    Effect.mapError(
      (error) =>
        new ToolArgsError({
          tool: tool.name,
          message: `${String(error)}\n${renderSpec(specOf(tool))}`
        })
    )
  )

export const defaultIssueCap = 50

/** The report the CLI prints: issues capped unless `all`, the rest counted. */
export const capReport = (report: ToolReport, all: boolean): ToolReport =>
  all || report.issues.length <= defaultIssueCap
    ? report
    : ToolReport.make({
        ...report,
        issues: report.issues.slice(0, defaultIssueCap),
        truncated: report.truncated + report.issues.length - defaultIssueCap
      })

/** A plain-text rendering for terminals; the CLI default is JSON. */
export const renderReport = (report: ToolReport): string =>
  [
    `${report.ok ? "ok" : "FAIL"} ${report.tool}: ${report.summary}`,
    ...report.issues.map((issue) => `  ${issue.path}: ${issue.detail}`),
    ...(report.truncated > 0 ? [`  … ${report.truncated} more (run with --all)`] : [])
  ].join("\n")

/** Reads a document for a tool; a missing file is a `ToolError` naming it. */
export const readToolFile = (
  tool: string,
  path: string
): Effect.Effect<string, ToolError, PlainFileStore> =>
  Effect.gen(function* () {
    const files = yield* PlainFileStore
    const text = yield* files
      .read(path)
      .pipe(
        Effect.mapError(
          (error) => new ToolError({ tool, message: `cannot read ${path}: ${error.message}` })
        )
      )
    if (text === undefined) {
      return yield* new ToolError({ tool, message: `no such file: ${path}` })
    }
    return text
  })

export const parseJsonDocument = (
  tool: string,
  path: string,
  text: string
): Effect.Effect<unknown, ToolError> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (error) =>
      new ToolError({
        tool,
        message: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      })
  })

export const report = (
  tool: string,
  issues: ReadonlyArray<{ readonly path: string; readonly detail: string }>,
  okSummary: string,
  data?: typeof Schema.Json.Type
): ToolReport =>
  ToolReport.make({
    tool,
    ok: issues.length === 0,
    summary:
      issues.length === 0 ? okSummary : `${issues.length} issue${issues.length === 1 ? "" : "s"}`,
    issues: issues.map((issue) => ToolIssue.make({ path: issue.path, detail: issue.detail })),
    truncated: 0,
    ...(data === undefined ? {} : { data })
  })
