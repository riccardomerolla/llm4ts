import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FactKey } from "./Fact.ts"
import type { Rule } from "./Rule.ts"

/**
 * A ruleset (ADR 0020) is validated when it is built, not when it runs:
 * every read is imported or produced, every export is produced, one
 * producer per key, no constant or self-matching rule. Rules that cannot
 * reach an export are pruned with a warning, so a company's ruleset never
 * pays for a judgment nothing depends on. A valid ruleset is a value that
 * runs many times.
 */

export const Problem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("UnproducedMatch"),
    rule: Schema.String,
    key: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("UnproducedExport"), key: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("ManyProducers"),
    key: Schema.String,
    rules: Schema.Array(Schema.String)
  }),
  Schema.Struct({ kind: Schema.Literal("EmptyCondition"), rule: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("SelfMatch"), rule: Schema.String, key: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("DuplicateRuleName"), rule: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("UnusedImport"), key: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("Unreachable"), rule: Schema.String })
])
export type Problem = typeof Problem.Type

const warningKinds: ReadonlySet<Problem["kind"]> = new Set(["UnusedImport", "Unreachable"])

export const isWarning = (problem: Problem): boolean => warningKinds.has(problem.kind)

export const renderProblem = (problem: Problem): string => {
  switch (problem.kind) {
    case "UnproducedMatch":
      return `rule ${problem.rule} reads "${problem.key}", which nothing imports or produces`
    case "UnproducedExport":
      return `export "${problem.key}" is produced by no rule`
    case "ManyProducers":
      return `"${problem.key}" has several producers: ${problem.rules.join(", ")}`
    case "EmptyCondition":
      return `rule ${problem.rule} reads nothing`
    case "SelfMatch":
      return `rule ${problem.rule} reads "${problem.key}", which it produces`
    case "DuplicateRuleName":
      return `two rules are named ${problem.rule}`
    case "UnusedImport":
      return `import "${problem.key}" is read by no rule`
    case "Unreachable":
      return `rule ${problem.rule} reaches no export and is not run`
  }
}

export class RulesetInvalid extends Schema.TaggedError<RulesetInvalid>()("RulesetInvalid", {
  name: Schema.String,
  problems: Schema.Array(Problem)
}) {
  get message(): string {
    return `ruleset "${this.name}" is invalid: ${this.problems.map(renderProblem).join("; ")}`
  }
}

export interface RulesetOptions<E, R> {
  readonly name: string
  readonly imports: ReadonlyArray<FactKey<unknown>>
  readonly exports: ReadonlyArray<FactKey<unknown>>
  readonly rules: ReadonlyArray<Rule<E, R>>
}

export interface Ruleset<E = never, R = never> {
  readonly name: string
  readonly imports: ReadonlyArray<string>
  readonly exports: ReadonlyArray<string>
  /** The rules that can reach an export, in the order given. */
  readonly rules: ReadonlyArray<Rule<E, R>>
  readonly warnings: ReadonlyArray<Problem>
  /** One line per rule: `name: reads -> produces`. */
  describe(): string
  /** A Mermaid `flowchart LR` of keys and rules. */
  mermaid(): string
}

const producersByKey = <E, R>(
  imports: ReadonlyArray<string>,
  rules: ReadonlyArray<Rule<E, R>>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const producers = new Map<string, ReadonlyArray<string>>()
  for (const key of imports) producers.set(key, ["(import)"])
  for (const rule of rules) {
    for (const key of rule.produces) {
      producers.set(key, [...(producers.get(key) ?? []), rule.name])
    }
  }
  return producers
}

/** Rules whose products can reach an export, following reads backwards from the exports. */
const reachable = <E, R>(
  exports: ReadonlyArray<string>,
  rules: ReadonlyArray<Rule<E, R>>
): ReadonlySet<string> => {
  const needed = new Set(exports)
  const kept = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const rule of rules) {
      if (kept.has(rule.name) || !rule.produces.some((key) => needed.has(key))) continue
      kept.add(rule.name)
      for (const key of rule.reads) needed.add(key)
      grew = true
    }
  }
  return kept
}

const escapeLabel = (label: string): string => label.replaceAll('"', "'")

const renderMermaid = <E, R>(name: string, rules: ReadonlyArray<Rule<E, R>>): string => {
  const keys = [...new Set(rules.flatMap((rule) => [...rule.reads, ...rule.produces]))]
  const keyId = new Map(keys.map((key, index) => [key, `k${index}`]))
  const ruleId = new Map(rules.map((rule, index) => [rule.name, `r${index}`]))
  const nodes = [
    ...keys.map((key) => `  ${keyId.get(key)}(["${escapeLabel(key)}"])`),
    ...rules.map((rule) => `  ${ruleId.get(rule.name)}["${escapeLabel(rule.name)}"]`)
  ]
  const edges = rules.flatMap((rule) => [
    ...rule.reads.map((key) => `  ${keyId.get(key)} --> ${ruleId.get(rule.name)}`),
    ...rule.produces.map((key) => `  ${ruleId.get(rule.name)} --> ${keyId.get(key)}`)
  ])
  return ["flowchart LR", `  %% ${escapeLabel(name)}`, ...nodes, ...edges].join("\n")
}

export const makeRuleset = <E, R>(
  options: RulesetOptions<E, R>
): Effect.Effect<Ruleset<E, R>, RulesetInvalid> => {
  const imports = options.imports.map((key) => key.name)
  const exports = options.exports.map((key) => key.name)
  const problems: Array<Problem> = []
  const seen = new Set<string>()
  for (const rule of options.rules) {
    if (seen.has(rule.name)) problems.push({ kind: "DuplicateRuleName", rule: rule.name })
    seen.add(rule.name)
    if (rule.reads.length === 0) problems.push({ kind: "EmptyCondition", rule: rule.name })
    for (const key of rule.reads) {
      if (rule.produces.includes(key)) problems.push({ kind: "SelfMatch", rule: rule.name, key })
    }
  }
  const producers = producersByKey(imports, options.rules)
  for (const [key, names] of producers) {
    if (names.length > 1) problems.push({ kind: "ManyProducers", key, rules: names })
  }
  for (const rule of options.rules) {
    for (const key of rule.reads) {
      if (!producers.has(key)) problems.push({ kind: "UnproducedMatch", rule: rule.name, key })
    }
  }
  for (const key of exports) {
    if (!producers.has(key)) problems.push({ kind: "UnproducedExport", key })
  }
  if (problems.length > 0) {
    return Effect.fail(RulesetInvalid.make({ name: options.name, problems }))
  }
  const warnings: Array<Problem> = []
  const kept = reachable(exports, options.rules)
  for (const rule of options.rules) {
    if (!kept.has(rule.name)) warnings.push({ kind: "Unreachable", rule: rule.name })
  }
  const rules = options.rules.filter((rule) => kept.has(rule.name))
  // An import only pruned rules read is unused too: nothing that runs needs it.
  const read = new Set(rules.flatMap((rule) => rule.reads))
  for (const key of imports) {
    if (!read.has(key)) warnings.push({ kind: "UnusedImport", key })
  }
  return Effect.succeed({
    name: options.name,
    imports,
    exports,
    rules,
    warnings,
    describe: () =>
      [
        `ruleset ${options.name}`,
        `imports: ${imports.join(", ")}`,
        `exports: ${exports.join(", ")}`,
        ...rules.map(
          (rule) => `${rule.name}: ${rule.reads.join(", ")} -> ${rule.produces.join(", ")}`
        ),
        ...warnings.map((warning) => `warning: ${renderProblem(warning)}`)
      ].join("\n"),
    mermaid: () => renderMermaid(options.name, rules)
  })
}
