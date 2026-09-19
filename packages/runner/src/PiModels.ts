import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Reading `pi`'s own model config (ADR 0016). Separate from `Doctor.ts` so
 * the flow runner can consult it without importing the doctor — which
 * imports the runner — and so the parsing has no dependency on either.
 *
 * pi owns this file; llm4ts only ever reads it.
 */

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0

export const defaultGeminiBridgePort = "8731"

/**
 * `~/.pi/agent/models.json`. Read only — llm4ts never writes it. Missing is
 * not an error: the file simply doesn't exist yet.
 */
export const defaultReadPiModelsJson = (): string | undefined => {
  try {
    return readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8")
  } catch {
    return undefined
  }
}

export const geminiBridgePort = (
  environment: Readonly<Record<string, string | undefined>>
): string =>
  isSet(environment.LLM4TS_GEMINI_BRIDGE_PORT)
    ? environment.LLM4TS_GEMINI_BRIDGE_PORT.trim()
    : defaultGeminiBridgePort

/**
 * One value pi accepts for `--model`: `<provider>/<model>`, where the
 * provider is a key under `providers` in `~/.pi/agent/models.json` and the
 * model is a `models` entry's `id`. `bridged` marks the pairs whose provider
 * points at this machine's ACP bridge — the ones that draw inference from
 * gemini's OAuth session instead of a model API key.
 *
 * `authConfigured` tracks pi's availability rule rather than its schema: a
 * provider with no `apiKey` still loads, but its models stay hidden from
 * `--model` and `--list-models` until `/login`, `auth.json`, or `--api-key`
 * supplies one. The bridge needs no real credential, so a placeholder is
 * enough — but something must be there.
 */
export interface PiModelRef {
  readonly ref: string
  readonly bridged: boolean
  readonly authConfigured: boolean
}

/**
 * What pi makes of `~/.pi/agent/models.json`. `problems` mirrors pi's own
 * schema validation, and a non-empty list means pi loads *nothing* from the
 * file — it reports "errors loading models.json" and falls back to built-in
 * providers, so `refs` is what the file intended, not what pi will accept.
 */
export interface PiModelsConfig {
  readonly refs: ReadonlyArray<PiModelRef>
  readonly problems: ReadonlyArray<string>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Annotated rather than asserted, matching `NodeGeminiAcpBridge.parseJson`. */
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * pi's schema requires each `models` entry to be an object carrying a string
 * `id`; a bare `"model-name"` string fails validation with
 * `models.<i>: must be object` and takes the whole file down with it.
 */
const modelId = (entry: unknown): string | undefined => {
  if (!isRecord(entry)) {
    return undefined
  }
  const id = entry.id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * Read pi's config the way pi reads it, so a report can say why a model is
 * missing rather than only that it is. Deliberately total: an unreadable or
 * malformed file yields problems, never a raised error, because this runs
 * only to explain a failure and must never become one.
 */
export const piModelsConfig = (modelsJson: string | undefined, port: string): PiModelsConfig => {
  if (modelsJson === undefined) {
    return { refs: [], problems: [] }
  }
  const parsed = parseJson(modelsJson)
  if (parsed === undefined) {
    return { refs: [], problems: ["models.json is not valid JSON"] }
  }
  const providers = isRecord(parsed) ? parsed.providers : undefined
  if (!isRecord(providers)) {
    return { refs: [], problems: ["providers: must be an object"] }
  }
  const refs: Array<PiModelRef> = []
  const problems: Array<string> = []
  for (const [provider, entry] of Object.entries(providers)) {
    if (!isRecord(entry)) {
      problems.push(`providers.${provider}: must be an object`)
      continue
    }
    const baseUrl = entry.baseUrl
    const bridged = typeof baseUrl === "string" && baseUrl.includes(`127.0.0.1:${port}`)
    // pi resolves `apiKey` from a literal, `$ENV`, or a `!command`; any of
    // them counts as configured here, because presence is the availability
    // rule and llm4ts must never resolve the value itself.
    const authConfigured = typeof entry.apiKey === "string" && entry.apiKey.length > 0
    const models = entry.models
    if (models === undefined) {
      continue
    }
    if (!Array.isArray(models)) {
      problems.push(`providers.${provider}.models: must be an array`)
      continue
    }
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      problems.push(`providers.${provider}.baseUrl: required for a provider with models`)
    }
    models.forEach((model, index) => {
      const id = modelId(model)
      if (id === undefined) {
        problems.push(`providers.${provider}.models.${index}: must be an object with a string id`)
        return
      }
      refs.push({ ref: `${provider}/${id}`, bridged, authConfigured })
    })
  }
  return { refs, problems }
}

/** Back-compat shape for callers that only want the pairs. */
export const piModelRefs = (
  modelsJson: string | undefined,
  port: string
): ReadonlyArray<PiModelRef> => piModelsConfig(modelsJson, port).refs

/** The `provider/model` values that reach gemini through the bridge. */
export const bridgeModelRefs = (
  modelsJson: string | undefined,
  port: string
): ReadonlyArray<string> =>
  piModelRefs(modelsJson, port)
    .filter((entry) => entry.bridged)
    .map((entry) => entry.ref)

/**
 * Which bridge-backed model a run should hand pi, decided from pi's own
 * config rather than a guessed default. Shared by the flow runner and the
 * ADR 0016 smoke test so both fail the same way for the same reason.
 */
export type BridgeModelResolution =
  | { readonly _tag: "Resolved"; readonly model: string }
  | { readonly _tag: "Ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly _tag: "Unavailable"; readonly problems: ReadonlyArray<string> }

export const resolveBridgeModel = (
  modelsJson: string | undefined,
  port: string,
  configured: string | undefined
): BridgeModelResolution => {
  if (isSet(configured)) {
    return { _tag: "Resolved", model: configured.trim() }
  }
  const { refs, problems } = piModelsConfig(modelsJson, port)
  // pi discards the whole file on any schema error, so a bridge entry that
  // parses here is still invisible to pi. Never offer one.
  if (problems.length > 0) {
    return { _tag: "Unavailable", problems }
  }
  const candidates = refs
    .filter((entry) => entry.bridged && entry.authConfigured)
    .map((entry) => entry.ref)
  const [only] = candidates
  if (only !== undefined && candidates.length === 1) {
    return { _tag: "Resolved", model: only }
  }
  return candidates.length === 0
    ? { _tag: "Unavailable", problems: [] }
    : { _tag: "Ambiguous", candidates }
}

/** Why no bridge model could be chosen, phrased for a run that must stop. */
export const bridgeModelProblem = (
  resolution: BridgeModelResolution,
  port: string
): string | undefined => {
  if (resolution._tag === "Resolved") {
    return undefined
  }
  if (resolution._tag === "Ambiguous") {
    return (
      `Several bridge models are available; set LLM4TS_GEMINI_BRIDGE_MODEL to one of:\n` +
      resolution.candidates.map((ref) => `  ${ref}`).join("\n")
    )
  }
  const detail =
    resolution.problems.length > 0
      ? ` It currently fails pi's schema:\n${resolution.problems.map((p) => `  ${p}`).join("\n")}`
      : ""
  return (
    `No usable bridge model in ~/.pi/agent/models.json for port ${port}. Add a provider ` +
    `with baseUrl "http://127.0.0.1:${port}", any placeholder apiKey, and a models entry ` +
    `shaped { "id": "..." } (see docs/configuration.md).${detail}\n` +
    `\`pi --list-models\` is the final word on what pi accepts; ` +
    `\`LLM4TS_GEMINI_BRIDGE=1 llm4ts doctor\` explains what it makes of the file.`
  )
}
