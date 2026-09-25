import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// A strict reader for the narrow XML profile SOAP estates use: WSDL, XSD,
// SOAP envelopes, and SoapUI project files. It is deliberately not a general
// XML parser. Document type declarations are refused outright, so external
// entities (XXE) and entity expansion attacks are impossible by construction;
// only the five predefined entities and numeric character references are
// understood. Namespaces are resolved while parsing, and every element keeps
// its in-scope bindings so QName-valued attributes (`type="tns:Conto"`) can be
// resolved later.

export const XmlNamespace = "http://www.w3.org/XML/1998/namespace"
const XmlnsNamespace = "http://www.w3.org/2000/xmlns/"

export class XmlError extends Schema.TaggedError<XmlError>()("XmlError", {
  reason: Schema.Literals(["doctype", "encoding", "syntax", "namespace", "limit"]),
  detail: Schema.String,
  line: Schema.optionalKey(Schema.Int),
  source: Schema.optionalKey(Schema.String)
}) {
  get message(): string {
    const where = this.source === undefined ? "" : `${this.source}`
    const line = this.line === undefined ? "" : `:${this.line}`
    const prefix = where === "" && line === "" ? "" : `${where}${line}: `
    return `${prefix}${this.reason}: ${this.detail}`
  }
}

export interface XmlName {
  /** Namespace URI, `""` when the name is in no namespace. */
  readonly namespace: string
  readonly local: string
}

export interface XmlAttribute {
  readonly name: XmlName
  /** The prefix as written, `""` when unprefixed. */
  readonly prefix: string
  readonly value: string
}

export interface XmlText {
  readonly _tag: "text"
  readonly value: string
}

export interface XmlElement {
  readonly _tag: "element"
  readonly name: XmlName
  /** The prefix as written, `""` when unprefixed. */
  readonly prefix: string
  readonly attributes: ReadonlyArray<XmlAttribute>
  readonly children: ReadonlyArray<XmlNode>
  /** Prefix → namespace bindings in scope at this element (`""` = default). */
  readonly scope: ReadonlyMap<string, string>
  readonly line: number
}

export type XmlNode = XmlElement | XmlText

export interface XmlLimits {
  readonly maxDepth: number
  readonly maxChars: number
}

export const defaultXmlLimits: XmlLimits = { maxDepth: 256, maxChars: 32 * 1024 * 1024 }

// ---------------------------------------------------------------------------
// Decoding

const encodingDeclaration = /^<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/

const supportedEncodings: ReadonlyMap<string, string> = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["us-ascii", "utf-8"],
  ["ascii", "utf-8"],
  ["iso-8859-1", "latin1"],
  ["latin1", "latin1"],
  ["latin-1", "latin1"],
  ["iso-8859-15", "iso-8859-15"],
  ["windows-1252", "windows-1252"],
  ["cp1252", "windows-1252"],
  ["utf-16", "utf-16le"],
  ["utf-16le", "utf-16le"],
  ["utf-16be", "utf-16be"]
])

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean =>
  prefix.every((value, index) => bytes[index] === value)

/**
 * Decode raw document bytes by BOM, then by the XML declaration's
 * `encoding`, defaulting to UTF-8. Undecodable input is an `XmlError`, never
 * replacement characters.
 */
export const decodeXml = (bytes: Uint8Array, source?: string): Effect.Effect<string, XmlError> =>
  Effect.suspend(() => {
    const at = source === undefined ? {} : { source }
    let label = "utf-8"
    let offset = 0
    if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
      offset = 3
    } else if (startsWith(bytes, [0xff, 0xfe])) {
      label = "utf-16le"
      offset = 2
    } else if (startsWith(bytes, [0xfe, 0xff])) {
      label = "utf-16be"
      offset = 2
    } else {
      const head = String.fromCharCode(...bytes.subarray(0, 200))
      const declared = encodingDeclaration.exec(head)?.[1]?.toLowerCase()
      if (declared !== undefined) {
        const mapped = supportedEncodings.get(declared)
        if (mapped === undefined) {
          return Effect.fail(
            new XmlError({ reason: "encoding", detail: `unsupported encoding ${declared}`, ...at })
          )
        }
        label = mapped
      }
    }
    return Effect.try({
      try: () => new TextDecoder(label, { fatal: true }).decode(bytes.subarray(offset)),
      catch: () =>
        new XmlError({ reason: "encoding", detail: `bytes are not valid ${label}`, ...at })
    })
  })

// ---------------------------------------------------------------------------
// Parsing

const namePattern = /[A-Za-z_À-￿][A-Za-z0-9._\-·À-￿]*(?::[A-Za-z_À-￿][A-Za-z0-9._\-·À-￿]*)?/y

const predefinedEntities: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'"
}

interface RawAttribute {
  readonly qname: string
  readonly value: string
}

const splitQName = (qname: string): { readonly prefix: string; readonly local: string } => {
  const colon = qname.indexOf(":")
  return colon < 0
    ? { prefix: "", local: qname }
    : { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) }
}

class Parser {
  private position = 0

  constructor(
    private readonly text: string,
    private readonly limits: XmlLimits,
    private readonly source: string | undefined
  ) {}

  fail(reason: XmlError["reason"], detail: string, at: number = this.position): never {
    throw new XmlError({
      reason,
      detail,
      line: this.lineAt(Math.min(at, this.text.length)),
      ...(this.source === undefined ? {} : { source: this.source })
    })
  }

  lineAt(at: number): number {
    let line = 1
    for (let index = 0; index < at; index++) {
      if (this.text.charCodeAt(index) === 10) line++
    }
    return line
  }

  parseDocument(): XmlElement {
    if (this.text.length > this.limits.maxChars) {
      this.fail("limit", `document exceeds ${this.limits.maxChars} characters`, 0)
    }
    this.skipMisc()
    if (!this.text.startsWith("<", this.position) || this.position >= this.text.length) {
      this.fail("syntax", "expected a root element")
    }
    const root = this.parseElement(
      new Map([
        ["xml", XmlNamespace],
        ["", ""]
      ]),
      1
    )
    this.skipMisc()
    if (this.position < this.text.length) {
      this.fail("syntax", "content after the root element")
    }
    return root
  }

  /** Whitespace, comments, and processing instructions (including the XML declaration). */
  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace()
      if (this.text.startsWith("<?", this.position)) {
        this.skipProcessingInstruction()
      } else if (this.text.startsWith("<!--", this.position)) {
        this.skipComment()
      } else if (this.text.startsWith("<!", this.position)) {
        this.rejectDeclaration()
      } else {
        return
      }
    }
  }

  private rejectDeclaration(): never {
    if (this.text.startsWith("<!DOCTYPE", this.position)) {
      this.fail("doctype", "document type declarations are not accepted")
    }
    return this.fail("syntax", "unexpected markup declaration")
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length && /\s/.test(this.text[this.position] ?? "")) {
      this.position++
    }
  }

  private skipProcessingInstruction(): void {
    const end = this.text.indexOf("?>", this.position + 2)
    if (end < 0) this.fail("syntax", "unterminated processing instruction")
    this.position = end + 2
  }

  private skipComment(): void {
    const end = this.text.indexOf("-->", this.position + 4)
    if (end < 0) this.fail("syntax", "unterminated comment")
    this.position = end + 3
  }

  private readName(): string {
    namePattern.lastIndex = this.position
    const match = namePattern.exec(this.text)
    if (match === null) this.fail("syntax", "expected a name")
    this.position += match[0].length
    return match[0]
  }

  private decodeText(raw: string, start: number): string {
    if (!raw.includes("&")) return raw
    return raw.replace(/&([^;&\s]*);?/g, (whole, body: string) => {
      if (!whole.endsWith(";")) this.fail("syntax", `unterminated reference &${body}`, start)
      if (body.startsWith("#x")) {
        const code = Number.parseInt(body.slice(2), 16)
        return this.codePoint(code, whole, start)
      }
      if (body.startsWith("#")) {
        const code = Number.parseInt(body.slice(1), 10)
        return this.codePoint(code, whole, start)
      }
      const value = predefinedEntities[body]
      if (value === undefined) this.fail("syntax", `undeclared entity ${whole}`, start)
      return value
    })
  }

  private codePoint(code: number, whole: string, start: number): string {
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
      this.fail("syntax", `invalid character reference ${whole}`, start)
    }
    return String.fromCodePoint(code)
  }

  private readAttributes(): ReadonlyArray<RawAttribute> {
    const attributes: Array<RawAttribute> = []
    for (;;) {
      const before = this.position
      this.skipWhitespace()
      const next = this.text[this.position]
      if (next === ">" || next === "/" || next === undefined) return attributes
      if (this.position === before) this.fail("syntax", "expected whitespace before attribute")
      const qname = this.readName()
      this.skipWhitespace()
      if (this.text[this.position] !== "=") this.fail("syntax", `expected = after ${qname}`)
      this.position++
      this.skipWhitespace()
      const quote = this.text[this.position]
      if (quote !== '"' && quote !== "'") this.fail("syntax", `expected quoted value for ${qname}`)
      const end = this.text.indexOf(quote, this.position + 1)
      if (end < 0) this.fail("syntax", `unterminated value for ${qname}`)
      const raw = this.text.slice(this.position + 1, end)
      if (raw.includes("<")) this.fail("syntax", `'<' in value of ${qname}`)
      const value = this.decodeText(raw, this.position)
      this.position = end + 1
      if (attributes.some((attribute) => attribute.qname === qname)) {
        this.fail("syntax", `duplicate attribute ${qname}`)
      }
      attributes.push({ qname, value })
    }
  }

  private parseElement(parentScope: ReadonlyMap<string, string>, depth: number): XmlElement {
    if (depth > this.limits.maxDepth) {
      this.fail("limit", `nesting exceeds ${this.limits.maxDepth} levels`)
    }
    const start = this.position
    this.position++ // "<"
    const qname = this.readName()
    const raw = this.readAttributes()

    const declarations = raw.filter(
      (attribute) => attribute.qname === "xmlns" || attribute.qname.startsWith("xmlns:")
    )
    let scope = parentScope
    if (declarations.length > 0) {
      const extended = new Map(parentScope)
      for (const attribute of declarations) {
        const prefix = attribute.qname === "xmlns" ? "" : attribute.qname.slice(6)
        if (prefix !== "" && attribute.value === "") {
          this.fail("namespace", `prefix ${prefix} cannot be unbound`, start)
        }
        extended.set(prefix, attribute.value)
      }
      scope = extended
    }

    const resolve = (name: string, isAttribute: boolean): { name: XmlName; prefix: string } => {
      const { prefix, local } = splitQName(name)
      if (prefix === "") {
        return { name: { namespace: isAttribute ? "" : (scope.get("") ?? ""), local }, prefix }
      }
      if (prefix === "xmlns") return { name: { namespace: XmlnsNamespace, local }, prefix }
      const namespace = scope.get(prefix)
      if (namespace === undefined) this.fail("namespace", `unbound prefix ${prefix}`, start)
      return { name: { namespace, local }, prefix }
    }

    const element = resolve(qname, false)
    const attributes = raw
      .filter((attribute) => !declarations.includes(attribute))
      .map((attribute) => {
        const resolved = resolve(attribute.qname, true)
        return { name: resolved.name, prefix: resolved.prefix, value: attribute.value }
      })
    const line = this.lineAt(start)

    if (this.text.startsWith("/>", this.position)) {
      this.position += 2
      return {
        _tag: "element",
        name: element.name,
        prefix: element.prefix,
        attributes,
        children: [],
        scope,
        line
      }
    }
    if (this.text[this.position] !== ">") this.fail("syntax", `malformed start tag <${qname}>`)
    this.position++

    const children: Array<XmlNode> = []
    let text = ""
    const flush = (): void => {
      if (text !== "") {
        children.push({ _tag: "text", value: text })
        text = ""
      }
    }
    for (;;) {
      if (this.position >= this.text.length) this.fail("syntax", `unclosed element <${qname}>`)
      const next = this.text.indexOf("<", this.position)
      if (next < 0) this.fail("syntax", `unclosed element <${qname}>`)
      if (next > this.position) {
        const chunk = this.text.slice(this.position, next)
        text += this.decodeText(chunk, this.position)
        this.position = next
      }
      if (this.text.startsWith("</", this.position)) {
        this.position += 2
        const closing = this.readName()
        this.skipWhitespace()
        if (this.text[this.position] !== ">") this.fail("syntax", `malformed end tag </${closing}>`)
        this.position++
        if (closing !== qname) {
          this.fail("syntax", `</${closing}> does not close <${qname}>`)
        }
        flush()
        return {
          _tag: "element",
          name: element.name,
          prefix: element.prefix,
          attributes,
          children,
          scope,
          line
        }
      }
      if (this.text.startsWith("<![CDATA[", this.position)) {
        const end = this.text.indexOf("]]>", this.position + 9)
        if (end < 0) this.fail("syntax", "unterminated CDATA section")
        text += this.text.slice(this.position + 9, end)
        this.position = end + 3
      } else if (this.text.startsWith("<!--", this.position)) {
        this.skipComment()
      } else if (this.text.startsWith("<?", this.position)) {
        this.skipProcessingInstruction()
      } else if (this.text.startsWith("<!", this.position)) {
        this.rejectDeclaration()
      } else {
        flush()
        children.push(this.parseElement(scope, depth + 1))
      }
    }
  }
}

/** Parse an already-decoded document into its root element. */
export const parseXml = (
  text: string,
  options: { readonly source?: string; readonly limits?: XmlLimits } = {}
): Effect.Effect<XmlElement, XmlError> =>
  Effect.try({
    try: () => new Parser(text, options.limits ?? defaultXmlLimits, options.source).parseDocument(),
    catch: (cause) =>
      cause instanceof XmlError
        ? cause
        : new XmlError({
            reason: "syntax",
            detail: "unreadable document",
            ...(options.source === undefined ? {} : { source: options.source })
          })
  })

/** Decode bytes by their declared encoding, then parse. */
export const parseXmlBytes = (
  bytes: Uint8Array,
  options: { readonly source?: string; readonly limits?: XmlLimits } = {}
): Effect.Effect<XmlElement, XmlError> =>
  Effect.flatMap(decodeXml(bytes, options.source), (text) => parseXml(text, options))

// ---------------------------------------------------------------------------
// Navigation helpers

export const isElement = (node: XmlNode): node is XmlElement => node._tag === "element"

export const elements = (element: XmlElement): ReadonlyArray<XmlElement> =>
  element.children.filter(isElement)

export const is = (element: XmlElement, namespace: string, local: string): boolean =>
  element.name.namespace === namespace && element.name.local === local

export const childrenNamed = (
  element: XmlElement,
  namespace: string,
  local: string
): ReadonlyArray<XmlElement> => elements(element).filter((child) => is(child, namespace, local))

export const firstChild = (
  element: XmlElement,
  namespace: string,
  local: string
): XmlElement | undefined => elements(element).find((child) => is(child, namespace, local))

/** An unqualified attribute's value (the usual case in WSDL and XSD). */
export const attribute = (element: XmlElement, local: string, namespace = ""): string | undefined =>
  element.attributes.find(
    (candidate) => candidate.name.local === local && candidate.name.namespace === namespace
  )?.value

/** Concatenated text content of the element's direct text children. */
export const textOf = (element: XmlElement): string =>
  element.children
    .filter((child): child is XmlText => child._tag === "text")
    .map((child) => child.value)
    .join("")

/**
 * Resolve a QName-valued attribute (`tns:Conto`) against the element's
 * in-scope bindings; an unprefixed value takes the default namespace, as
 * XSD's `type`/`ref`/`base` do.
 */
export const resolveQName = (element: XmlElement, value: string): XmlName | undefined => {
  const { prefix, local } = splitQName(value.trim())
  const namespace = element.scope.get(prefix)
  return namespace === undefined ? undefined : { namespace, local }
}

// ---------------------------------------------------------------------------
// Writing

export const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, "&quot;")
