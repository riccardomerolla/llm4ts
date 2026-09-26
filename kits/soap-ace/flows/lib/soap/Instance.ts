import type { Facets } from "./Catalog.ts"
import {
  ComplexTypeDef,
  contentModel,
  type ElementDecl,
  type ElementField,
  emptiable,
  isBuiltin,
  localName,
  type Particle,
  particleFields,
  qname,
  type QName,
  SimpleTypeDef,
  splitClark,
  typeByName,
  type WsdlCatalog,
  XsdNamespace
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
  /** Facets of every restriction step, most derived first (above a list: of the list). */
  readonly facets: ReadonlyArray<Facets>
  readonly chain: ReadonlyArray<string>
  /** Set when the type is a list: its item type. */
  readonly itemType: QName | undefined
  /** A union: values are strings of unknown shape. */
  readonly union: boolean
}

/** Built-in list types and their item types. */
const builtinLists: Readonly<Record<string, string>> = {
  NMTOKENS: "NMTOKEN",
  IDREFS: "IDREF",
  ENTITIES: "ENTITY"
}

export const simpleView = (catalog: WsdlCatalog, name: QName): SimpleView => {
  const facets: Array<Facets> = []
  const chain: Array<string> = []
  let current = name
  let itemType: QName | undefined
  let union = false
  for (let depth = 0; depth < 16 && !isBuiltin(current); depth++) {
    const type = typeByName(catalog, current)
    if (!(type instanceof SimpleTypeDef)) break
    chain.push(localName(type.name))
    if (type.variety === "list") {
      itemType = type.itemType ?? qname(XsdNamespace, "string")
      break
    }
    if (type.variety === "union") union = true
    facets.push(type.facets)
    current = type.base
  }
  const builtin = isBuiltin(current) ? localName(current) : "string"
  const listItem = builtinLists[builtin]
  if (itemType === undefined && listItem !== undefined) itemType = qname(XsdNamespace, listItem)
  return { builtin, facets, chain, itemType, union }
}

/** Inclusive bounds of the integer built-ins; `undefined` is unbounded. */
const integerRanges: Readonly<Record<string, readonly [bigint | undefined, bigint | undefined]>> = {
  integer: [undefined, undefined],
  nonNegativeInteger: [0n, undefined],
  positiveInteger: [1n, undefined],
  nonPositiveInteger: [undefined, 0n],
  negativeInteger: [undefined, -1n],
  long: [-(2n ** 63n), 2n ** 63n - 1n],
  int: [-(2n ** 31n), 2n ** 31n - 1n],
  short: [-32768n, 32767n],
  byte: [-128n, 127n],
  unsignedLong: [0n, 2n ** 64n - 1n],
  unsignedInt: [0n, 2n ** 32n - 1n],
  unsignedShort: [0n, 65535n],
  unsignedByte: [0n, 255n]
}

const integerTypes = new Set(Object.keys(integerRanges))

const isDecimal = (builtin: string) => builtin === "decimal" || integerTypes.has(builtin)
const isFloating = (builtin: string) => builtin === "float" || builtin === "double"

/** Built-ins derived from xs:string by whitespace: token and its descendants collapse. */
const replacing = new Set(["normalizedString"])
const preserving = new Set(["string", "anySimpleType", "anyType"])

/** The effective whiteSpace facet: the most derived one, else the built-in's. */
const whiteSpaceOf = (view: SimpleView): "preserve" | "replace" | "collapse" => {
  for (const facets of view.facets) if (facets.whiteSpace !== undefined) return facets.whiteSpace
  if (view.itemType !== undefined) return "collapse"
  if (view.union || preserving.has(view.builtin)) return "preserve"
  return replacing.has(view.builtin) ? "replace" : "collapse"
}

const normalizeSpace = (value: string, mode: "preserve" | "replace" | "collapse"): string =>
  mode === "preserve"
    ? value
    : mode === "replace"
      ? value.replace(/[\t\n\r]/g, " ")
      : value.replace(/[\t\n\r ]+/g, " ").trim()

const zone = "(Z|[+-]\\d{2}:\\d{2})?"

const validZone = (text: string | undefined): boolean => {
  if (text === undefined || text === "Z") return true
  const hours = Number(text.slice(1, 3))
  const minutes = Number(text.slice(4, 6))
  return minutes < 60 && (hours < 14 || (hours === 14 && minutes === 0))
}

const leapYear = (year: string): boolean => {
  // The leap rule only needs the year modulo 400, which its last four digits give.
  const last = Number(year.replace(/^-/, "").slice(-4))
  return last % 4 === 0 && (last % 100 !== 0 || last % 400 === 0)
}

const daysIn = (year: string, month: number): number =>
  month === 2 ? (leapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31

const validMonth = (month: string) => Number(month) >= 1 && Number(month) <= 12

const validDate = (year: string, month: string, day: string): boolean =>
  validMonth(month) && Number(day) >= 1 && Number(day) <= daysIn(year, Number(month))

const validTime = (hours: string, minutes: string, seconds: string, fraction: string) =>
  (Number(hours) < 24 && Number(minutes) < 60 && Number(seconds) < 60) ||
  (hours === "24" && minutes === "00" && seconds === "00" && /^(\.0+)?$/.test(fraction))

const shapes: Readonly<Record<string, RegExp>> = {
  date: new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})${zone}$`),
  dateTime: new RegExp(
    `^(-?\\d{4,})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?${zone}$`
  ),
  time: new RegExp(`^(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?${zone}$`),
  gYearMonth: new RegExp(`^(-?\\d{4,})-(\\d{2})${zone}$`),
  gYear: new RegExp(`^(-?\\d{4,})${zone}$`),
  gMonth: new RegExp(`^--(\\d{2})(?:--)?${zone}$`),
  gDay: new RegExp(`^---(\\d{2})${zone}$`),
  gMonthDay: new RegExp(`^--(\\d{2})-(\\d{2})${zone}$`)
}

const lexical: Readonly<Record<string, (value: string) => boolean>> = {
  boolean: (value) => /^(true|false|1|0)$/.test(value),
  decimal: (value) => /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value),
  float: (value) => /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|-INF|NaN)$/.test(value),
  double: (value) => /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|INF|-INF|NaN)$/.test(value),
  duration: (value) =>
    /^-?P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(value),
  date: (value) => {
    const match = shapes.date?.exec(value)
    return (
      match != null &&
      validDate(match[1] ?? "", match[2] ?? "", match[3] ?? "") &&
      validZone(match[4])
    )
  },
  dateTime: (value) => {
    const match = shapes.dateTime?.exec(value)
    return (
      match != null &&
      validDate(match[1] ?? "", match[2] ?? "", match[3] ?? "") &&
      validTime(match[4] ?? "", match[5] ?? "", match[6] ?? "", match[7] ?? "") &&
      validZone(match[8])
    )
  },
  time: (value) => {
    const match = shapes.time?.exec(value)
    return (
      match != null &&
      validTime(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "") &&
      validZone(match[5])
    )
  },
  gYearMonth: (value) => {
    const match = shapes.gYearMonth?.exec(value)
    return match != null && validMonth(match[2] ?? "") && validZone(match[3])
  },
  gYear: (value) => {
    const match = shapes.gYear?.exec(value)
    return match != null && validZone(match[2])
  },
  gMonth: (value) => {
    const match = shapes.gMonth?.exec(value)
    return match != null && validMonth(match[1] ?? "") && validZone(match[2])
  },
  gDay: (value) => {
    const match = shapes.gDay?.exec(value)
    return match != null && Number(match[1]) >= 1 && Number(match[1]) <= 31 && validZone(match[2])
  },
  gMonthDay: (value) => {
    const match = shapes.gMonthDay?.exec(value)
    return (
      match != null &&
      validMonth(match[1] ?? "") &&
      Number(match[2]) >= 1 &&
      // A leap year: --02-29 is a valid month-day.
      Number(match[2]) <= daysIn("2000", Number(match[1])) &&
      validZone(match[3])
    )
  },
  // Whole quanta of four characters, padding only at the end.
  base64Binary: (value) =>
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.replace(/[\t\n\r ]/g, "")
    ),
  hexBinary: (value) => /^([0-9A-Fa-f]{2})*$/.test(value)
}

// XSD regular expressions: implicitly anchored, no anchors of their own,
// `.` excludes only line ends, \d \w \s \i \c and \p{Is<Block>} mean more
// (or less) than in JavaScript, and classes can be subtracted. Translated
// token by token; anything without a faithful translation is refused.

const unicodeBlocks: Readonly<Record<string, string>> = {
  BasicLatin: "\\u{0}-\\u{7F}",
  "Latin-1Supplement": "\\u{80}-\\u{FF}",
  "LatinExtended-A": "\\u{100}-\\u{17F}",
  "LatinExtended-B": "\\u{180}-\\u{24F}",
  IPAExtensions: "\\u{250}-\\u{2AF}",
  SpacingModifierLetters: "\\u{2B0}-\\u{2FF}",
  CombiningDiacriticalMarks: "\\u{300}-\\u{36F}",
  Greek: "\\u{370}-\\u{3FF}",
  GreekandCoptic: "\\u{370}-\\u{3FF}",
  Cyrillic: "\\u{400}-\\u{4FF}",
  Armenian: "\\u{530}-\\u{58F}",
  Hebrew: "\\u{590}-\\u{5FF}",
  Arabic: "\\u{600}-\\u{6FF}",
  Devanagari: "\\u{900}-\\u{97F}",
  Thai: "\\u{E00}-\\u{E7F}",
  LatinExtendedAdditional: "\\u{1E00}-\\u{1EFF}",
  GreekExtended: "\\u{1F00}-\\u{1FFF}",
  GeneralPunctuation: "\\u{2000}-\\u{206F}",
  SuperscriptsandSubscripts: "\\u{2070}-\\u{209F}",
  CurrencySymbols: "\\u{20A0}-\\u{20CF}",
  LetterlikeSymbols: "\\u{2100}-\\u{214F}",
  NumberForms: "\\u{2150}-\\u{218F}",
  Arrows: "\\u{2190}-\\u{21FF}",
  MathematicalOperators: "\\u{2200}-\\u{22FF}",
  BoxDrawing: "\\u{2500}-\\u{257F}",
  CJKSymbolsandPunctuation: "\\u{3000}-\\u{303F}",
  Hiragana: "\\u{3040}-\\u{309F}",
  Katakana: "\\u{30A0}-\\u{30FF}",
  CJKUnifiedIdeographs: "\\u{4E00}-\\u{9FFF}",
  HangulSyllables: "\\u{AC00}-\\u{D7AF}",
  PrivateUse: "\\u{E000}-\\u{F8FF}",
  AlphabeticPresentationForms: "\\u{FB00}-\\u{FB4F}",
  HalfwidthandFullwidthForms: "\\u{FF00}-\\u{FFEF}",
  Specials: "\\u{FFF0}-\\u{FFFF}"
}

/** An escape as JavaScript source: inside a class (when expressible) and as an atom. */
interface Escape {
  readonly inside: string | undefined
  readonly atom: string
}

const set = (members: string): Escape => ({ inside: members, atom: `[${members}]` })
const complement = (members: string): Escape => ({ inside: undefined, atom: `[^${members}]` })

const classEscapes: Readonly<Record<string, Escape>> = {
  d: { inside: "\\p{Nd}", atom: "\\p{Nd}" },
  D: { inside: "\\P{Nd}", atom: "\\P{Nd}" },
  s: set(" \\t\\n\\r"),
  S: complement(" \\t\\n\\r"),
  w: set("\\p{L}\\p{M}\\p{N}\\p{S}"),
  W: set("\\p{P}\\p{Z}\\p{C}"),
  i: set("\\p{L}_:"),
  I: complement("\\p{L}_:"),
  c: set("\\p{L}\\p{M}\\p{N}._:\\-"),
  C: complement("\\p{L}\\p{M}\\p{N}._:\\-")
}

const categories = /^(L[ultmo]?|M[nce]?|N[dlo]?|P[cdseifo]?|Z[slp]?|S[mcko]?|C[cfons]?)$/

/** Translate an XSD pattern to an anchored JavaScript source; undefined when impossible. */
export const translatePattern = (pattern: string): string | undefined => {
  let index = 0
  const escape = (): Escape | undefined => {
    const char = pattern[index + 1]
    index += 2
    if (char === undefined) return undefined
    if (char === "n") return { inside: "\\n", atom: "\\n" }
    if (char === "r") return { inside: "\\r", atom: "\\r" }
    if (char === "t") return { inside: "\\t", atom: "\\t" }
    if (char === "-") return { inside: "\\-", atom: "-" }
    if ("\\|.?*+(){}[]^".includes(char)) return { inside: `\\${char}`, atom: `\\${char}` }
    const known = classEscapes[char]
    if (known !== undefined) return known
    if (char !== "p" && char !== "P") return undefined
    const close = pattern.indexOf("}", index)
    if (pattern[index] !== "{" || close < 0) return undefined
    const property = pattern.slice(index + 1, close)
    index = close + 1
    if (property.startsWith("Is")) {
      const block = unicodeBlocks[property.slice(2)]
      if (block === undefined) return undefined
      return char === "p" ? set(block) : complement(block)
    }
    if (!categories.test(property)) return undefined
    const atom = `\\${char}{${property}}`
    return { inside: atom, atom }
  }
  // A class body after its `[`, through its `]`; subtraction as a lookahead.
  const characterClass = (): string | undefined => {
    const negated = pattern[index] === "^"
    if (negated) index++
    let members = ""
    let subtracted: string | undefined
    for (;;) {
      const char = pattern[index]
      if (char === undefined) return undefined
      if (char === "]") {
        index++
        break
      }
      if (char === "-" && pattern[index + 1] === "[") {
        index += 2
        subtracted = characterClass()
        if (subtracted === undefined || pattern[index] !== "]") return undefined
        index++
        break
      }
      if (char === "\\") {
        const escaped = escape()
        if (escaped?.inside === undefined) return undefined
        members += escaped.inside
      } else if (char === "[") {
        return undefined
      } else {
        members += char
        index++
      }
    }
    if (members === "") return undefined
    const base = `[${negated ? "^" : ""}${members}]`
    return subtracted === undefined ? base : `(?:(?!${subtracted})${base})`
  }
  let source = ""
  while (index < pattern.length) {
    const char = pattern[index] ?? ""
    if (char === "\\") {
      const escaped = escape()
      if (escaped === undefined) return undefined
      source += escaped.atom
    } else if (char === "[") {
      index++
      const translated = characterClass()
      if (translated === undefined) return undefined
      source += translated
    } else if (char === ".") {
      source += "[^\\n\\r]"
      index++
    } else if (char === "^" || char === "$") {
      source += `\\${char}`
      index++
    } else {
      source += char
      index++
    }
  }
  return `^(?:${source})$`
}

const xsdRegex = (pattern: string): RegExp | undefined => {
  const source = translatePattern(pattern)
  if (source === undefined) return undefined
  try {
    return new RegExp(source, "u")
  } catch {
    return undefined
  }
}

interface DecimalParts {
  readonly negative: boolean
  readonly whole: string
  readonly fraction: string
}

const decimalParts = (value: string): DecimalParts | undefined => {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(value)
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) return undefined
  return {
    negative: match[1] === "-",
    whole: (match[2] ?? "").replace(/^0+/, ""),
    fraction: (match[3] ?? "").replace(/0+$/, "")
  }
}

/** Exact comparison of two decimal literals: -1, 0, 1, or undefined when either is not one. */
const compareDecimal = (left: string, right: string): number | undefined => {
  const a = decimalParts(left)
  const b = decimalParts(right)
  if (a === undefined || b === undefined) return undefined
  const scale = Math.max(a.fraction.length, b.fraction.length)
  const scaled = (parts: DecimalParts) => {
    const magnitude = BigInt(`${parts.whole}${parts.fraction.padEnd(scale, "0")}` || "0")
    return parts.negative ? -magnitude : magnitude
  }
  const x = scaled(a)
  const y = scaled(b)
  return x < y ? -1 : x > y ? 1 : 0
}

const floating = (value: string): number =>
  value === "INF" ? Infinity : value === "-INF" ? -Infinity : Number(value)

/** Order two values of a numeric built-in; undefined when not comparable. */
const compareValues = (builtin: string, left: string, right: string): number | undefined => {
  if (isDecimal(builtin)) return compareDecimal(left, right)
  if (isFloating(builtin)) {
    const x = floating(left)
    const y = floating(right)
    if (Number.isNaN(x) || Number.isNaN(y)) return undefined
    return x < y ? -1 : x > y ? 1 : 0
  }
  return undefined
}

/** Equality in the value space of the built-in (`1.0` is `1.00` as a decimal). */
const sameValue = (builtin: string, left: string, right: string): boolean => {
  if (isDecimal(builtin) || isFloating(builtin)) {
    const order = compareValues(builtin, left, right)
    if (order !== undefined) return order === 0
    return isFloating(builtin) && left === "NaN" && right === "NaN"
  }
  if (builtin === "boolean") {
    const truth = (value: string) => (value === "1" ? "true" : value === "0" ? "false" : value)
    return truth(left) === truth(right)
  }
  return left === right
}

/** Length in the facet's unit: octets for binaries, code points otherwise. */
const lengthOf = (builtin: string, value: string): number => {
  if (builtin === "hexBinary") return Math.floor(value.length / 2)
  if (builtin === "base64Binary") {
    const compact = value.replace(/[\t\n\r ]/g, "")
    return Math.floor(compact.length / 4) * 3 - (compact.match(/=+$/)?.[0].length ?? 0)
  }
  return [...value].length
}

const digitsOf = (value: string) => {
  const parts = decimalParts(value)
  const whole = parts?.whole ?? ""
  const fraction = parts?.fraction ?? ""
  return { total: whole.length + fraction.length, fraction: fraction.length }
}

export const checkSimple = (
  catalog: WsdlCatalog,
  type: QName,
  raw: string
): ReadonlyArray<string> => {
  const view = simpleView(catalog, type)
  // Every check sees the value after its whiteSpace facet normalizes it.
  const value = normalizeSpace(raw, whiteSpaceOf(view))
  const problems: Array<string> = []
  const builtin = view.builtin
  const items = view.itemType === undefined ? undefined : value === "" ? [] : value.split(" ")
  if (items !== undefined) {
    for (const item of items) {
      for (const problem of checkSimple(catalog, view.itemType ?? type, item)) {
        problems.push(`item ${problem}`)
      }
    }
  } else if (view.union) {
    // Member types are not modelled; any string is accepted.
  } else if (integerTypes.has(builtin)) {
    const [low, high] = integerRanges[builtin] ?? [undefined, undefined]
    if (!/^[+-]?\d+$/.test(value)) problems.push(`"${value}" is not an ${builtin}`)
    else {
      const number = BigInt(value.replace(/^\+/, ""))
      if ((low !== undefined && number < low) || (high !== undefined && number > high)) {
        problems.push(`${value} is out of the ${builtin} range`)
      }
    }
  } else {
    const shape = lexical[builtin]
    if (shape !== undefined && !shape(value)) problems.push(`"${value}" is not a ${builtin}`)
  }
  const lexicallyValid = problems.length === 0
  for (const facets of view.facets) {
    if (
      facets.enumeration !== undefined &&
      !facets.enumeration.some((option) =>
        sameValue(builtin, normalizeSpace(option, whiteSpaceOf(view)), value)
      )
    ) {
      problems.push(`"${value}" is not one of ${facets.enumeration.join(", ")}`)
    }
    if (facets.pattern !== undefined && facets.pattern.length > 0) {
      const regexes = facets.pattern.map(xsdRegex)
      const untranslatable = facets.pattern.filter((_, position) => regexes[position] === undefined)
      if (untranslatable.length > 0) {
        problems.push(`pattern ${untranslatable.join(" | ")} cannot be checked`)
      } else if (!regexes.some((regex) => regex?.test(value) ?? false)) {
        problems.push(`"${value}" does not match ${facets.pattern.join(" | ")}`)
      }
    }
    const length = items === undefined ? lengthOf(builtin, value) : items.length
    const unit = items === undefined ? "length" : "items"
    if (facets.length !== undefined && length !== facets.length) {
      problems.push(`${unit} ${length}, expected ${facets.length}`)
    }
    if (facets.minLength !== undefined && length < facets.minLength) {
      problems.push(`${unit} ${length} below ${facets.minLength}`)
    }
    if (facets.maxLength !== undefined && length > facets.maxLength) {
      problems.push(`${unit} ${length} above ${facets.maxLength}`)
    }
    if (items !== undefined || !lexicallyValid) continue
    if (isDecimal(builtin)) {
      const digits = digitsOf(value)
      if (facets.totalDigits !== undefined && digits.total > facets.totalDigits) {
        problems.push(`${digits.total} digits, at most ${facets.totalDigits}`)
      }
      if (facets.fractionDigits !== undefined && digits.fraction > facets.fractionDigits) {
        problems.push(`${digits.fraction} fraction digits, at most ${facets.fractionDigits}`)
      }
    }
    const compare = (bound: string | undefined) =>
      bound === undefined ? undefined : compareValues(builtin, value, bound.trim())
    const minInclusive = compare(facets.minInclusive)
    const maxInclusive = compare(facets.maxInclusive)
    const minExclusive = compare(facets.minExclusive)
    const maxExclusive = compare(facets.maxExclusive)
    if (minInclusive !== undefined && minInclusive < 0) {
      problems.push(`${value} below ${facets.minInclusive}`)
    }
    if (maxInclusive !== undefined && maxInclusive > 0) {
      problems.push(`${value} above ${facets.maxInclusive}`)
    }
    if (minExclusive !== undefined && minExclusive <= 0) {
      problems.push(`${value} not above ${facets.minExclusive}`)
    }
    if (maxExclusive !== undefined && maxExclusive >= 0) {
      problems.push(`${value} not below ${facets.maxExclusive}`)
    }
  }
  return problems
}

/** A `fixed=` value: the only one allowed (an empty element takes it). */
const checkFixed = (
  catalog: WsdlCatalog,
  type: QName,
  raw: string,
  fixed: string,
  emptyTakesFixed: boolean
): ReadonlyArray<string> => {
  const view = simpleView(catalog, type)
  const mode = whiteSpaceOf(view)
  const value = normalizeSpace(raw, mode)
  if (emptyTakesFixed && raw === "") return []
  return sameValue(view.builtin, value, normalizeSpace(fixed, mode))
    ? []
    : [`"${value}" is fixed to "${fixed}"`]
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
  gYearMonth: "2026-01",
  gMonth: "--01",
  gDay: "---15",
  gMonthDay: "--01-15",
  duration: "P1D",
  base64Binary: "",
  hexBinary: ""
}

/** An example value for a field: its fixed value, a seed, field meaning, facets, the builtin. */
export const exampleValue = (
  catalog: WsdlCatalog,
  field: { readonly name: string; readonly type: QName; readonly fixed?: string },
  seeds: ReadonlyMap<string, string> = new Map()
): string => {
  if (field.fixed !== undefined) return field.fixed
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
    // The first alternative of each choice is written out; the others (whole
    // branches, not single fields) are commented as `or`.
    const alternatives = new Set<ElementField>()
    const markAlternatives = (particle: Particle): void => {
      if (particle.kind === "element") return
      particle.children.forEach((child, position) => {
        if (particle.kind === "choice" && position > 0) {
          for (const field of particleFields(child)) alternatives.add(field)
        }
        markAlternatives(child)
      })
    }
    markAlternatives(contentModel(type))
    for (const field of type.fields) {
      const alternative = alternatives.has(field)
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
      const header = lines.length - 1
      if (repeated) {
        emit(depth + 2, `${hash}-`)
        complexBody(type, depth + 4, level + 1, commented)
      } else {
        complexBody(type, depth + 2, level + 1, commented)
      }
      // A required element whose children are all optional is written as
      // an explicit empty map, never as a key with only comments (null).
      if (
        !commented &&
        lines
          .slice(header + 1)
          .every((line) => line.trimStart().startsWith("#") || line.trim() === "-")
      ) {
        if (repeated) {
          const dash = lines.findIndex((line, index) => index > header && line.trim() === "-")
          if (dash >= 0) lines[dash] = `${" ".repeat(depth + 2)}- {}`
        } else {
          lines[header] = (lines[header] ?? "").replace(/^(\s*[^:]+):/, "$1: {}")
        }
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
// Content models over value maps

const join = (path: string, segment: string): string =>
  path === "" ? segment : `${path}.${segment}`

const unbounded = (occurs: number | "unbounded"): number =>
  occurs === "unbounded" ? Infinity : occurs

/** How many elements a value map holds for a field. */
const countIn = (value: YamlMap, name: string): number => {
  const item = value[name]
  return item === undefined ? 0 : isYamlList(item) ? item.length : 1
}

const labelOf = (particle: Particle, nested = false): string => {
  if (particle.kind === "element") return particle.field.name
  const parts = particle.children.map((child) => labelOf(child, true))
  if (particle.kind !== "choice") return parts.join(" + ")
  return nested ? `(${parts.join(" | ")})` : parts.join(" | ")
}

/**
 * Whether the element counts of a value map can come from `particle`
 * occurring `times` times. A value map keeps no order, so this is the
 * question XSD asks of it: a repeating sequence needs balanced counts, a
 * repeating choice any mix of its alternatives. A term is tried up to as
 * many repetitions as there are elements (a minimal repetition is never
 * empty; beyond it an emptiable term stays satisfiable).
 */
const fitsCounts = (value: YamlMap, particle: Particle, times: number): boolean => {
  const memo = new Map<Particle, Map<number, boolean>>()
  const sizes = new Map<Particle, number>()
  const sizeOf = (node: Particle): number => {
    const known = sizes.get(node)
    if (known !== undefined) return known
    const size = particleFields(node).reduce((sum, field) => sum + countIn(value, field.name), 0)
    sizes.set(node, size)
    return size
  }
  const term = (node: Particle, repetitions: number): boolean => {
    if (node.kind === "element") return countIn(value, node.field.name) === repetitions
    if (node.kind !== "choice") return node.children.every((child) => occurs(child, repetitions))
    // Split the repetitions among the alternatives.
    let reachable = new Set([0])
    for (const child of node.children) {
      const next = new Set<number>()
      for (const done of reachable) {
        for (let share = 0; done + share <= repetitions; share++) {
          if (occurs(child, share)) next.add(done + share)
        }
      }
      reachable = next
    }
    return reachable.has(repetitions)
  }
  const occurs = (node: Particle, count: number): boolean => {
    const cached = memo.get(node)?.get(count)
    if (cached !== undefined) return cached
    const from = count * node.min
    const to = count === 0 ? 0 : Math.min(count * unbounded(node.max), Math.max(from, sizeOf(node)))
    let result = false
    for (let repetitions = from; repetitions <= to && !result; repetitions++) {
      result = term(node, repetitions)
    }
    memo.set(node, (memo.get(node) ?? new Map<number, boolean>()).set(count, result))
    return result
  }
  return occurs(particle, times)
}

/**
 * Check a value map against a complex type's content model: required
 * fields and choices, all-or-nothing optional groups, balanced repeating
 * groups, and each field's number of occurrences. Values are not descended.
 */
const checkContent = (type: ComplexTypeDef, value: YamlMap, path: string): Array<Issue> => {
  const issues: Array<Issue> = []
  const where = path === "" ? "(root)" : path
  const present = (particle: Particle) =>
    particleFields(particle).some((field) => countIn(value, field.name) > 0)
  const counts = (particle: Particle) =>
    [...new Set(particleFields(particle).map((field) => field.name))]
      .map((name) => `${name} ${countIn(value, name)}`)
      .join(", ")
  // `repeating`: inside a group that repeats, where different occurrences
  // may take different alternatives of a choice.
  const walk = (particle: Particle, repeating: boolean): void => {
    if (particle.kind === "element") {
      const field = particle.field
      const count = countIn(value, field.name)
      if (count === 0 && particle.min > 0) {
        issues.push({ path: join(path, field.name), detail: "required field is missing" })
      } else if (
        !repeating &&
        count > 0 &&
        count < particle.min &&
        field.minOccurs < particle.min
      ) {
        issues.push({
          path: join(path, field.name),
          detail: `at least ${particle.min} occurrences`
        })
      }
      return
    }
    const here = present(particle)
    if (!here && (particle.min === 0 || emptiable(particle))) return
    if (!here && particle.kind === "choice") {
      issues.push({
        path: where,
        detail: `one of ${particle.children.map((child) => labelOf(child, true)).join(", ")} is required`
      })
      return
    }
    const repeats = unbounded(particle.max) > 1
    const before = issues.length
    if (particle.kind === "choice" && !(repeating || repeats)) {
      const taken = particle.children.filter(present)
      if (taken.length > 1) {
        issues.push({
          path: where,
          detail: `choose one of ${taken.map((child) => labelOf(child, true)).join(", ")}`
        })
        return
      }
      for (const child of taken) walk(child, false)
    } else if (particle.kind === "choice") {
      for (const child of particle.children.filter(present)) walk(child, true)
    } else {
      for (const child of particle.children) walk(child, repeating || repeats)
    }
    if (repeats && here && issues.length === before && !fitsCounts(value, particle, 1)) {
      issues.push({
        path: where,
        detail: `${labelOf(particle)} repeat${particle.kind === "choice" ? "s" : " together"} as a group; counts ${counts(particle)} do not fit`
      })
    }
  }
  walk(contentModel(type), false)
  for (const field of type.fields) {
    const item = value[field.name]
    if (item === undefined) continue
    const fieldPath = join(path, field.name)
    const count = isYamlList(item) ? item.length : 1
    const repeated = field.maxOccurs === "unbounded" || field.maxOccurs > 1
    if (isYamlList(item) && !repeated) {
      issues.push({ path: fieldPath, detail: "occurs at most once; write a single value" })
    }
    if (count < field.minOccurs)
      issues.push({ path: fieldPath, detail: `at least ${field.minOccurs} occurrences` })
    if (field.maxOccurs !== "unbounded" && count > field.maxOccurs) {
      issues.push({ path: fieldPath, detail: `at most ${field.maxOccurs} occurrences` })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Validation of values

const validateComplex = (
  catalog: WsdlCatalog,
  type: ComplexTypeDef,
  value: YamlMap,
  path: string,
  issues: Array<Issue>,
  fixed: string | undefined
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
    const attributePath = join(path, `@${attribute.name}`)
    if (item === undefined || item === null) {
      if (attribute.required)
        issues.push({ path: attributePath, detail: "required attribute is missing" })
    } else if (typeof item !== "string") {
      issues.push({ path: attributePath, detail: "an attribute holds a single value" })
    } else {
      const problems = [
        ...checkSimple(catalog, attribute.type, item),
        ...(attribute.fixed === undefined
          ? []
          : checkFixed(catalog, attribute.type, item, attribute.fixed, false))
      ]
      for (const problem of problems) issues.push({ path: attributePath, detail: problem })
    }
  }
  if (type.textType !== undefined) {
    const text = value["#text"]
    if (typeof text === "string") {
      const problems = [
        ...checkSimple(catalog, type.textType, text),
        ...(fixed === undefined ? [] : checkFixed(catalog, type.textType, text, fixed, true))
      ]
      for (const problem of problems) issues.push({ path: join(path, "#text"), detail: problem })
    }
  }
  issues.push(...checkContent(type, value, path))
  for (const field of type.fields) {
    const item = value[field.name]
    if (item === undefined) continue
    const fieldPath = join(path, field.name)
    const items = isYamlList(item) ? item : [item]
    items.forEach((entry, position) => {
      validateValue(
        catalog,
        field.type,
        field.nillable,
        entry,
        isYamlList(item) ? `${fieldPath}[${position}]` : fieldPath,
        issues,
        field.fixed
      )
    })
  }
}

const validateValue = (
  catalog: WsdlCatalog,
  typeName: QName,
  nillable: boolean,
  value: YamlValue,
  path: string,
  issues: Array<Issue>,
  fixed: string | undefined
): void => {
  if (value === null) {
    if (!nillable)
      issues.push({ path, detail: "is not nillable; give a value or remove the field" })
    return
  }
  const type = typeByName(catalog, typeName)
  if (type instanceof ComplexTypeDef) {
    if (typeof value === "string" && type.textType !== undefined) {
      validateComplex(catalog, type, { "#text": value }, path, issues, fixed)
    } else if (!isYamlMap(value)) {
      issues.push({ path, detail: `expects fields of ${localName(type.name).replace(/^~/, "")}` })
    } else {
      validateComplex(catalog, type, value, path, issues, fixed)
    }
    return
  }
  // A simple value may also be written as `"#text": value` (a simple-typed root).
  let text: YamlValue = value
  if (isYamlMap(value) && typeof value["#text"] === "string") {
    for (const key of Object.keys(value)) {
      if (key !== "#text")
        issues.push({ path: join(path, key), detail: "not a field of a simple value" })
    }
    text = value["#text"]
  }
  if (typeof text !== "string") {
    issues.push({ path, detail: "expects a single value" })
    return
  }
  const problems = [
    ...checkSimple(catalog, typeName, text),
    ...(fixed === undefined ? [] : checkFixed(catalog, typeName, text, fixed, true))
  ]
  for (const problem of problems) issues.push({ path, detail: problem })
}

/** Validate a value tree against a global element's type. */
export const validateInstance = (
  catalog: WsdlCatalog,
  element: ElementDecl,
  value: YamlValue
): ReadonlyArray<Issue> => {
  const issues: Array<Issue> = []
  validateValue(catalog, element.type, element.nillable, value, "", issues, element.fixed)
  return issues.map((issue) => (issue.path === "" ? { ...issue, path: "(root)" } : issue))
}

// ---------------------------------------------------------------------------
// Value → XML

/**
 * The children of a value map in wire order: the content model is walked
 * and each occurrence takes the next entries, so a repeating sequence is
 * written as interleaved groups and a repeating choice as its alternatives.
 * Entries the model leaves over (an invalid value) follow in field order.
 */
const wireOrder = (
  type: ComplexTypeDef,
  value: YamlMap
): ReadonlyArray<{ readonly field: ElementField; readonly entry: YamlValue }> => {
  const queues = new Map<string, Array<YamlValue>>()
  for (const field of type.fields) {
    const item = value[field.name]
    if (item !== undefined && !queues.has(field.name)) {
      queues.set(field.name, isYamlList(item) ? [...item] : [item])
    }
  }
  const out: Array<{ readonly field: ElementField; readonly entry: YamlValue }> = []
  const remaining = (particle: Particle) =>
    particleFields(particle).some((field) => (queues.get(field.name)?.length ?? 0) > 0)
  const take = (field: ElementField): void => {
    const queue = queues.get(field.name)
    if (queue !== undefined && queue.length > 0) out.push({ field, entry: queue.shift() ?? null })
  }
  const occurrence = (particle: Particle): void => {
    const limit = unbounded(particle.max)
    for (let count = 0; count < limit && remaining(particle); count++) {
      if (particle.kind === "element") take(particle.field)
      else if (particle.kind === "choice") {
        const branch = particle.children.find(remaining)
        if (branch !== undefined) occurrence(branch)
      } else particle.children.forEach(occurrence)
    }
  }
  occurrence(contentModel(type))
  for (const field of type.fields) {
    const queue = queues.get(field.name) ?? []
    while (queue.length > 0) take(field)
  }
  return out
}

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
      const text =
        typeof item === "string"
          ? item
          : isYamlMap(item) && typeof item["#text"] === "string"
            ? item["#text"]
            : ""
      return `<${name}>${escapeText(text)}</${name}>`
    }
    const map: YamlMap = typeof item === "string" ? { "#text": item } : isYamlMap(item) ? item : {}
    const attributes = type.attributes
      .flatMap((attribute) => {
        const attributeValue = map[`@${attribute.name}`]
        return typeof attributeValue === "string"
          ? [
              ` ${qualified(attribute.namespace ?? "", attribute.name)}="${escapeAttribute(attributeValue)}"`
            ]
          : []
      })
      .join("")
    const text = typeof map["#text"] === "string" ? escapeText(map["#text"]) : ""
    const children = wireOrder(type, map)
      .map(({ field, entry }) => write(qualified(field.namespace, field.name), field.type, entry))
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

/** Whether a sequence of child names can be read in order by the content model. */
const followsModel = (model: Particle, names: ReadonlyArray<string>): boolean => {
  // Every position reachable after one occurrence of a particle from `from`.
  const ends = (particle: Particle, from: number): ReadonlySet<number> => {
    const result = new Set<number>()
    if (particle.min === 0) result.add(from)
    const seen = new Set<number>()
    let frontier: ReadonlySet<number> = new Set([from])
    const limit = unbounded(particle.max)
    for (let count = 1; count <= limit && frontier.size > 0; count++) {
      const next = new Set<number>()
      for (const position of frontier) for (const end of termEnds(particle, position)) next.add(end)
      if (count < particle.min) {
        frontier = next
        continue
      }
      for (const end of next) result.add(end)
      frontier = new Set([...next].filter((end) => !seen.has(end)))
      for (const end of next) seen.add(end)
    }
    return result
  }
  const termEnds = (particle: Particle, from: number): ReadonlySet<number> => {
    if (particle.kind === "element") {
      return names[from] === particle.field.name ? new Set([from + 1]) : new Set()
    }
    if (particle.kind === "choice") {
      return new Set(particle.children.flatMap((child) => [...ends(child, from)]))
    }
    if (particle.kind === "sequence") {
      let positions: ReadonlySet<number> = new Set([from])
      for (const child of particle.children) {
        positions = new Set([...positions].flatMap((position) => [...ends(child, position)]))
      }
      return positions
    }
    // xs:all: every child at most once, in any order.
    const result = new Set<number>()
    const visited = new Set<string>()
    const explore = (position: number, used: ReadonlySet<number>): void => {
      const key = `${position}:${[...used].join(",")}`
      if (visited.has(key)) return
      visited.add(key)
      const complete = particle.children.every(
        (child, index) => used.has(index) || emptiable(child)
      )
      if (complete) result.add(position)
      particle.children.forEach((child, index) => {
        if (used.has(index)) return
        for (const end of ends(child, position)) {
          if (end !== position) explore(end, new Set([...used, index]))
        }
      })
    }
    explore(from, new Set())
    return result
  }
  return ends(model, 0).has(names.length)
}

/**
 * Read an XML element as an instance of `element`'s type. Unknown children,
 * wrong namespaces, repeated singletons, and children out of the schema's
 * order become issues; values are kept as found so a response can be
 * analysed even when it breaks its schema.
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
        (attribute.value === "true" || attribute.value === "1")
    )
  const noChildren = (node: XmlElement, path: string): void => {
    const children = elements(node)
    if (children.length > 0) {
      issues.push({
        path: path === "" ? "(root)" : path,
        detail: `unexpected child element ${children.map((child) => child.name.local).join(", ")} in a simple value`
      })
    }
  }

  const read = (node: XmlElement, typeName: QName, path: string): YamlValue => {
    if (nil(node)) return null
    const type = typeByName(catalog, typeName)
    if (!(type instanceof ComplexTypeDef)) {
      noChildren(node, path)
      return textOf(node)
    }
    const result: Record<string, YamlValue> = {}
    for (const attribute of node.attributes) {
      if (attribute.name.namespace === XsiNamespace) continue
      const attributePath = join(path, `@${attribute.name.local}`)
      const declared = type.attributes.find((candidate) => candidate.name === attribute.name.local)
      if (declared === undefined) {
        issues.push({ path: attributePath, detail: "attribute not declared" })
      } else if ((declared.namespace ?? "") !== attribute.name.namespace) {
        issues.push({
          path: attributePath,
          detail: `namespace ${attribute.name.namespace === "" ? "(none)" : attribute.name.namespace}, expected ${declared.namespace ?? "(none)"}`
        })
      }
      result[`@${attribute.name.local}`] = attribute.value
    }
    if (type.textType !== undefined) {
      noChildren(node, path)
      result["#text"] = textOf(node)
    } else if (textOf(node).trim() !== "")
      issues.push({ path: path === "" ? "(root)" : path, detail: "unexpected text content" })
    const order: Array<string> = []
    for (const child of type.textType === undefined ? elements(node) : []) {
      const field = type.fields.find((candidate) => candidate.name === child.name.local)
      const childPath = join(path, child.name.local)
      if (field === undefined) {
        // Kept as text; validation reports it as not a field of the type.
        result[child.name.local] = textOf(child)
        continue
      }
      order.push(field.name)
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
    // Order only matters once the counts fit: otherwise validation says why.
    const model = contentModel(type)
    if (!followsModel(model, order) && checkContent(type, result, path).length === 0) {
      issues.push({
        path: path === "" ? "(root)" : path,
        detail: `children ${order.join(", ")} are out of the schema's order ${[...new Set(particleFields(model).map((field) => field.name))].join(", ")}`
      })
    }
    return result
  }

  const value = read(xml, element.type, "")
  return { value, issues: [...issues, ...validateInstance(catalog, element, value)] }
}
