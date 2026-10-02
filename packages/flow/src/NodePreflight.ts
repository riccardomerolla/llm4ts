/**
 * Which Node will the gates run on, and is it the one the application pins?
 *
 * Gates (`pnpm lint`, `pnpm test`, `pnpm build`) are spawned with the
 * environment llm4ts inherited, so `pnpm` finds the `node` on PATH, which is
 * whatever shell launched llm4ts, not what the application asks for in
 * `.nvmrc`, `.node-version` or `package.json#engines`. A mismatch surfaces as
 * a red gate on the first story, in a syntax error or an engine refusal that
 * says nothing about Node. This asks before the first gate, and names both.
 *
 * pnpm's `use-node-version` (`.npmrc`) makes pnpm fetch and run that Node
 * itself, so a target that carries it passes regardless of PATH.
 */
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { FlowAborted, type FlowError } from "./FlowError.ts"
import { Info, type FlowEventsShape } from "./FlowEvents.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

/** A Node pin as the application wrote it, and where. */
export class NodePin extends Schema.Class<NodePin>("NodePin")({
  spec: Schema.String,
  source: Schema.String
}) {}

// ---- Version matching ---------------------------------------------------------------

type Partial = {
  readonly major: number
  readonly minor?: number
  readonly patch?: number
}

const partialOf = (text: string): Partial | undefined => {
  const match = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(text.trim())
  if (match === null || match[1] === undefined) {
    return undefined
  }
  const component = (value: string | undefined): number | undefined =>
    value === undefined || value === "x" || value === "*" ? undefined : Number(value)
  const minor = component(match[2])
  const patch = component(match[3])
  return {
    major: Number(match[1]),
    ...(minor === undefined ? {} : { minor }),
    ...(patch === undefined ? {} : { patch })
  }
}

const triple = (version: Partial): ReadonlyArray<number> => [
  version.major,
  version.minor ?? 0,
  version.patch ?? 0
]

const compare = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

/** The alias forms only a version manager resolves (`lts/*`, `lts/iron`, `node`). */
const isAlias = (spec: string): boolean =>
  /^(lts\/.*|node|latest|stable|current|system)$/i.test(spec)

const tokenHolds = (version: ReadonlyArray<number>, token: string): boolean | undefined => {
  if (token === "*" || token === "x" || token === "latest") {
    return true
  }
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
  const operator = match?.[1] ?? ""
  const partial = partialOf(match?.[2] ?? "")
  if (partial === undefined) {
    return undefined
  }
  const low = triple(partial)
  switch (operator) {
    case ">=":
      return compare(version, low) >= 0
    case ">":
      return compare(version, low) > 0
    case "<":
      return compare(version, low) < 0
    case "<=":
      return compare(version, low) <= 0
    case "^": {
      const high =
        partial.major > 0
          ? [partial.major + 1, 0, 0]
          : partial.minor !== undefined && partial.minor > 0
            ? [0, partial.minor + 1, 0]
            : [0, 0, (partial.patch ?? 0) + 1]
      return compare(version, low) >= 0 && compare(version, high) < 0
    }
    case "~": {
      const high =
        partial.minor === undefined
          ? [partial.major + 1, 0, 0]
          : [partial.major, partial.minor + 1, 0]
      return compare(version, low) >= 0 && compare(version, high) < 0
    }
    default: {
      // A bare pin matches on the components it names: "20" is any 20.x.y.
      const [major, minor, patch] = version
      return (
        major === partial.major &&
        (partial.minor === undefined || minor === partial.minor) &&
        (partial.patch === undefined || patch === partial.patch)
      )
    }
  }
}

/**
 * Whether a Node version (`v24.12.0`) satisfies a pin as `.nvmrc`, `engines`
 * or corepack write them; `undefined` when the pin is an alias or a form
 * this cannot read, which is a reason to say so, not to fail.
 */
export const nodeVersionSatisfies = (version: string, spec: string): boolean | undefined => {
  const trimmed = spec.trim()
  const have = partialOf(version)
  if (have === undefined || isAlias(trimmed)) {
    return undefined
  }
  const actual = triple(have)
  let unknown = false
  const clauses = trimmed.split("||").map((clause) => clause.trim())
  for (const clause of clauses) {
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause)
    const tokens =
      hyphen?.[1] !== undefined && hyphen[2] !== undefined
        ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
        : clause.split(/\s+/).filter((token) => token.length > 0)
    const verdicts = tokens.map((token) => tokenHolds(actual, token))
    if (verdicts.some((verdict) => verdict === undefined)) {
      unknown = true
      continue
    }
    if (verdicts.every((verdict) => verdict === true)) {
      return true
    }
  }
  return unknown ? undefined : false
}

// ---- Reading the pins ------------------------------------------------------------------

const PackageEngines = Schema.fromJsonString(
  Schema.Struct({
    engines: Schema.optionalKey(Schema.Struct({ node: Schema.optionalKey(Schema.String) }))
  })
)

const readOptional = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<string | undefined> =>
  files.read(path).pipe(Effect.catch(() => Effect.succeed(undefined)))

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .find((line) => line.length > 0) ?? ""

/** The Node pins in an application directory: `.nvmrc`, `.node-version`, `engines.node`. */
export const nodePinsOf = (
  files: PlainFileStoreShape,
  appDir: string
): Effect.Effect<ReadonlyArray<NodePin>> =>
  Effect.gen(function* () {
    const pins: Array<NodePin> = []
    for (const source of [".nvmrc", ".node-version"]) {
      const text = yield* readOptional(files, join(appDir, source))
      const spec = text === undefined ? "" : firstLine(text)
      if (spec.length > 0) {
        pins.push(NodePin.make({ spec, source }))
      }
    }
    const manifest = yield* readOptional(files, join(appDir, "package.json"))
    if (manifest !== undefined) {
      const engines = yield* Schema.decodeUnknownEffect(PackageEngines)(manifest).pipe(
        Effect.map((parsed) => parsed.engines?.node?.trim()),
        Effect.catch(() => Effect.succeed(undefined))
      )
      if (engines !== undefined && engines.length > 0) {
        pins.push(NodePin.make({ spec: engines, source: "package.json engines.node" }))
      }
    }
    return pins
  })

/** pnpm's `use-node-version` from the application's `.npmrc`, when it carries one. */
export const pnpmNodeVersionOf = (
  files: PlainFileStoreShape,
  appDir: string
): Effect.Effect<string | undefined> =>
  Effect.map(readOptional(files, join(appDir, ".npmrc")), (text) => {
    for (const line of (text ?? "").split(/\r?\n/)) {
      const match = /^\s*use-node-version\s*=\s*(\S+)/.exec(line)
      if (match?.[1] !== undefined) {
        return match[1]
      }
    }
    return undefined
  })

// ---- The report ---------------------------------------------------------------------------

export type NodePreflightReport =
  | { readonly _tag: "Off"; readonly summary: string }
  | { readonly _tag: "NoPin"; readonly summary: string }
  | { readonly _tag: "Managed"; readonly node: string; readonly summary: string }
  | { readonly _tag: "NoNode"; readonly summary: string }
  | {
      readonly _tag: "Mismatch"
      readonly node: string
      readonly unmet: ReadonlyArray<NodePin>
      readonly summary: string
    }
  | { readonly _tag: "Ok"; readonly node: string; readonly summary: string }

const switchedOff = (value: string | undefined): boolean =>
  value !== undefined && ["off", "0", "false", "no"].includes(value.trim().toLowerCase())

const describePin = (pin: NodePin): string => `${pin.spec} (${pin.source})`

/**
 * Compares the Node the gates would run on — `node --version` through the
 * same executor and PATH the gates get — with the application's pins.
 * `LLM4TS_NODE_CHECK=off` skips it.
 */
export const nodePreflightReport = Effect.fn("@llm4ts/flow/NodePreflight.report")(function* (
  process: ProcessExecutorShape,
  files: PlainFileStoreShape,
  appDir: string,
  environment: Readonly<Record<string, string | undefined>>
): Effect.fn.Return<NodePreflightReport> {
  if (switchedOff(environment.LLM4TS_NODE_CHECK)) {
    return { _tag: "Off", summary: "node: check off (LLM4TS_NODE_CHECK)" }
  }
  const pins = yield* nodePinsOf(files, appDir)
  if (pins.length === 0) {
    return {
      _tag: "NoPin",
      summary: `node: ${appDir} pins no version (.nvmrc, .node-version, package.json engines.node)`
    }
  }
  const managed = yield* pnpmNodeVersionOf(files, appDir)
  if (managed !== undefined) {
    return {
      _tag: "Managed",
      node: managed,
      summary: `node: pnpm runs the gates on Node ${managed} (use-node-version in .npmrc)`
    }
  }
  const probed = yield* process.run(["node", "--version"], appDir, {}).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.join("").trim() : undefined)),
    Effect.catch(() => Effect.succeed(undefined))
  )
  if (probed === undefined || probed.length === 0) {
    return {
      _tag: "NoNode",
      summary:
        `node: not on the PATH the gates inherit, though ${appDir} pins ` +
        `${pins.map(describePin).join(", ")}; launch llm4ts from a shell with node on PATH`
    }
  }
  const unmet = pins.filter((pin) => nodeVersionSatisfies(probed, pin.spec) === false)
  const unchecked = pins.filter((pin) => nodeVersionSatisfies(probed, pin.spec) === undefined)
  if (unmet.length > 0) {
    return {
      _tag: "Mismatch",
      node: probed,
      unmet,
      summary:
        `node: the gates would run on Node ${probed} (the node on PATH), but ${appDir} pins ` +
        `${unmet.map(describePin).join(", ")}. Launch llm4ts under a matching Node ` +
        "(nvm use / fnm use), or add use-node-version=<x.y.z> to the application's .npmrc " +
        "so pnpm fetches it, or set LLM4TS_NODE_CHECK=off to run anyway"
    }
  }
  return {
    _tag: "Ok",
    node: probed,
    summary:
      `node: ${probed} satisfies ${pins
        .filter((pin) => !unchecked.includes(pin))
        .map(describePin)
        .join(", ")}` +
      (unchecked.length === 0
        ? ""
        : `; ${unchecked.map(describePin).join(", ")} not checked (an alias only a version manager resolves)`)
  }
})

/** The report on the run's events, or the run aborted before its first gate. */
export const nodePreflight = Effect.fn("@llm4ts/flow/NodePreflight.nodePreflight")(function* (
  process: ProcessExecutorShape,
  files: PlainFileStoreShape,
  events: FlowEventsShape,
  appDir: string,
  environment: Readonly<Record<string, string | undefined>>
): Effect.fn.Return<void, FlowError> {
  const report = yield* nodePreflightReport(process, files, appDir, environment)
  if (report._tag === "Mismatch" || report._tag === "NoNode") {
    return yield* FlowAborted.make({ message: report.summary })
  }
  yield* events.publish(Info.make({ message: report.summary }))
})
