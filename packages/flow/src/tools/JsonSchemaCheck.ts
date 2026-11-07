/**
 * A JSON Schema subset validator for the schema objects a tool is likely to
 * meet: draft-07, 2020-12 and OpenAPI 3.0/3.1 schema objects. It reports every
 * issue it finds in one pass, with JSONPath-style locations, and never throws
 * on a malformed schema: a bad `pattern`, a dangling `$ref` or a reference
 * cycle become issues of their own.
 *
 * `format` and every keyword not listed in `validateJson`'s documentation are
 * ignored, so a schema that uses them still validates the parts this module
 * understands.
 */

export interface JsonIssue {
  readonly path: string
  readonly detail: string
}

export interface JsonSchemaCheckOptions {
  /**
   * The document that local `$ref` pointers (`#/components/schemas/X`,
   * `#/definitions/X`, `#/$defs/X`) resolve against. Defaults to the schema
   * itself.
   */
  readonly root?: unknown
}

/** Schema applications nested deeper than this are reported, not followed. */
const maxDepth = 64

const nestingTooDeep = "schema nesting too deep"

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const childPath = (path: string, key: string): string =>
  identifier.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

const indexPath = (path: string, index: number): string => `${path}[${index}]`

const renderLimit = 80

const render = (value: unknown): string => {
  const text = value === undefined ? "undefined" : JSON.stringify(value)
  return text.length > renderLimit ? `${text.slice(0, renderLimit - 1)}…` : text
}

const jsonEquals = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (typeof left === "number" && typeof right === "number") return left === right
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEquals(item, right[index]))
    )
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined)
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined)
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && jsonEquals(left[key], right[key]))
    )
  }
  return false
}

const hasValue = (record: JsonRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined

const matchesType = (name: string, value: unknown): boolean => {
  switch (name) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "number":
      return typeof value === "number"
    case "string":
      return typeof value === "string"
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    case "array":
      return Array.isArray(value)
    case "object":
      return isRecord(value)
    default:
      return true
  }
}

const typeNames = (type: unknown): ReadonlyArray<string> => {
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) return type.filter((name): name is string => typeof name === "string")
  return []
}

/** Resolves a local JSON pointer (`#/a/b~1c`) against a root document. */
const resolvePointer = (
  root: unknown,
  ref: string
): { readonly found: boolean; readonly value: unknown } => {
  if (!ref.startsWith("#")) return { found: false, value: undefined }
  const fragment = ref.slice(1)
  if (fragment === "") return { found: true, value: root }
  if (!fragment.startsWith("/")) return { found: false, value: undefined }
  let current: unknown = root
  for (const rawToken of fragment.slice(1).split("/")) {
    let token = rawToken
    try {
      token = decodeURIComponent(rawToken)
    } catch {
      token = rawToken
    }
    token = token.replace(/~1/g, "/").replace(/~0/g, "~")
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined }
      }
      current = current[index]
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, token)) {
      current = current[token]
    } else {
      return { found: false, value: undefined }
    }
  }
  return { found: true, value: current }
}

/**
 * Validation state. Branches of `anyOf`/`oneOf`/`not` validate into a fresh
 * collector so their internal issues never leak, while `once` notes (a cycle,
 * an invalid pattern) always surface at the top level.
 */
interface Collector {
  readonly root: unknown
  readonly issues: Array<JsonIssue>
  readonly seen: Set<string>
  readonly once: Set<string>
  readonly patterns: Map<string, RegExp | undefined>
  readonly top: Collector | undefined
}

const report = (collector: Collector, path: string, detail: string): void => {
  const key = `${path}\u0000${detail}`
  if (collector.seen.has(key)) return
  collector.seen.add(key)
  collector.issues.push({ path, detail })
}

const reportOnce = (collector: Collector, path: string, detail: string): void => {
  if (collector.once.has(detail)) return
  collector.once.add(detail)
  report(collector.top ?? collector, path, detail)
}

const branch = (collector: Collector): Collector => ({
  root: collector.root,
  issues: [],
  seen: new Set(),
  once: collector.once,
  patterns: collector.patterns,
  top: collector.top ?? collector
})

const passes = (
  collector: Collector,
  schema: unknown,
  value: unknown,
  path: string,
  depth: number
) => {
  const probe = branch(collector)
  validate(probe, schema, value, path, depth)
  return probe.issues.length === 0
}

const compilePattern = (collector: Collector, source: string): RegExp | undefined => {
  const cached = collector.patterns.get(source)
  if (cached !== undefined) return cached
  let compiled: RegExp | undefined
  try {
    compiled = new RegExp(source, "u")
  } catch {
    compiled = undefined
  }
  collector.patterns.set(source, compiled)
  return compiled
}

const validateString = (
  collector: Collector,
  schema: JsonRecord,
  value: string,
  path: string
): void => {
  const length = Array.from(value).length
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    report(collector, path, `expected at least ${schema.minLength} characters, found ${length}`)
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    report(collector, path, `expected at most ${schema.maxLength} characters, found ${length}`)
  }
  if (typeof schema.pattern === "string") {
    const pattern = compilePattern(collector, schema.pattern)
    if (pattern === undefined) {
      reportOnce(collector, path, `invalid pattern ${JSON.stringify(schema.pattern)}`)
    } else if (!pattern.test(value)) {
      report(
        collector,
        path,
        `value ${render(value)} does not match pattern ${JSON.stringify(schema.pattern)}`
      )
    }
  }
}

const validateNumber = (
  collector: Collector,
  schema: JsonRecord,
  value: number,
  path: string
): void => {
  const rendered = render(value)
  if (typeof schema.minimum === "number") {
    if (schema.exclusiveMinimum === true) {
      if (value <= schema.minimum) {
        report(
          collector,
          path,
          `value ${rendered} is not greater than the exclusive minimum ${schema.minimum}`
        )
      }
    } else if (value < schema.minimum) {
      report(collector, path, `value ${rendered} is less than the minimum ${schema.minimum}`)
    }
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    report(
      collector,
      path,
      `value ${rendered} is not greater than the exclusive minimum ${schema.exclusiveMinimum}`
    )
  }
  if (typeof schema.maximum === "number") {
    if (schema.exclusiveMaximum === true) {
      if (value >= schema.maximum) {
        report(
          collector,
          path,
          `value ${rendered} is not less than the exclusive maximum ${schema.maximum}`
        )
      }
    } else if (value > schema.maximum) {
      report(collector, path, `value ${rendered} is greater than the maximum ${schema.maximum}`)
    }
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    report(
      collector,
      path,
      `value ${rendered} is not less than the exclusive maximum ${schema.exclusiveMaximum}`
    )
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      report(collector, path, `value ${rendered} is not a multiple of ${schema.multipleOf}`)
    }
  }
}

const validateArray = (
  collector: Collector,
  schema: JsonRecord,
  value: ReadonlyArray<unknown>,
  path: string,
  depth: number
): void => {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    report(collector, path, `expected at least ${schema.minItems} items, found ${value.length}`)
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    report(collector, path, `expected at most ${schema.maxItems} items, found ${value.length}`)
  }
  if (schema.uniqueItems === true) {
    for (let index = 1; index < value.length; index++) {
      const twin = value.findIndex(
        (item, earlier) => earlier < index && jsonEquals(item, value[index])
      )
      if (twin >= 0) {
        report(collector, path, `items are not unique: item ${index} duplicates item ${twin}`)
      }
    }
  }
  const items = schema.items
  if (Array.isArray(items)) {
    items.forEach((itemSchema, index) => {
      if (index < value.length)
        validate(collector, itemSchema, value[index], indexPath(path, index), depth)
    })
  } else if (items !== undefined) {
    value.forEach((item, index) => validate(collector, items, item, indexPath(path, index), depth))
  }
}

const validateObject = (
  collector: Collector,
  schema: JsonRecord,
  value: JsonRecord,
  path: string,
  depth: number
): void => {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === "string" && !hasValue(value, name)) {
        report(collector, path, `missing required property ${JSON.stringify(name)}`)
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (!hasValue(value, key)) continue
    const child = childPath(path, key)
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      validate(collector, properties[key], value[key], child, depth)
    } else if (schema.additionalProperties === false) {
      report(collector, path, `unexpected property ${JSON.stringify(key)}`)
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      validate(collector, schema.additionalProperties, value[key], child, depth)
    }
  }
}

const validate = (
  collector: Collector,
  schema: unknown,
  value: unknown,
  path: string,
  depth: number
): void => {
  if (depth > maxDepth) {
    reportOnce(collector, path, nestingTooDeep)
    return
  }
  if (schema === true) return
  if (schema === false) {
    report(collector, path, "value is not allowed by a false schema")
    return
  }
  if (!isRecord(schema)) {
    reportOnce(collector, path, `invalid schema of type ${jsonTypeOf(schema)}`)
    return
  }
  const next = depth + 1

  if (value === null && schema.nullable === true) return

  if (typeof schema.$ref === "string") {
    const resolved = resolvePointer(collector.root, schema.$ref)
    if (resolved.found) {
      validate(collector, resolved.value, value, path, next)
    } else {
      report(collector, path, `cannot resolve $ref ${JSON.stringify(schema.$ref)}`)
    }
  }

  const expected = typeNames(schema.type)
  if (expected.length > 0 && !expected.some((name) => matchesType(name, value))) {
    report(collector, path, `expected ${expected.join(" or ")}, found ${jsonTypeOf(value)}`)
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonEquals(candidate, value))
  ) {
    report(
      collector,
      path,
      `value ${render(value)} is not one of [${schema.enum.map(render).join(", ")}]`
    )
  }
  if (hasValue(schema, "const") && !jsonEquals(schema.const, value)) {
    report(collector, path, `value ${render(value)} is not the constant ${render(schema.const)}`)
  }

  if (typeof value === "string") validateString(collector, schema, value, path)
  else if (typeof value === "number") validateNumber(collector, schema, value, path)
  else if (Array.isArray(value)) validateArray(collector, schema, value, path, next)
  else if (isRecord(value)) validateObject(collector, schema, value, path, next)

  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) validate(collector, member, value, path, next)
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((member) => passes(collector, member, value, path, next))
    if (!matched) {
      report(
        collector,
        path,
        `value does not match any of the ${schema.anyOf.length} anyOf schemas`
      )
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((member) =>
      passes(collector, member, value, path, next)
    ).length
    if (matched !== 1) {
      report(
        collector,
        path,
        `expected exactly one of the ${schema.oneOf.length} oneOf schemas to match, ${matched} matched`
      )
    }
  }
  if (schema.not !== undefined && passes(collector, schema.not, value, path, next)) {
    report(collector, path, "value matches the not schema")
  }
}

/**
 * Validates `document` against `schema` and returns every issue found, in
 * document order, without duplicates.
 *
 * Supported keywords: `type` (a name or a list; `integer` is a whole number),
 * `nullable`, `enum`, `const`, `properties`, `required`, `additionalProperties`,
 * `items`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`,
 * `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
 * (numeric, or the draft-04 boolean form), `multipleOf`, `allOf`, `anyOf`,
 * `oneOf`, `not`, `$ref` to a local pointer, and the boolean schemas.
 */
export const validateJson = (
  schema: unknown,
  document: unknown,
  options?: JsonSchemaCheckOptions
): ReadonlyArray<JsonIssue> => {
  const collector: Collector = {
    root: options?.root ?? schema,
    issues: [],
    seen: new Set(),
    once: new Set(),
    patterns: new Map(),
    top: undefined
  }
  validate(collector, schema, document, "$", 0)
  return collector.issues
}
