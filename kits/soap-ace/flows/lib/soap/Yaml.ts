import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// The YAML subset request files are written in: block mappings, block
// sequences, comments, plain and quoted scalars, and `|`/`>` block scalars.
// Every scalar stays a string — `0012`, `1e3`, `no`, and `2026-01-01` all
// arrive as written, because they are XML text in the end and YAML's type
// guessing would corrupt them. `~`, `null`, and an empty value are null
// (sent as `xsi:nil`). Anchors, tags, and flow collections other than `[]`
// and `{}` are refused rather than half-understood.

export type YamlValue = string | null | ReadonlyArray<YamlValue> | YamlMap
export interface YamlMap {
  readonly [key: string]: YamlValue
}

export class YamlError extends Schema.TaggedError<YamlError>()("YamlError", {
  line: Schema.Int,
  detail: Schema.String
}) {
  get message(): string {
    return `line ${this.line}: ${this.detail}`
  }
}

export const isYamlMap = (value: YamlValue): value is YamlMap =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const isYamlList = (value: YamlValue): value is ReadonlyArray<YamlValue> =>
  Array.isArray(value)

interface Line {
  readonly number: number
  readonly indent: number
  readonly text: string
}

/** Remove a trailing comment that is outside quotes. */
const stripComment = (text: string): string => {
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index++
      else if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      if (index === 0 || /[\s:\-[{,]/.test(text[index - 1] ?? "")) quote = char
    } else if (char === "#" && (index === 0 || /\s/.test(text[index - 1] ?? ""))) {
      return text.slice(0, index).trimEnd()
    }
  }
  return text.trimEnd()
}

class Reader {
  private index = 0
  private readonly lines: ReadonlyArray<Line>
  private readonly raw: ReadonlyArray<string>

  constructor(source: string) {
    this.raw = source.replace(/^\uFEFF/, "").split(/\r?\n/)
    const lines: Array<Line> = []
    for (const [position, rawLine] of this.raw.entries()) {
      if (/^\s*\t/.test(rawLine) && rawLine.trim() !== "") {
        throw new YamlError({ line: position + 1, detail: "tabs are not allowed for indentation" })
      }
      if (rawLine.trim() === "---" || rawLine.trim() === "...") continue
      const text = stripComment(rawLine)
      if (text.trim() === "") continue
      lines.push({
        number: position + 1,
        indent: text.length - text.trimStart().length,
        text: text.trim()
      })
    }
    this.lines = lines
  }

  fail(line: number, detail: string): never {
    throw new YamlError({ line, detail })
  }

  document(): YamlValue {
    const first = this.lines[0]
    if (first === undefined) return null
    const value = this.block(first.indent)
    const rest = this.lines[this.index]
    if (rest !== undefined) this.fail(rest.number, "unexpected content (check indentation)")
    return value
  }

  private block(indent: number): YamlValue {
    const line = this.lines[this.index]
    if (line === undefined) return null
    return line.text === "-" || line.text.startsWith("- ")
      ? this.sequence(indent)
      : this.mapping(indent)
  }

  private sequence(indent: number): ReadonlyArray<YamlValue> {
    const items: Array<YamlValue> = []
    for (;;) {
      const line = this.lines[this.index]
      if (line === undefined || line.indent < indent) return items
      if (line.indent > indent) this.fail(line.number, "unexpected indentation")
      if (!(line.text === "-" || line.text.startsWith("- "))) return items
      const rest = line.text === "-" ? "" : line.text.slice(2).trim()
      this.index++
      if (rest === "") {
        const next = this.lines[this.index]
        items.push(next !== undefined && next.indent > indent ? this.block(next.indent) : null)
      } else if (this.isMappingStart(rest)) {
        // `- key: value` opens a mapping whose further keys sit two columns in.
        const itemIndent = indent + (line.text.length - rest.length)
        items.push(this.mapping(itemIndent, { text: rest, number: line.number }))
      } else {
        items.push(this.scalar(rest, line.number, indent))
      }
    }
  }

  private isMappingStart(text: string): boolean {
    return this.splitKey(text) !== undefined
  }

  private splitKey(text: string): { key: string; rest: string } | undefined {
    if (text.startsWith('"') || text.startsWith("'")) {
      const quote = text[0] ?? '"'
      let end = 1
      while (end < text.length) {
        if (text[end] === "\\" && quote === '"') end += 2
        else if (text[end] === quote && quote === "'" && text[end + 1] === "'") end += 2
        else if (text[end] === quote) break
        else end++
      }
      const after = text.slice(end + 1)
      if (!/^\s*:(\s|$)/.test(after)) return undefined
      return {
        key: this.quoted(text.slice(0, end + 1), 0),
        rest: after.replace(/^\s*:/, "").trim()
      }
    }
    const match = /^([^\s:#][^:#]*?|[^\s:#]):(\s+|$)(.*)$/.exec(text)
    if (match === null) return undefined
    return { key: (match[1] ?? "").trim(), rest: match[3] ?? "" }
  }

  private mapping(indent: number, first?: { text: string; number: number }): YamlMap {
    const entries: Record<string, YamlValue> = {}
    const add = (text: string, number: number, lineIndent: number): void => {
      const split = this.splitKey(text)
      if (split === undefined)
        this.fail(number, `expected "key: value", found ${JSON.stringify(text)}`)
      if (Object.hasOwn(entries, split.key)) this.fail(number, `duplicate key ${split.key}`)
      if (split.rest === "") {
        const next = this.lines[this.index]
        entries[split.key] =
          next !== undefined &&
          (next.indent > lineIndent ||
            (next.indent === lineIndent && (next.text === "-" || next.text.startsWith("- "))))
            ? this.block(next.indent)
            : null
      } else {
        entries[split.key] = this.scalar(split.rest, number, lineIndent)
      }
    }
    if (first !== undefined) add(first.text, first.number, indent)
    for (;;) {
      const line = this.lines[this.index]
      if (line === undefined || line.indent < indent) return entries
      if (line.indent > indent) this.fail(line.number, "unexpected indentation")
      if (line.text === "-" || line.text.startsWith("- ")) return entries
      this.index++
      add(line.text, line.number, indent)
    }
  }

  private scalar(text: string, number: number, indent: number): YamlValue {
    if (text === "~" || text === "null" || text === "Null" || text === "NULL") return null
    if (text === "[]") return []
    if (text === "{}") return {}
    if (text.startsWith('"') || text.startsWith("'")) return this.quoted(text, number)
    if (text === "|" || text === ">" || /^[|>][-+]?$/.test(text))
      return this.blockScalar(text, indent)
    if (/^[[{&*!%@`]/.test(text)) {
      this.fail(number, `unsupported YAML construct at ${JSON.stringify(text.slice(0, 12))}`)
    }
    return text
  }

  private quoted(text: string, number: number): string {
    const quote = text[0]
    if (text.length < 2 || text[text.length - 1] !== quote) {
      this.fail(number, "unterminated quoted scalar")
    }
    const body = text.slice(1, -1)
    if (quote === "'") return body.replace(/''/g, "'")
    return body.replace(/\\(u[0-9A-Fa-f]{4}|.)/g, (_, escape: string) => {
      if (escape.startsWith("u")) return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
      const map: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        '"': '"',
        "\\": "\\",
        "/": "/",
        "0": "\0"
      }
      const value = map[escape]
      if (value === undefined) this.fail(number, `unknown escape \\${escape}`)
      return value
    })
  }

  private blockScalar(header: string, indent: number): string {
    const folded = header.startsWith(">")
    const keep = header.endsWith("+")
    const strip = header.endsWith("-")
    // Block scalar content keeps its comments and blank lines, so it is read
    // from the raw source rather than the comment-stripped lines.
    const startLine = this.lines[this.index]
    if (startLine === undefined || startLine.indent <= indent) return ""
    const contentIndent = startLine.indent
    const collected: Array<string> = []
    let rawIndex = startLine.number - 1
    while (rawIndex < this.raw.length) {
      const raw = this.raw[rawIndex] ?? ""
      const rawIndent = raw.length - raw.trimStart().length
      if (raw.trim() !== "" && rawIndent < contentIndent) break
      collected.push(raw.slice(contentIndent))
      rawIndex++
    }
    while (
      this.lines[this.index] !== undefined &&
      (this.lines[this.index]?.number ?? 0) <= rawIndex
    ) {
      this.index++
    }
    while (collected.length > 0 && collected[collected.length - 1]?.trim() === "") collected.pop()
    const text = folded
      ? collected.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ")
      : collected.join("\n")
    return strip ? text : keep ? `${text}\n` : `${text}\n`
  }
}

export const parseYaml = (source: string): Effect.Effect<YamlValue, YamlError> =>
  Effect.try({
    try: () => new Reader(source).document(),
    catch: (cause) =>
      cause instanceof YamlError ? cause : new YamlError({ line: 0, detail: "unreadable YAML" })
  })

// ---------------------------------------------------------------------------
// Writing

const plainUnsafe = /^[-?:,[\]{}#&*!|>'"%@`\s]|[\s]$|: |\s#|^(~|null|Null|NULL)$|[\n\r\t]/

/** A scalar as YAML: plain when it reads back unchanged, otherwise double-quoted. */
export const yamlScalar = (value: string | null): string => {
  if (value === null) return "~"
  if (
    value !== "" &&
    !plainUnsafe.test(value) &&
    ![...value].some((char) => char.charCodeAt(0) < 32)
  )
    return value
  return JSON.stringify(value)
}

export const yamlKey = (key: string): string =>
  /^[A-Za-z_@#][A-Za-z0-9_.\-@#]*$/.test(key) ? key : JSON.stringify(key)

/** Serialize a value (no comments); mappings keep insertion order. */
export const renderYaml = (value: YamlValue, indent = 0): string => {
  const pad = " ".repeat(indent)
  if (value === null || typeof value === "string") return `${pad}${yamlScalar(value)}\n`
  if (isYamlList(value)) {
    if (value.length === 0) return `${pad}[]\n`
    return value
      .map((item) => {
        if (item === null || typeof item === "string") return `${pad}- ${yamlScalar(item)}\n`
        const nested = renderYaml(item, indent + 2)
        return `${pad}- ${nested.slice(indent + 2)}`
      })
      .join("")
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return `${pad}{}\n`
  return entries
    .map(([key, item]) => {
      if (item === null || typeof item === "string") {
        return `${pad}${yamlKey(key)}: ${yamlScalar(item)}\n`
      }
      if (
        (isYamlList(item) && item.length === 0) ||
        (isYamlMap(item) && Object.keys(item).length === 0)
      ) {
        return `${pad}${yamlKey(key)}: ${isYamlList(item) ? "[]" : "{}"}\n`
      }
      return `${pad}${yamlKey(key)}:\n${renderYaml(item, isYamlList(item) ? indent : indent + 2)}`
    })
    .join("")
}
