import { createHmac } from "node:crypto"
import * as Schema from "effect/Schema"
import { ComplexTypeDef, localName, type WsdlCatalog } from "./Catalog.ts"
import type { XmlAttribute, XmlElement, XmlNode } from "./Xml.ts"

// Always-on masking of SOAP samples before they are persisted or shown to a
// model. Two signals decide what is personal data: the field (its element
// name, or its XSD type in the catalog) and the value itself (checksummed
// identifiers found anywhere in text). Every replacement is a keyed,
// deterministic, format-preserving pseudonym: the same input maps to the same
// output under one service key, so "the account in the request is the
// account echoed in the response" survives masking, and a masked IBAN, codice
// fiscale, partita IVA, or PAN still passes its checksum. There is no switch
// to turn this off.

export const MaskKind = Schema.Literals([
  "iban",
  "codice-fiscale",
  "partita-iva",
  "pan",
  "email",
  "phone",
  "personal-text",
  "birth-date",
  "secret"
])
export type MaskKind = typeof MaskKind.Type

export const MaskOverride = Schema.Literals(["mask", "keep"])
export type MaskOverride = typeof MaskOverride.Type

/** `masking.json`: per-field overrides keyed by element local name. */
export class MaskingOverrides extends Schema.Class<MaskingOverrides>("MaskingOverrides")({
  fields: Schema.Record(Schema.String, MaskOverride)
}) {}

export const MaskSource = Schema.Literals(["field-name", "field-type", "value", "override"])
export type MaskSource = typeof MaskSource.Type

export class MaskEntry extends Schema.Class<MaskEntry>("MaskEntry")({
  /** Element path from the document root, local names joined by `/`. */
  path: Schema.String,
  kind: MaskKind,
  source: MaskSource,
  count: Schema.Int
}) {}

export class MaskingReport extends Schema.Class<MaskingReport>("MaskingReport")({
  entries: Schema.Array(MaskEntry),
  /** Fields a `keep` override left untouched even though a rule matched. */
  kept: Schema.Array(Schema.String)
}) {}

// ---------------------------------------------------------------------------
// Checksums

const digitsOnly = /^\d+$/

/** Italian CIN / codice fiscale tables: value of a character at an odd (1-based) position. */
const oddValues: Readonly<Record<string, number>> = (() => {
  const table = [
    1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23
  ]
  const values: Record<string, number> = {}
  for (let index = 0; index < 10; index++) values[String(index)] = table[index] ?? 0
  for (let index = 0; index < 26; index++) {
    values[String.fromCharCode(65 + index)] = table[index] ?? 0
  }
  return values
})()

const evenValue = (char: string): number =>
  /\d/.test(char) ? Number(char) : char.charCodeAt(0) - 65

/** Check letter over `chars` using the codice fiscale / CIN odd-even tables. */
export const italianCheckLetter = (chars: string): string => {
  let sum = 0
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "0"
    sum += index % 2 === 0 ? (oddValues[char] ?? 0) : evenValue(char)
  }
  return String.fromCharCode(65 + (sum % 26))
}

const ibanRemainder = (iban: string): number => {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`
  let remainder = 0
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55)
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder
}

export const isValidIban = (value: string): boolean =>
  /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value) && ibanRemainder(value) === 1

const withIbanCheckDigits = (country: string, bban: string): string => {
  const check = 98 - ibanRemainder(`${country}00${bban}`)
  return `${country}${String(check).padStart(2, "0")}${bban}`
}

const cfPattern =
  /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/

export const isValidCodiceFiscale = (value: string): boolean =>
  cfPattern.test(value) && italianCheckLetter(value.slice(0, 15)) === value[15]

const luhnSum = (digits: string, doubleFirst: boolean): number => {
  let sum = 0
  let double = doubleFirst
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum
}

export const isValidLuhn = (value: string): boolean =>
  digitsOnly.test(value) && luhnSum(value, false) % 10 === 0

const luhnCheckDigit = (payload: string): string =>
  String((10 - (luhnSum(payload, true) % 10)) % 10)

export const isValidPan = (value: string): boolean =>
  /^[2-6]\d{12,18}$/.test(value) && isValidLuhn(value)

const partitaIvaCheck = (first10: string): string => {
  let sum = 0
  for (let index = 0; index < 10; index++) {
    let digit = Number(first10[index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return String((10 - (sum % 10)) % 10)
}

export const isValidPartitaIva = (value: string): boolean =>
  /^\d{11}$/.test(value) && partitaIvaCheck(value.slice(0, 10)) === value[10]

// ---------------------------------------------------------------------------
// Keyed, deterministic drawing

interface Drawer {
  readonly digit: () => string
  readonly letter: () => string
  readonly int: (bound: number) => number
}

const makeDrawer = (key: Uint8Array, kind: string, value: string): Drawer => {
  let block = 0
  let bytes: Uint8Array = new Uint8Array(0)
  let offset = 0
  const next = (): number => {
    if (offset >= bytes.length) {
      bytes = createHmac("sha256", key).update(`${kind}\u0000${value}\u0000${block}`).digest()
      block++
      offset = 0
    }
    const byte = bytes[offset] ?? 0
    offset++
    return byte
  }
  const int = (bound: number): number => {
    // Rejection sampling over two bytes keeps the draw unbiased.
    const limit = 65536 - (65536 % bound)
    for (;;) {
      const candidate = next() * 256 + next()
      if (candidate < limit) return candidate % bound
    }
  }
  return {
    digit: () => String(int(10)),
    letter: () => String.fromCharCode(65 + int(26)),
    int
  }
}

/** Replace every letter and digit by one of the same class and case; keep the rest. */
const scramble = (draw: Drawer, value: string): string =>
  Array.from(value, (char) => {
    if (/\d/.test(char)) return draw.digit()
    if (/[A-Z]/.test(char)) return draw.letter()
    if (/[a-z]/.test(char)) return draw.letter().toLowerCase()
    if (/\p{Lu}/u.test(char)) return draw.letter()
    if (/\p{Ll}/u.test(char)) return draw.letter().toLowerCase()
    return char
  }).join("")

const omocodia: Readonly<Record<string, string>> = {
  L: "0",
  M: "1",
  N: "2",
  P: "3",
  Q: "4",
  R: "5",
  S: "6",
  T: "7",
  U: "8",
  V: "9"
}

const pseudonyms: Readonly<Record<MaskKind, (draw: Drawer, value: string) => string>> = {
  // Country, ABI and CAB are bank data, not personal: kept, so analysis can
  // still tell banks apart. The account part is replaced class for class and
  // the Italian CIN and the IBAN check digits are recomputed.
  iban: (draw, value) => {
    const country = value.slice(0, 2)
    if (country === "IT" && value.length === 27) {
      const abiCab = value.slice(5, 15)
      const account = scramble(draw, value.slice(15))
      const cin = italianCheckLetter(`${abiCab}${account}`)
      return withIbanCheckDigits("IT", `${cin}${abiCab}${account}`)
    }
    return withIbanCheckDigits(country, scramble(draw, value.slice(4)))
  },
  // New surname/name letters, birth year, month, day (sex kept), and comune;
  // omocodia is normalized away; the check letter is recomputed.
  "codice-fiscale": (draw, value) => {
    const letters = Array.from({ length: 6 }, () => draw.letter()).join("")
    const year = `${draw.digit()}${draw.digit()}`
    const month = "ABCDEHLMPRST"[draw.int(12)] ?? "A"
    const originalDay = Number(
      Array.from(value.slice(9, 11), (char) => omocodia[char] ?? char).join("")
    )
    const day = String(1 + draw.int(28) + (originalDay > 40 ? 40 : 0)).padStart(2, "0")
    const comune = `${draw.letter()}${draw.digit()}${draw.digit()}${draw.digit()}`
    const body = `${letters}${year}${month}${day}${comune}`
    return `${body}${italianCheckLetter(body)}`
  },
  // Matricola replaced, provincial office code kept, check digit recomputed.
  "partita-iva": (draw, value) => {
    const first10 = `${Array.from({ length: 7 }, () => draw.digit()).join("")}${value.slice(7, 10)}`
    return `${first10}${partitaIvaCheck(first10)}`
  },
  // Issuer BIN (first six) kept, account digits replaced, Luhn recomputed.
  pan: (draw, value) => {
    const payload = `${value.slice(0, 6)}${Array.from({ length: value.length - 7 }, () => draw.digit()).join("")}`
    return `${payload}${luhnCheckDigit(payload)}`
  },
  email: (draw, value) => {
    const at = value.lastIndexOf("@")
    return `${scramble(draw, value.slice(0, at))}@example.invalid`
  },
  // International prefix and the first three digits (operator or area) kept.
  phone: (draw, value) => {
    const prefix = /^(\+\d{2}|00\d{2})?\s*\d{0,3}/.exec(value)?.[0] ?? ""
    return `${prefix}${scramble(draw, value.slice(prefix.length))}`
  },
  "personal-text": scramble,
  // Shifted by up to a year either way; format kept.
  "birth-date": (draw, value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(value)
    if (match === null) return scramble(draw, value)
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    date.setUTCDate(date.getUTCDate() + draw.int(731) - 365)
    return `${date.toISOString().slice(0, 10)}${match[4] ?? ""}`
  },
  secret: scramble
}

// A field named for one kind can hold another shape (a company's
// `codiceFiscale` is its 11-digit partita IVA). The structured pseudonym
// only applies when the value has its kind's shape; otherwise the value is
// scrambled class for class, which keeps its length and character classes.
const shapes: Readonly<Partial<Record<MaskKind, RegExp>>> = {
  iban: /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/,
  "codice-fiscale": cfPattern,
  "partita-iva": /^\d{11}$/,
  pan: /^\d{13,19}$/,
  email: /^[^@\s]+@[^@\s]+$/
}

const effectiveKind = (kind: MaskKind, value: string): MaskKind => {
  const shape = shapes[kind]
  if (shape === undefined || shape.test(value)) return kind
  if (kind === "codice-fiscale" && /^\d{11}$/.test(value)) return "partita-iva"
  return "personal-text"
}

/** The pseudonym of one value; stable for a given key. */
export const pseudonymize = (key: Uint8Array, kind: MaskKind, value: string): string => {
  const effective = effectiveKind(kind, value)
  return pseudonyms[effective](makeDrawer(key, effective, value), value)
}

// ---------------------------------------------------------------------------
// Detection

/** camelCase, PascalCase, snake_case and kebab-case words, lower-cased. */
export const nameWords = (name: string): ReadonlyArray<string> =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase())

const wordRules: ReadonlyArray<readonly [MaskKind, ReadonlyArray<string>]> = [
  ["iban", ["iban"]],
  ["codice-fiscale", ["cf", "codicefiscale", "codfisc", "fiscalcode", "taxcode"]],
  ["partita-iva", ["piva", "partitaiva", "vat", "vatnumber"]],
  ["pan", ["pan", "cardnumber"]],
  ["email", ["email", "mail", "pec"]],
  ["phone", ["telefono", "cellulare", "phone", "mobile", "fax", "tel"]],
  ["birth-date", []],
  ["secret", ["otp", "pin", "cvv", "cvc", "password", "pwd", "segreto"]],
  [
    "personal-text",
    [
      "nome",
      "cognome",
      "intestatario",
      "cointestatario",
      "beneficiario",
      "ordinante",
      "titolare",
      "ragione",
      "denominazione",
      "name",
      "surname",
      "firstname",
      "lastname",
      "fullname",
      "holder",
      "indirizzo",
      "via",
      "civico",
      "cap",
      "localita",
      "residenza",
      "address",
      "street",
      "zip",
      "postcode"
    ]
  ]
]

// Multi-word names whose words alone would not match.
const phraseRules: ReadonlyArray<readonly [MaskKind, RegExp]> = [
  ["codice-fiscale", /^codice fiscale$|^cod fisc$/],
  ["partita-iva", /partita iva/],
  ["pan", /numero carta|card number|pan carta/],
  ["birth-date", /data (di )?nascita|birth ?date|date of birth|dob/],
  ["personal-text", /luogo (di )?nascita|ragione sociale|place of birth/],
  ["secret", /codice (otp|pin|segreto)/]
]

/** The kind a field's name implies, if any. */
export const kindForName = (name: string): MaskKind | undefined => {
  const words = nameWords(name)
  const phrase = words.join(" ")
  for (const [kind, pattern] of phraseRules) if (pattern.test(phrase)) return kind
  const joined = words.join("")
  for (const [kind, candidates] of wordRules) {
    if (candidates.includes(joined) || words.some((word) => candidates.includes(word))) return kind
  }
  return undefined
}

/**
 * Field names whose declared XSD type implies a kind (`iban` of type
 * `IbanType`, `cf` of type `CodiceFiscaleType`), from the catalog.
 */
export const kindsFromCatalog = (catalog: WsdlCatalog): ReadonlyMap<string, MaskKind> => {
  const kinds = new Map<string, MaskKind>()
  for (const type of catalog.types) {
    if (!(type instanceof ComplexTypeDef)) continue
    for (const field of type.fields) {
      const kind = kindForName(localName(field.type).replace(/Type$/, ""))
      if (kind !== undefined && !kinds.has(field.name)) kinds.set(field.name, kind)
    }
  }
  return kinds
}

const valueDetectors: ReadonlyArray<{
  readonly kind: MaskKind
  readonly pattern: RegExp
  readonly accept: (match: string) => boolean
}> = [
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, accept: isValidIban },
  {
    kind: "codice-fiscale",
    pattern: /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/g,
    accept: isValidCodiceFiscale
  },
  { kind: "pan", pattern: /\b[2-6]\d{12,18}\b/g, accept: isValidPan },
  {
    kind: "partita-iva",
    pattern: /(?<=\bIT ?)\d{11}\b/g,
    accept: isValidPartitaIva
  },
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    accept: () => true
  },
  {
    kind: "phone",
    pattern: /(?:\+39|0039)[\s-]?\d{2,4}[\s-]?\d{5,8}/g,
    accept: () => true
  }
]

// ---------------------------------------------------------------------------
// Masking a document

export interface MaskOptions {
  readonly key: Uint8Array
  readonly overrides?: MaskingOverrides
  /** Field name → kind from the catalog's XSD types (`kindsFromCatalog`). */
  readonly typeKinds?: ReadonlyMap<string, MaskKind>
}

class Tally {
  readonly counts = new Map<
    string,
    { path: string; kind: MaskKind; source: MaskSource; count: number }
  >()
  readonly kept = new Set<string>()

  add(path: string, kind: MaskKind, source: MaskSource): void {
    const key = `${path}\u0000${kind}\u0000${source}`
    const current = this.counts.get(key)
    if (current === undefined) this.counts.set(key, { path, kind, source, count: 1 })
    else current.count++
  }

  report(): MaskingReport {
    return new MaskingReport({
      entries: [...this.counts.values()]
        .sort(
          (left, right) =>
            left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
        )
        .map((entry) => new MaskEntry(entry)),
      kept: [...this.kept].sort()
    })
  }
}

/** Mask detected identifiers inside free text; returns the text and what was found. */
export const maskText = (
  key: Uint8Array,
  text: string
): { readonly text: string; readonly kinds: ReadonlyArray<MaskKind> } => {
  const kinds: Array<MaskKind> = []
  let result = text
  for (const detector of valueDetectors) {
    result = result.replace(detector.pattern, (match) => {
      if (!detector.accept(match)) return match
      kinds.push(detector.kind)
      return pseudonymize(key, detector.kind, match)
    })
  }
  return { text: result, kinds }
}

interface FieldRule {
  readonly kind: MaskKind | undefined
  readonly source: MaskSource | undefined
  readonly keep: boolean
}

const ruleFor = (name: string, options: MaskOptions): FieldRule => {
  const override = options.overrides?.fields[name]
  const named = kindForName(name)
  const typed = options.typeKinds?.get(name)
  const kind = named ?? typed
  if (override === "keep") return { kind, source: undefined, keep: true }
  if (override === "mask") {
    return { kind: kind ?? "personal-text", source: "override", keep: false }
  }
  return {
    kind,
    source: named !== undefined ? "field-name" : typed !== undefined ? "field-type" : undefined,
    keep: false
  }
}

/**
 * Mask one parsed document (a SOAP envelope, request or response). Returns
 * the masked tree and the report of what was replaced where. Element and
 * attribute names, structure, and namespaces are never changed.
 */
export const maskDocument = (
  root: XmlElement,
  options: MaskOptions
): { readonly document: XmlElement; readonly report: MaskingReport } => {
  const tally = new Tally()

  const maskValue = (value: string, path: string, rule: FieldRule): string => {
    if (rule.keep) {
      if (rule.kind !== undefined || maskText(options.key, value).kinds.length > 0) {
        tally.kept.add(path)
      }
      return value
    }
    if (rule.kind !== undefined && rule.source !== undefined && value.trim() !== "") {
      tally.add(path, rule.kind, rule.source)
      const leading = /^\s*/.exec(value)?.[0] ?? ""
      const trailing = /\s*$/.exec(value)?.[0] ?? ""
      const core = value.trim()
      return `${leading}${pseudonymize(options.key, rule.kind, core)}${trailing}`
    }
    const found = maskText(options.key, value)
    for (const kind of found.kinds) tally.add(path, kind, "value")
    return found.text
  }

  const walk = (element: XmlElement, parentPath: string): XmlElement => {
    const path = parentPath === "" ? element.name.local : `${parentPath}/${element.name.local}`
    const rule = ruleFor(element.name.local, options)
    const attributes = element.attributes.map((attribute): XmlAttribute => {
      const attributePath = `${path}/@${attribute.name.local}`
      return {
        ...attribute,
        value: maskValue(attribute.value, attributePath, ruleFor(attribute.name.local, options))
      }
    })
    const children = element.children.map(
      (child): XmlNode =>
        child._tag === "text"
          ? { _tag: "text", value: maskValue(child.value, path, rule) }
          : walk(child, path)
    )
    return { ...element, attributes, children }
  }

  return { document: walk(root, ""), report: tally.report() }
}

/** Merge per-document reports into one (counts summed per path, kind, source). */
export const mergeReports = (reports: ReadonlyArray<MaskingReport>): MaskingReport => {
  const tally = new Tally()
  for (const report of reports) {
    for (const entry of report.entries) {
      for (let index = 0; index < entry.count; index++)
        tally.add(entry.path, entry.kind, entry.source)
    }
    for (const kept of report.kept) tally.kept.add(kept)
  }
  return tally.report()
}
