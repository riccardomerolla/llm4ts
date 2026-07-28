import * as Schema from "effect/Schema"
import { EquivMismatch, type EquivObservation, EquivVector } from "./Equiv.ts"

export class VectorVerdict extends Schema.Class<VectorVerdict>("VectorVerdict")({
  vector: EquivVector,
  mismatches: Schema.Array(EquivMismatch)
}) {
  get passed(): boolean {
    return this.mismatches.length === 0
  }
}

export interface EquivVerdict {
  readonly vector: EquivVector
  readonly mismatches: ReadonlyArray<EquivMismatch>
}

const observation = (value: EquivObservation): string => {
  const pairs = (fields: Readonly<Record<string, string>>): string =>
    Object.entries(fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${key}=${item}`)
      .join(", ")
  switch (value.type) {
    case "record":
      return `record ${value.kind} ${pairs(value.fields)}`
    case "message":
      return `message ${value.topic} ${value.key} ${pairs(value.fields)}`
    case "db":
      return `db ${value.table} ${value.op} ${pairs(value.key)} → ${pairs(value.set)}`
  }
}

const describe = (mismatch: EquivMismatch): string => {
  switch (mismatch._tag) {
    case "FieldDiff":
      return `- ${mismatch.at}: \`${mismatch.field}\` expected ${mismatch.expected}, actual ${mismatch.actual}`
    case "Missing":
      return `- missing: ${observation(mismatch.expected)}`
    case "Unexpected":
      return `- unexpected: ${observation(mismatch.actual)}`
  }
}

export const renderEquivReport = (
  verdicts: ReadonlyArray<EquivVerdict>,
  allRules: ReadonlyArray<string>
): string => {
  const rows = allRules.map((rule) => {
    const exercising = verdicts.filter(({ vector }) => vector.rules.includes(rule))
    const generated = exercising.filter(({ vector }) => vector.tier === "generated")
    const captured = exercising.filter(({ vector }) => vector.tier === "captured")
    const cell = (values: ReadonlyArray<EquivVerdict>): string =>
      values.length === 0
        ? "—"
        : `${values.filter(({ mismatches }) => mismatches.length === 0).length}/${values.length}`
    const status =
      exercising.length === 0
        ? "UNEXERCISED"
        : exercising.some(({ mismatches }) => mismatches.length > 0)
          ? "FAILING"
          : captured.length > 0
            ? "proven (captured)"
            : "proven (generated)"
    return `| ${rule} | ${cell(generated)} | ${cell(captured)} | ${status} |`
  })
  const failing = verdicts.filter(({ mismatches }) => mismatches.length > 0)
  const failures =
    failing.length === 0
      ? []
      : [
          "",
          "## Failing vectors",
          ...failing.flatMap(({ vector, mismatches }) => [
            "",
            `### ${vector.program} ${vector.id} (${vector.tier})`,
            ...mismatches.map(describe)
          ])
        ]
  return [
    "# Equivalence report",
    "",
    "| Rule | Generated | Captured | Status |",
    "| ---- | --------- | -------- | ------ |",
    ...rows,
    ...failures,
    "",
    "Generated vectors prove spec conformance; captured vectors prove behavioural equivalence.",
    "The two tiers are reported separately and never summed.",
    ""
  ].join("\n")
}
