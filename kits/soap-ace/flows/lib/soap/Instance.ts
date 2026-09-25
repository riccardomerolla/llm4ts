import type { Facets } from "./Catalog.ts"
import {
  ComplexTypeDef,
  type ElementDecl,
  type ElementField,
  isBuiltin,
  localName,
  type QName,
  SimpleTypeDef,
  splitClark,
  typeByName,
  type WsdlCatalog
} from "./Catalog.ts"
import { kindForName } from "./Masking.ts"
import { escapeAttribute, escapeText, elements, textOf, type XmlElement } from "./Xml.ts"
import { isYamlList, isYamlMap, yamlKey, yamlScalar, type YamlMap, type YamlValue } from "./Yaml.ts"

// Instances of catalog types as plain value trees (the shape request files
// are written in): the commented YAML skeleton of a request, validation of
// a value against its XSD type, and conversion both ways between values and
// XML. Leaves are strings (XML text); `null` is `xsi:nil`. Attributes are
// keys starting with `@`; the text of a simple-content type is `#text`.
// Child order on the wire follows the XSD sequence, not the file.

export const XsiNamespace = "http://www.w3.org/2001/XMLSchema-instance"

export interface Issue {
  /** Dotted path from the root element, with `[n]` for repeated elements. */
  readonly path: string
  readonly detail: string
}

// ---------------------------------------------------------------------------
// Simple types: builtin base and accumulated facets

interface SimpleView {
  readonly builtin: string
  readonly facets: ReadonlyArray<Facets>
  readonly chain: ReadonlyArray<string>
}

export const simpleView = (catalog: WsdlCatalog, name: QName): SimpleView => {
  const facets: Array<Facets> = []
  const chain: Array<string> = []
  let current = name
  for (let depth = 0; depth < 16 && !isBuiltin(current); depth++) {
    const type = typeByName(catalog, current)
    if (!(type instanceof SimpleTypeDef)) break
    facets.push(type.facets)
    chain.push(localName(type.name))
    current = type.base
  }
  return { builtin: isBuiltin(current) ? localName(current) : "string", facets, chain }
}

const integerTypes = new Set([
  "int",
  "integer",
  "long",
  "short",
  "byte",
  "nonNegativeInteger",
  "positiveInteger",
  "nonPositiveInteger",
  "negativeInteger",
  "unsignedInt",
  "unsignedLong",
  "unsignedShort",
  "unsignedByte"
])

const lexical: Readonly<Record<string, RegExp>> = {
  boolean: /^(true|false|1|0)$/,
  decimal: /^[+-]?(\d+(\.\d*)?|\.\d+)$/,
  float: /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|-INF|NaN)$/,
  double: /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|-INF|NaN)$/,
  date: /^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/,
  dateTime: /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  time: /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
  gYear: /^-?\d{4,}(Z|[+-]\d{2}:\d{2})?$/,
  base64Binary: /^[A-Za-z0-9+/\s]*=?=?\s*$/,
  hexBinary: /^([0-9A-Fa-f]{2})*$/
}

/** XSD patterns are implicitly anchored and mostly JS-compatible. */
const xsdRegex = (pattern: string): RegExp | undefined => {
  try {
    return new RegExp(
      `^(?:${pattern.replace(/\\i/g, "[A-Za-z_:]").replace(/\\c/g, "[A-Za-z0-9._:-]")})$`,
      "u"
    )
  } catch {
    return undefined
  }
}

const digitsOf = (value: string) => {
  const unsigned = value.replace(/^[+-]/, "")
  const [whole = "", fraction = ""] = unsigned.split(".")
  const trimmedFraction = fraction.replace(/0+$/, "")
  return {
    total: whole.replace(/^0+(?=\d)/, "").length + trimmedFraction.length,
    fraction: trimmedFraction.length
  }
}

export const checkSimple = (
  catalog: WsdlCatalog,
  type: QName,
  value: string
): ReadonlyArray<string> => {
  const view = simpleView(catalog, type)
  const problems: Array<string> = []
  const builtin = view.builtin
  if (integerTypes.has(builtin)) {
    if (!/^[+-]?\d+$/.test(value)) problems.push(`"${value}" is not an ${builtin}`)
  } else {
    const shape = lexical[builtin]
    if (shape !== undefined && !shape.test(value)) problems.push(`"${value}" is not a ${builtin}`)
  }
  const numeric = integerTypes.has(builtin) || ["decimal", "float", "double"].includes(builtin)
  for (const facets of view.facets) {
    if (facets.enumeration !== undefined && !facets.enumeration.includes(value)) {
      problems.push(`"${value}" is not one of ${facets.enumeration.join(", ")}`)
    }
    if (facets.pattern !== undefined && facets.pattern.length > 0) {
      const matches = facets.pattern.some((pattern) => xsdRegex(pattern)?.test(value) ?? true)
      if (!matches) problems.push(`"${value}" does not match ${facets.pattern.join(" | ")}`)
    }
    const length = [...value].length
    if (facets.length !== undefined && length !== facets.length) {
      problems.push(`length ${length}, expected ${facets.length}`)
    }
    if (facets.minLength !== undefined && length < facets.minLength) {
      problems.push(`length ${length} below ${facets.minLength}`)
    }
    if (facets.maxLength !== undefined && length > facets.maxLength) {
      problems.push(`length ${length} above ${facets.maxLength}`)
    }
    if (numeric && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value)) {
      const number = Number(value)
      const digits = digitsOf(value)
      if (facets.totalDigits !== undefined && digits.total > facets.totalDigits) {
        problems.push(`${digits.total} digits, at most ${facets.totalDigits}`)
      }
      if (facets.fractionDigits !== undefined && digits.fraction > facets.fractionDigits) {
        problems.push(`${digits.fraction} fraction digits, at most ${facets.fractionDigits}`)
      }
      if (facets.minInclusive !== undefined && number < Number(facets.minInclusive)) {
        problems.push(`${value} below ${facets.minInclusive}`)
      }
      if (facets.maxInclusive !== undefined && number > Number(facets.maxInclusive)) {
        problems.push(`${value} above ${facets.maxInclusive}`)
      }
      if (facets.minExclusive !== undefined && number <= Number(facets.minExclusive)) {
        problems.push(`${value} not above ${facets.minExclusive}`)
      }
      if (facets.maxExclusive !== undefined && number >= Number(facets.maxExclusive)) {
        problems.push(`${value} not below ${facets.maxExclusive}`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Example values

/** A string matching a simple XSD pattern: literals, classes, groups (first branch), quantifiers. */
export const patternExample = (pattern: string): string | undefined => {
  let index = 0
  const atom = (): string | undefined => {
    const char = pattern[index]
    if (char === undefined) return undefined
    if (char === "(") {
      index++
      const start = index
      let depth = 1
      while (index < pattern.length && depth > 0) {
        if (pattern[index] === "\\") index++
        else if (pattern[index] === "(") depth++
        else if (pattern[index] === ")") depth--
        index++
      }
      const inner = pattern.slice(start, index - 1).replace(/^\?:/, "")
      let branchDepth = 0
      let cut = inner.length
      for (let position = 0; position < inner.length; position++) {
        const current = inner[position]
        if (current === "\\") position++
        else if (current === "(" || current === "[") branchDepth++
        else if (current === ")" || current === "]") branchDepth--
        else if (current === "|" && branchDepth === 0) {
          cut = position
          break
        }
      }
      return patternExample(inner.slice(0, cut))
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1)
      if (end < 0) return undefined
      const body = pattern.slice(index + 1, end)
      index = end + 1
      if (body.startsWith("^")) return undefined
      if (body.startsWith("\\d") || /^0-9/.test(body)) return "0"
      const first = body.startsWith("\\") ? body[1] : body[0]
      return first === undefined ? undefined : first
    }
    if (char === "\\") {
      const escaped = pattern[index + 1]
      index += 2
      if (escaped === "d") return "0"
      if (escaped === "w") return "a"
      if (escaped === "s") return " "
      if (escaped === undefined) return undefined
      return /[A-Za-z]/.test(escaped) ? undefined : escaped
    }
    if (char === ".") {
      index++
      return "a"
    }
    if ("|)*+?{".includes(char)) return undefined
    index++
    return char
  }
  let result = ""
  while (index < pattern.length) {
    if (pattern[index] === "|") break
    const piece = atom()
    if (piece === undefined) return undefined
    const quantifier = /^(\{(\d+)(,(\d*))?\}|\*|\+|\?)/.exec(pattern.slice(index))
    let count = 1
    if (quantifier !== null) {
      index += quantifier[0].length
      if (quantifier[0] === "*" || quantifier[0] === "?") count = 0
      else if (quantifier[2] !== undefined) count = Number(quantifier[2])
    }
    result += piece.repeat(count)
  }
  return result
}

// Public example identifiers, valid by checksum; no real person or account.
const kindExamples: Readonly<Record<string, string>> = {
  iban: "IT60X0542811101000000123456",
  "codice-fiscale": "RSSMRA85T10A562S",
  "partita-iva": "12345678903",
  pan: "4111111111111111",
  email: "mario.rossi@example.invalid",
  phone: "+39 333 1234567",
  "birth-date": "1985-12-10"
}

const builtinExamples: Readonly<Record<string, string>> = {
  boolean: "false",
  decimal: "100.00",
  float: "1.0",
  double: "1.0",
  date: "2026-01-15",
  dateTime: "2026-01-15T10:00:00Z",
  time: "10:00:00",
  gYear: "2026",
  base64Binary: "",
  hexBinary: ""
}

/** An example value for a field: a seed, then field meaning, then facets, then the builtin. */
export const exampleValue = (
  catalog: WsdlCatalog,
  field: { readonly name: string; readonly type: QName },
  seeds: ReadonlyMap<string, string> = new Map()
): string => {
  const seeded = seeds.get(field.name)
  if (seeded !== undefined) return seeded
  const view = simpleView(catalog, field.type)
  const candidates: Array<string> = []
  const kind = kindForName(field.name) ?? kindForName(localName(field.type).replace(/Type$/, ""))
  if (kind !== undefined && kindExamples[kind] !== undefined)
    candidates.push(kindExamples[kind] ?? "")
  if (
    /divisa|currency|valuta$/i.test(field.name) ||
    /divisa|currency/i.test(view.chain.join(" "))
  ) {
    candidates.push("EUR")
  }
  for (const facets of view.facets) {
    if (facets.enumeration?.[0] !== undefined) candidates.push(facets.enumeration[0])
    for (const pattern of facets.pattern ?? []) {
      const example = patternExample(pattern)
      if (example !== undefined) candidates.push(example)
    }
    if (facets.minInclusive !== undefined) candidates.push(facets.minInclusive)
  }
  if (integerTypes.has(view.builtin)) candidates.push("1")
  const builtinExample = builtinExamples[view.builtin]
  if (builtinExample !== undefined) candidates.push(builtinExample)
  const maxLength = Math.min(
    ...view.facets.map((facets) => facets.maxLength ?? facets.length ?? 64)
  )
  candidates.push(field.name.slice(0, Math.max(1, maxLength)))
  return (
    candidates.find((candidate) => checkSimple(catalog, field.type, candidate).length === 0) ??
    candidates[0] ??
    ""
  )
}

// ---------------------------------------------------------------------------
// Skeleton

const describeSimple = (catalog: WsdlCatalog, type: QName): string => {
  const view = simpleView(catalog, type)
  const named = view.chain.filter((name) => !name.startsWith("~"))
  const parts: Array<string> = [...named.slice(0, 1), view.builtin]
  for (const facets of view.facets) {
    if (facets.enumeration !== undefined) parts.push(`one of ${facets.enumeration.join(" | ")}`)
    for (const pattern of facets.pattern ?? []) {
      if (pattern.length <= 40) parts.push(`pattern ${pattern}`)
    }
    if (facets.length !== undefined) parts.push(`length ${facets.length}`)
    if (facets.minLength !== undefined || facets.maxLength !== undefined) {
      parts.push(`length ${facets.minLength ?? 0}..${facets.maxLength ?? "*"}`)
    }
    if (facets.totalDigits !== undefined) parts.push(`${facets.totalDigits} digits`)
    if (facets.fractionDigits !== undefined) parts.push(`${facets.fractionDigits} decimals`)
    if (facets.minInclusive !== undefined || facets.maxInclusive !== undefined) {
      parts.push(`${facets.minInclusive ?? "…"}..${facets.maxInclusive ?? "…"}`)
    }
  }
  return [...new Set(parts)].join(", ")
}

const occursText = (field: ElementField): string =>
  field.maxOccurs === "unbounded"
    ? `${field.minOccurs}..*`
    : field.minOccurs === field.maxOccurs
      ? `${field.minOccurs}`
      : `${field.minOccurs}..${field.maxOccurs}`

export interface SkeletonOptions {
  readonly seeds?: ReadonlyMap<string, string>
  /** Include optional fields as values instead of comments. */
  readonly includeOptional?: boolean
  readonly maxDepth?: number
}

/**
 * The commented YAML body of an instance of `element`: required fields with
 * example values and a type note, optional ones as commented lines, choice
 * alternatives after the first commented as `or`.
 */
export const skeletonYaml = (
  catalog: WsdlCatalog,
  element: ElementDecl,
  indent: number,
  options: SkeletonOptions = {}
): ReadonlyArray<string> => {
  const maxDepth = options.maxDepth ?? 8
  const lines: Array<string> = []
  const emit = (depth: number, text: string) => lines.push(`${" ".repeat(depth)}${text}`)

  const complexBody = (
    type: ComplexTypeDef,
    depth: number,
    level: number,
    commented: boolean
  ): void => {
    const hash = commented ? "# " : ""
    for (const attribute of type.attributes) {
      const value = exampleValue(catalog, attribute, options.seeds)
      const optional = !attribute.required && options.includeOptional !== true
      emit(
        depth,
        `${hash}${optional ? "# " : ""}${yamlKey(`@${attribute.name}`)}: ${yamlScalar(value)}  # attribute, ${describeSimple(catalog, attribute.type)}`
      )
    }
    if (type.textType !== undefined) {
      emit(
        depth,
        `${hash}"#text": ${yamlScalar(exampleValue(catalog, { name: localName(type.name), type: type.textType }, options.seeds))}`
      )
    }
    const seenChoices = new Set<number>()
    for (const field of type.fields) {
      const alternative = field.choice !== undefined && seenChoices.has(field.choice)
      if (field.choice !== undefined) seenChoices.add(field.choice)
      const optional = field.minOccurs === 0 && options.includeOptional !== true
      const comment = commented || optional || alternative
      fieldLines(field, depth, level, comment, alternative)
    }
  }

  const fieldLines = (
    field: ElementField,
    depth: number,
    level: number,
    commented: boolean,
    alternative: boolean
  ): void => {
    const hash = commented ? "# " : ""
    const note = `${alternative ? "or, " : ""}${occursText(field)}${field.nillable ? ", nillable" : ""}`
    const repeated = field.maxOccurs === "unbounded" || field.maxOccurs > 1
    const type = typeByName(catalog, field.type)
    const key = yamlKey(field.name)
    if (type instanceof ComplexTypeDef) {
      const doc = field.documentation ?? type.documentation
      emit(
        depth,
        `${hash}${key}:  # ${localName(field.type).replace(/^~/, "")} [${note}]${doc === undefined ? "" : ` — ${doc}`}`
      )
      if (level >= maxDepth) {
        emit(depth + 2, `# … nested deeper than ${maxDepth} levels`)
        return
      }
      if (repeated) {
        emit(depth + 2, `${hash}-`)
        complexBody(type, depth + 4, level + 1, commented)
      } else {
        complexBody(type, depth + 2, level + 1, commented)
      }
      return
    }
    const value = exampleValue(catalog, field, options.seeds)
    const description = describeSimple(catalog, field.type)
    const doc = field.documentation === undefined ? "" : ` — ${field.documentation}`
    if (repeated) {
      emit(depth, `${hash}${key}:  # ${description} [${note}]${doc}`)
      emit(depth + 2, `${hash}- ${yamlScalar(value)}`)
    } else {
      emit(depth, `${hash}${key}: ${yamlScalar(value)}  # ${description} [${note}]${doc}`)
    }
  }

  const root = typeByName(catalog, element.type)
  if (root instanceof ComplexTypeDef) complexBody(root, indent, 1, false)
  else
    emit(
      indent,
      `"#text": ${yamlScalar(exampleValue(catalog, { name: localName(element.name), type: element.type }, options.seeds))}  # ${describeSimple(catalog, element.type)}`
    )
  return lines
}

// ---------------------------------------------------------------------------
// Validation of values

const join = (path: string, segment: string): string =>
  path === "" ? segment : `${path}.${segment}`

const validateComplex = (
  catalog: WsdlCatalog,
  type: ComplexTypeDef,
  value: YamlMap,
  path: string,
  issues: Array<Issue>
): void => {
  const known = new Set([
    ...type.fields.map((field) => field.name),
    ...type.attributes.map((attribute) => `@${attribute.name}`),
    ...(type.textType === undefined ? [] : ["#text"])
  ])
  for (const key of Object.keys(value)) {
    if (!known.has(key))
      issues.push({
        path: join(path, key),
        detail: `not a field of ${localName(type.name).replace(/^~/, "")}`
      })
  }
  for (const attribute of type.attributes) {
    const item = value[`@${attribute.name}`]
    if (item === undefined || item === null) {
      if (attribute.required)
        issues.push({
          path: join(path, `@${attribute.name}`),
          detail: "required attribute is missing"
        })
    } else if (typeof item !== "string") {
      issues.push({
        path: join(path, `@${attribute.name}`),
        detail: "an attribute holds a single value"
      })
    } else {
      for (const problem of checkSimple(catalog, attribute.type, item)) {
        issues.push({ path: join(path, `@${attribute.name}`), detail: problem })
      }
    }
  }
  if (type.textType !== undefined) {
    const text = value["#text"]
    if (typeof text === "string") {
      for (const problem of checkSimple(catalog, type.textType, text))
        issues.push({ path: join(path, "#text"), detail: problem })
    }
  }
  const choices = new Map<number, Array<string>>()
  for (const field of type.fields) {
    const item = value[field.name]
    if (field.choice !== undefined && item !== undefined) {
      choices.set(field.choice, [...(choices.get(field.choice) ?? []), field.name])
    }
  }
  for (const present of choices.values()) {
    if (present.length > 1)
      issues.push({
        path: path === "" ? "(root)" : path,
        detail: `choose one of ${present.join(", ")}`
      })
  }
  for (const field of type.fields) {
    const item = value[field.name]
    const fieldPath = join(path, field.name)
    const inChoice = field.choice !== undefined
    if (item === undefined) {
      const otherBranchTaken = inChoice && (choices.get(field.choice ?? -1)?.length ?? 0) > 0
      const choiceHasRequiredBranch = inChoice && !otherBranchTaken
      if (field.minOccurs > 0 && !inChoice)
        issues.push({ path: fieldPath, detail: "required field is missing" })
      else if (choiceHasRequiredBranch && field.minOccurs > 0 && isFirstInChoice(type, field)) {
        const names = type.fields
          .filter((other) => other.choice === field.choice)
          .map((other) => other.name)
        issues.push({
          path: path === "" ? "(root)" : path,
          detail: `one of ${names.join(", ")} is required`
        })
      }
      continue
    }
    const items = isYamlList(item) ? item : [item]
    const repeated = field.maxOccurs === "unbounded" || field.maxOccurs > 1
    if (isYamlList(item) && !repeated) {
      issues.push({ path: fieldPath, detail: "occurs at most once; write a single value" })
    }
    if (items.length < field.minOccurs)
      issues.push({ path: fieldPath, detail: `at least ${field.minOccurs} occurrences` })
    if (field.maxOccurs !== "unbounded" && items.length > field.maxOccurs) {
      issues.push({ path: fieldPath, detail: `at most ${field.maxOccurs} occurrences` })
    }
    items.forEach((entry, position) => {
      validateValue(
        catalog,
        field.type,
        field.nillable,
        entry,
        isYamlList(item) ? `${fieldPath}[${position}]` : fieldPath,
        issues
      )
    })
  }
}

const isFirstInChoice = (type: ComplexTypeDef, field: ElementField): boolean =>
  type.fields.find((other) => other.choice === field.choice) === field

const validateValue = (
  catalog: WsdlCatalog,
  typeName: QName,
  nillable: boolean,
  value: YamlValue,
  path: string,
  issues: Array<Issue>
): void => {
  if (value === null) {
    if (!nillable)
      issues.push({ path, detail: "is not nillable; give a value or remove the field" })
    return
  }
  const type = typeByName(catalog, typeName)
  if (type instanceof ComplexTypeDef) {
    if (typeof value === "string" && type.textType !== undefined) {
      validateComplex(catalog, type, { "#text": value }, path, issues)
    } else if (!isYamlMap(value)) {
      issues.push({ path, detail: `expects fields of ${localName(type.name).replace(/^~/, "")}` })
    } else {
      validateComplex(catalog, type, value, path, issues)
    }
    return
  }
  if (typeof value !== "string") {
    issues.push({ path, detail: "expects a single value" })
    return
  }
  for (const problem of checkSimple(catalog, typeName, value))
    issues.push({ path, detail: problem })
}

/** Validate a value tree against a global element's type. */
export const validateInstance = (
  catalog: WsdlCatalog,
  element: ElementDecl,
  value: YamlValue
): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = []
  validateValue(catalog, element.type, element.nillable, value, "", issues)
  return issues.map((issue) => (issue.path === "" ? { ...issue, path: "(root)" } : issue))
}

// ---------------------------------------------------------------------------
// Value → XML

/** Serialize an instance of `element` with prefixes `ns1`, `ns2`… declared on the root. */
export const instanceToXml = (
  catalog: WsdlCatalog,
  element: ElementDecl,
  value: YamlValue
): string => {
  const prefixes = new Map<string, string>()
  const prefixOf = (namespace: string): string => {
    if (namespace === "") return ""
    let prefix = prefixes.get(namespace)
    if (prefix === undefined) {
      prefix = `ns${prefixes.size + 1}`
      prefixes.set(namespace, prefix)
    }
    return prefix
  }
  let usesXsi = false
  const qualified = (namespace: string, local: string) => {
    const prefix = prefixOf(namespace)
    return prefix === "" ? local : `${prefix}:${local}`
  }

  const write = (name: string, typeName: QName, item: YamlValue): string => {
    if (item === null) {
      usesXsi = true
      return `<${name} xsi:nil="true"/>`
    }
    const type = typeByName(catalog, typeName)
    if (!(type instanceof ComplexTypeDef)) {
      return `<${name}>${escapeText(typeof item === "string" ? item : "")}</${name}>`
    }
    const map: YamlMap = typeof item === "string" ? { "#text": item } : isYamlMap(item) ? item : {}
    const attributes = type.attributes
      .flatMap((attribute) => {
        const attributeValue = map[`@${attribute.name}`]
        return typeof attributeValue === "string"
          ? [` ${attribute.name}="${escapeAttribute(attributeValue)}"`]
          : []
      })
      .join("")
    const text = typeof map["#text"] === "string" ? escapeText(map["#text"]) : ""
    const children = type.fields
      .flatMap((field) => {
        const child = map[field.name]
        if (child === undefined) return []
        const entries = isYamlList(child) ? child : [child]
        return entries.map((entry) =>
          write(qualified(field.namespace, field.name), field.type, entry)
        )
      })
      .join("")
    const content = `${text}${children}`
    return content === "" ? `<${name}${attributes}/>` : `<${name}${attributes}>${content}</${name}>`
  }

  const root = splitClark(element.name)
  const rootName = qualified(root.namespace, root.local)
  const body = write(rootName, element.type, value)
  const declarations = [
    ...[...prefixes].map(
      ([namespace, prefix]) => ` xmlns:${prefix}="${escapeAttribute(namespace)}"`
    ),
    ...(usesXsi ? [` xmlns:xsi="${XsiNamespace}"`] : [])
  ].join("")
  return body.replace(/^<([^\s/>]+)/, `<$1${declarations}`)
}

// ---------------------------------------------------------------------------
// XML → value

/**
 * Read an XML element as an instance of `element`'s type. Unknown children,
 * wrong namespaces, and repeated singletons become issues; values are kept
 * as found so a response can be analysed even when it breaks its schema.
 */
export const instanceFromXml = (
  catalog: WsdlCatalog,
  element: ElementDecl,
  xml: XmlElement
): { readonly value: YamlValue; readonly issues: ReadonlyArray<Issue> } => {
  const issues: Array<Issue> = []
  const expected = splitClark(element.name)
  if (xml.name.local !== expected.local || xml.name.namespace !== expected.namespace) {
    issues.push({
      path: "(root)",
      detail: `expected {${expected.namespace}}${expected.local}, found {${xml.name.namespace}}${xml.name.local}`
    })
  }
  const nil = (node: XmlElement) =>
    node.attributes.some(
      (attribute) =>
        attribute.name.namespace === XsiNamespace &&
        attribute.name.local === "nil" &&
        attribute.value === "true"
    )

  const read = (node: XmlElement, typeName: QName, path: string): YamlValue => {
    if (nil(node)) return null
    const type = typeByName(catalog, typeName)
    if (!(type instanceof ComplexTypeDef)) return textOf(node)
    const result: Record<string, YamlValue> = {}
    for (const attribute of node.attributes) {
      if (attribute.name.namespace === XsiNamespace) continue
      if (!type.attributes.some((declared) => declared.name === attribute.name.local)) {
        issues.push({
          path: join(path, `@${attribute.name.local}`),
          detail: "attribute not declared"
        })
      }
      result[`@${attribute.name.local}`] = attribute.value
    }
    if (type.textType !== undefined) result["#text"] = textOf(node)
    else if (textOf(node).trim() !== "")
      issues.push({ path: path === "" ? "(root)" : path, detail: "unexpected text content" })
    for (const child of elements(node)) {
      const field = type.fields.find((candidate) => candidate.name === child.name.local)
      const childPath = join(path, child.name.local)
      if (field === undefined) {
        // Kept as text; validation reports it as not a field of the type.
        result[child.name.local] = textOf(child)
        continue
      }
      if (child.name.namespace !== field.namespace) {
        issues.push({
          path: childPath,
          detail: `namespace ${child.name.namespace === "" ? "(none)" : child.name.namespace}, expected ${field.namespace === "" ? "(none)" : field.namespace}`
        })
      }
      const childValue = read(child, field.type, childPath)
      const repeated = field.maxOccurs === "unbounded" || field.maxOccurs > 1
      const existing = result[field.name]
      if (repeated) {
        const prior = existing !== undefined && isYamlList(existing) ? existing : []
        result[field.name] = [...prior, childValue]
      } else if (existing !== undefined) {
        issues.push({ path: childPath, detail: "occurs more than once" })
      } else {
        result[field.name] = childValue
      }
    }
    return result
  }

  const value = read(xml, element.type, "")
  return { value, issues: [...issues, ...validateInstance(catalog, element, value)] }
}
