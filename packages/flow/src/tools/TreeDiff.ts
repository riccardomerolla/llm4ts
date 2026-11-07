/**
 * A deep structural compare of two JSON values that reports every difference
 * with a JSONPath-style location, for tools that check an actual payload
 * against an expected one.
 *
 * Arrays compare under one of three orderings: by position (`ordered`), by an
 * identity field of their object elements (`per-key`), or as a multiset of
 * canonical JSON (`unordered`). Paths named in `ignore` are skipped on both
 * sides, so neither a missing nor an unexpected nor a changed value is
 * reported for them.
 */

export type DiffOrdering = "ordered" | "per-key" | "unordered"

export type DiffKind = "missing" | "unexpected" | "changed" | "type"

export interface DiffIssue {
  readonly path: string
  readonly kind: DiffKind
  readonly detail: string
}

export interface TreeDiffOptions {
  readonly ordering: DiffOrdering
  /**
   * Dot paths to skip, with `*` matching any one segment: `meta.requestId`,
   * `items.*.updatedAt`. An array index is a segment (`items.2`); under
   * `per-key` an element's segment is its identity (`items.42` or
   * `items.id=42`).
   */
  readonly ignore: ReadonlyArray<string>
  /**
   * For `per-key`: the first of these fields present in an array element
   * names its identity. Defaults to `["id", "key", "name", "code"]`.
   */
  readonly keyFields?: ReadonlyArray<string>
}

const defaultKeyFields: ReadonlyArray<string> = ["id", "key", "name", "code"]

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Serialises a value as compact JSON with object keys sorted. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    return `{${entries.join(",")}}`
  }
  const text = JSON.stringify(value)
  return text === undefined ? "null" : text
}

const renderLimit = 80

const render = (value: unknown): string => {
  const text = canonicalJson(value)
  return text.length > renderLimit ? `${text.slice(0, renderLimit - 1)}…` : text
}

type Segment =
  | { readonly kind: "key"; readonly name: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "identity"; readonly field: string; readonly value: unknown }

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const plainKeyValue = /^[A-Za-z0-9_.:-]+$/

const renderKeyValue = (value: unknown): string =>
  typeof value === "number" || (typeof value === "string" && plainKeyValue.test(value))
    ? String(value)
    : canonicalJson(value)

const renderPath = (segments: ReadonlyArray<Segment>): string =>
  segments.reduce((path, segment) => {
    switch (segment.kind) {
      case "key":
        return identifier.test(segment.name)
          ? `${path}.${segment.name}`
          : `${path}[${JSON.stringify(segment.name)}]`
      case "index":
        return `${path}[${segment.index}]`
      case "identity":
        return `${path}[${segment.field}=${renderKeyValue(segment.value)}]`
    }
  }, "$")

const segmentMatches = (pattern: string, segment: Segment): boolean => {
  if (pattern === "*") return true
  switch (segment.kind) {
    case "key":
      return pattern === segment.name
    case "index":
      return pattern === String(segment.index)
    case "identity": {
      const value = renderKeyValue(segment.value)
      return pattern === value || pattern === `${segment.field}=${value}`
    }
  }
}

const pathMatches = (pattern: ReadonlyArray<string>, segments: ReadonlyArray<Segment>): boolean =>
  pattern.length === segments.length &&
  pattern.every((part, index) => segmentMatches(part, segments[index]))

interface Differ {
  readonly ordering: DiffOrdering
  readonly ignore: ReadonlyArray<ReadonlyArray<string>>
  readonly keyFields: ReadonlyArray<string>
  readonly issues: Array<DiffIssue>
}

const ignored = (differ: Differ, segments: ReadonlyArray<Segment>): boolean =>
  differ.ignore.some((pattern) => pathMatches(pattern, segments))

const report = (
  differ: Differ,
  segments: ReadonlyArray<Segment>,
  kind: DiffKind,
  detail: string
): void => {
  differ.issues.push({ path: renderPath(segments), kind, detail })
}

/** Removes the ignored paths below `segments` from a value, for canonical matching. */
const strip = (differ: Differ, value: unknown, segments: ReadonlyArray<Segment>): unknown => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const child: ReadonlyArray<Segment> = [...segments, { kind: "index", index }]
      return ignored(differ, child) ? [] : [strip(differ, item, child)]
    })
  }
  if (isRecord(value)) {
    const out: JsonRecord = {}
    for (const name of Object.keys(value)) {
      const child: ReadonlyArray<Segment> = [...segments, { kind: "key", name }]
      if (!ignored(differ, child)) out[name] = strip(differ, value[name], child)
    }
    return out
  }
  return value
}

const identityOf = (
  differ: Differ,
  element: unknown
): { readonly field: string; readonly value: unknown; readonly token: string } | undefined => {
  if (!isRecord(element)) return undefined
  for (const field of differ.keyFields) {
    if (element[field] !== undefined) {
      const value = element[field]
      return { field, value, token: `${field}=${canonicalJson(value)}` }
    }
  }
  return undefined
}

const diffOrdered = (
  differ: Differ,
  expected: ReadonlyArray<unknown>,
  actual: ReadonlyArray<unknown>,
  segments: ReadonlyArray<Segment>
): void => {
  const shared = Math.min(expected.length, actual.length)
  for (let index = 0; index < shared; index++) {
    diffAt(differ, expected[index], actual[index], [...segments, { kind: "index", index }])
  }
  for (let index = shared; index < expected.length; index++) {
    const child: ReadonlyArray<Segment> = [...segments, { kind: "index", index }]
    if (ignored(differ, child)) continue
    report(differ, child, "missing", `missing item ${render(expected[index])} at index ${index}`)
  }
  for (let index = shared; index < actual.length; index++) {
    const child: ReadonlyArray<Segment> = [...segments, { kind: "index", index }]
    if (ignored(differ, child)) continue
    report(
      differ,
      child,
      "unexpected",
      `unexpected item ${render(actual[index])} at index ${index}`
    )
  }
}

const diffPerKey = (
  differ: Differ,
  expected: ReadonlyArray<unknown>,
  actual: ReadonlyArray<unknown>,
  segments: ReadonlyArray<Segment>
): void => {
  const byIdentity = new Map<string, Array<number>>()
  actual.forEach((element, index) => {
    const identity = identityOf(differ, element)
    if (identity === undefined) return
    const queue = byIdentity.get(identity.token)
    if (queue === undefined) byIdentity.set(identity.token, [index])
    else queue.push(index)
  })
  const used = new Set<number>()

  expected.forEach((element, index) => {
    const identity = identityOf(differ, element)
    if (identity === undefined) {
      const child: ReadonlyArray<Segment> = [...segments, { kind: "index", index }]
      const counterpart = actual[index]
      if (
        index < actual.length &&
        !used.has(index) &&
        identityOf(differ, counterpart) === undefined
      ) {
        used.add(index)
        diffAt(differ, element, counterpart, child)
      } else if (!ignored(differ, child)) {
        report(differ, child, "missing", `missing item ${render(element)} at index ${index}`)
      }
      return
    }
    const child: ReadonlyArray<Segment> = [
      ...segments,
      { kind: "identity", field: identity.field, value: identity.value }
    ]
    const match = byIdentity.get(identity.token)?.shift()
    if (match === undefined) {
      if (!ignored(differ, child)) {
        report(
          differ,
          child,
          "missing",
          `missing item with ${identity.field}=${renderKeyValue(identity.value)}`
        )
      }
      return
    }
    used.add(match)
    diffAt(differ, element, actual[match], child)
  })

  actual.forEach((element, index) => {
    if (used.has(index)) return
    const identity = identityOf(differ, element)
    const child: ReadonlyArray<Segment> =
      identity === undefined
        ? [...segments, { kind: "index", index }]
        : [...segments, { kind: "identity", field: identity.field, value: identity.value }]
    if (ignored(differ, child)) return
    const detail =
      identity === undefined
        ? `unexpected item ${render(element)} at index ${index}`
        : `unexpected item with ${identity.field}=${renderKeyValue(identity.value)}`
    report(differ, child, "unexpected", detail)
  })
}

const diffUnordered = (
  differ: Differ,
  expected: ReadonlyArray<unknown>,
  actual: ReadonlyArray<unknown>,
  segments: ReadonlyArray<Segment>
): void => {
  const keyOf = (element: unknown, index: number): string | undefined => {
    const child: ReadonlyArray<Segment> = [...segments, { kind: "index", index }]
    return ignored(differ, child) ? undefined : canonicalJson(strip(differ, element, child))
  }
  const expectedKeys = expected.map(keyOf)
  const actualKeys = actual.map(keyOf)
  const count = (keys: ReadonlyArray<string | undefined>): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const key of keys) {
      if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }
  const leftover = (
    keys: ReadonlyArray<string | undefined>,
    available: Map<string, number>
  ): ReadonlyArray<number> =>
    keys.flatMap((key, index) => {
      if (key === undefined) return []
      const left = available.get(key) ?? 0
      if (left === 0) return [index]
      available.set(key, left - 1)
      return []
    })

  for (const index of leftover(expectedKeys, count(actualKeys))) {
    report(
      differ,
      [...segments, { kind: "index", index }],
      "missing",
      `missing item ${render(expected[index])}`
    )
  }
  for (const index of leftover(actualKeys, count(expectedKeys))) {
    report(
      differ,
      [...segments, { kind: "index", index }],
      "unexpected",
      `unexpected item ${render(actual[index])}`
    )
  }
}

const diffObjects = (
  differ: Differ,
  expected: JsonRecord,
  actual: JsonRecord,
  segments: ReadonlyArray<Segment>
): void => {
  const present = (record: JsonRecord, name: string): boolean =>
    Object.prototype.hasOwnProperty.call(record, name) && record[name] !== undefined
  for (const name of Object.keys(expected)) {
    if (!present(expected, name)) continue
    const child: ReadonlyArray<Segment> = [...segments, { kind: "key", name }]
    if (ignored(differ, child)) continue
    if (present(actual, name)) diffAt(differ, expected[name], actual[name], child)
    else report(differ, child, "missing", `missing property ${JSON.stringify(name)}`)
  }
  for (const name of Object.keys(actual)) {
    if (!present(actual, name) || present(expected, name)) continue
    const child: ReadonlyArray<Segment> = [...segments, { kind: "key", name }]
    if (ignored(differ, child)) continue
    report(differ, child, "unexpected", `unexpected property ${JSON.stringify(name)}`)
  }
}

const diffAt = (
  differ: Differ,
  expected: unknown,
  actual: unknown,
  segments: ReadonlyArray<Segment>
): void => {
  if (ignored(differ, segments)) return
  const expectedType = jsonTypeOf(expected)
  const actualType = jsonTypeOf(actual)
  if (expectedType !== actualType) {
    report(differ, segments, "type", `expected ${expectedType}, found ${actualType}`)
    return
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    switch (differ.ordering) {
      case "ordered":
        return diffOrdered(differ, expected, actual, segments)
      case "per-key":
        return diffPerKey(differ, expected, actual, segments)
      case "unordered":
        return diffUnordered(differ, expected, actual, segments)
    }
  }
  if (isRecord(expected) && isRecord(actual)) return diffObjects(differ, expected, actual, segments)
  if (expected !== actual) {
    report(differ, segments, "changed", `expected ${render(expected)}, found ${render(actual)}`)
  }
}

/**
 * Compares `actual` against `expected` and returns every difference found,
 * in document order: for objects the expected keys first, then the extra
 * keys of `actual`; for arrays as the ordering dictates.
 */
export const diffJson = (
  expected: unknown,
  actual: unknown,
  options: TreeDiffOptions
): ReadonlyArray<DiffIssue> => {
  const differ: Differ = {
    ordering: options.ordering,
    ignore: options.ignore.map((pattern) => pattern.split(".")),
    keyFields: options.keyFields ?? defaultKeyFields,
    issues: []
  }
  diffAt(differ, expected, actual, [])
  return differ.issues
}
