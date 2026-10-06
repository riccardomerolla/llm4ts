// Compiler and test-runner output as a work queue (ADR 0028): a pack's
// `## Diagnostics` command prints what is red, this module reads it and
// groups it by unit so each fixer gets one unit and nothing else.
import { dirname } from "node:path"
import * as Schema from "effect/Schema"

export class Diagnostic extends Schema.Class<Diagnostic>("Diagnostic")({
  file: Schema.String,
  line: Schema.optionalKey(Schema.Int),
  message: Schema.String,
  /** The unit the fixer owns (a crate, a package, a folder); default: the file's directory. */
  unit: Schema.optionalKey(Schema.String)
}) {}

export const DiagnosticsFormat = Schema.Literals(["json", "cargo"])
export type DiagnosticsFormat = typeof DiagnosticsFormat.Type

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Diagnostic))

const CargoMessage = Schema.fromJsonString(
  Schema.Struct({
    reason: Schema.optionalKey(Schema.String),
    target: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
    message: Schema.optionalKey(
      Schema.Struct({
        level: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
        spans: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              file_name: Schema.optionalKey(Schema.String),
              line_start: Schema.optionalKey(Schema.Int),
              is_primary: Schema.optionalKey(Schema.Boolean)
            })
          )
        )
      })
    )
  })
)
const decodeCargo = Schema.decodeUnknownOption(CargoMessage)

/**
 * `json`: one `{file, line?, message, unit?}` object per line. `cargo`:
 * `cargo check --message-format=json`, errors only, the crate as the unit.
 * Lines that do not parse are skipped: a build prints more than diagnostics.
 */
export const parseDiagnostics = (
  text: string,
  format: DiagnosticsFormat = "json"
): ReadonlyArray<Diagnostic> => {
  const out: Array<Diagnostic> = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.length === 0 || !line.startsWith("{")) continue
    if (format === "json") {
      const decoded = decodeJsonLine(line)
      if (decoded._tag === "Some") out.push(decoded.value)
      continue
    }
    const decoded = decodeCargo(line)
    if (decoded._tag !== "Some") continue
    const value = decoded.value
    if (value.reason !== "compiler-message" || value.message?.level !== "error") continue
    const span =
      value.message.spans?.find((candidate) => candidate.is_primary === true) ??
      value.message.spans?.[0]
    if (span?.file_name === undefined) continue
    out.push(
      Diagnostic.make({
        file: span.file_name,
        ...(span.line_start === undefined ? {} : { line: span.line_start }),
        message: value.message.message ?? "error",
        ...(value.target?.name === undefined ? {} : { unit: value.target.name })
      })
    )
  }
  return out
}

/** Diagnostics by the unit a fixer owns, in a stable order. */
export const groupDiagnostics = (
  diagnostics: ReadonlyArray<Diagnostic>
): ReadonlyArray<{ readonly unit: string; readonly diagnostics: ReadonlyArray<Diagnostic> }> => {
  const groups = new Map<string, Array<Diagnostic>>()
  for (const diagnostic of diagnostics) {
    const unit = diagnostic.unit ?? dirname(diagnostic.file)
    groups.set(unit, [...(groups.get(unit) ?? []), diagnostic])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, list]) => ({ unit, diagnostics: list }))
}

/** The diagnostics of one unit as the fixer reads them, capped by count. */
export const renderDiagnostics = (diagnostics: ReadonlyArray<Diagnostic>, limit = 60): string =>
  [
    ...diagnostics
      .slice(0, limit)
      .map(
        (diagnostic) =>
          `- ${diagnostic.file}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}: ${diagnostic.message.split("\n")[0] ?? ""}`
      ),
    ...(diagnostics.length > limit ? [`- … ${diagnostics.length - limit} more`] : [])
  ].join("\n")
