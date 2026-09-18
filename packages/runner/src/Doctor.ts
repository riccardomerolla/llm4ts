import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { HealthStatus } from "@llm4ts/core/Models"
import { ConnectorIds } from "@llm4ts/core/Models"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import { nodeFlowRunnerDependencies } from "./FlowRunner.ts"

const credentialKeys = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY"
] as const

const statusLine = (id: string, status: HealthStatus): string => {
  const mark =
    status.availability === "Healthy" ? "✔" : status.availability === "Unknown" ? "?" : "✖"
  const auth = status.authStatus === "Unknown" ? "" : `  auth: ${status.authStatus.toLowerCase()}`
  return `  ${mark} ${id.padEnd(14)} ${status.availability.toLowerCase()}${auth}`
}

const isSet = (value: string | undefined): value is string =>
  value !== undefined && value.trim().length > 0

const truthy = (value: string | undefined): boolean =>
  isSet(value) && ["1", "true", "yes"].includes(value.trim().toLowerCase())

export interface PrerequisiteReport {
  readonly satisfied: boolean
  readonly summary: string
  readonly hint?: string
  /** Extra lines rendered under the summary, already indented relative to it. */
  readonly detail?: ReadonlyArray<string>
}

/**
 * The Gemini CLI resolves credentials from the environment before it ever
 * looks at a prompt, and a Workspace or enterprise account with no project
 * configured fails during auth setup with "No project found" / "requires
 * setting the GOOGLE_CLOUD_PROJECT … env var" — a message that names nothing
 * about llm4ts and is easy to misread as a flow bug.
 *
 * The CLI accepts several routes; any one of them is enough:
 *   - `GEMINI_API_KEY` (AI Studio key),
 *   - Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI` plus a project or `GOOGLE_API_KEY`),
 *   - `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` for Code Assist,
 *   - or a personal OAuth login, which needs no environment at all.
 *
 * Personal OAuth cannot be observed from the environment, so an unconfigured
 * environment is reported as a caveat rather than a failure.
 */
export const geminiPrerequisites = (
  environment: Readonly<Record<string, string | undefined>>
): PrerequisiteReport => {
  const project = environment.GOOGLE_CLOUD_PROJECT ?? environment.GOOGLE_CLOUD_PROJECT_ID
  const vertex = truthy(environment.GOOGLE_GENAI_USE_VERTEXAI)
  if (isSet(environment.GEMINI_API_KEY)) {
    return { satisfied: true, summary: "GEMINI_API_KEY is set" }
  }
  if (vertex && (isSet(project) || isSet(environment.GOOGLE_API_KEY))) {
    return {
      satisfied: true,
      summary: isSet(project)
        ? `Vertex AI with GOOGLE_CLOUD_PROJECT=${project.trim()}`
        : "Vertex AI with GOOGLE_API_KEY"
    }
  }
  if (isSet(project)) {
    return { satisfied: true, summary: `GOOGLE_CLOUD_PROJECT=${project.trim()}` }
  }
  return {
    satisfied: false,
    summary: "no project or API key in the environment",
    hint:
      "a personal OAuth login still works; a Workspace or enterprise account fails at auth " +
      'setup with "No project found". Export GOOGLE_CLOUD_PROJECT (or GEMINI_API_KEY) in a file ' +
      "every shell reads — a login-only file such as ~/.bashrc is not read by non-interactive " +
      "shells, other shells, or IDE terminals."
  }
}

/** Wraps a hint to the terminal-friendly width the rest of the report uses. */
const wrap = (text: string, width: number, indent: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let line = ""
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    const candidate = line.length === 0 ? word : `${line} ${word}`
    if (candidate.length + indent.length > width && line.length > 0) {
      out.push(`${indent}${line}`)
      line = word
    } else {
      line = candidate
    }
  }
  if (line.length > 0) {
    out.push(`${indent}${line}`)
  }
  return out
}

const selectedCoder = (environment: Readonly<Record<string, string | undefined>>): string =>
  environment.LLM4TS_CODER ?? "claude (default)"

export const defaultGeminiBridgePort = "8731"

/**
 * `~/.pi/agent/models.json` (ADR 0016). Read for reporting only — this file
 * belongs to `pi`, outside llm4ts's package graph, and llm4ts never writes
 * it. Missing is not an error here: the file simply doesn't exist yet.
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
 * Whether pi's custom-provider config points at this machine's Gemini ACP
 * bridge — detect-and-report only, never auto-fixed (ADR 0016). `undefined`
 * means the check doesn't apply: nothing asked for the bridge.
 */
export const geminiBridgePrerequisites = (
  environment: Readonly<Record<string, string | undefined>>,
  modelsJson: string | undefined
): PrerequisiteReport | undefined => {
  if (!truthy(environment.LLM4TS_GEMINI_BRIDGE)) {
    return undefined
  }
  const port = geminiBridgePort(environment)
  const needle = `127.0.0.1:${port}`
  const hint =
    `add a custom provider to ~/.pi/agent/models.json with baseUrl ` +
    `"http://${needle}" so pi draws inference from the gemini-cli bridge instead ` +
    `of a model API key (ADR 0016) — llm4ts never writes this file for you.`
  if (modelsJson === undefined) {
    return { satisfied: false, summary: "~/.pi/agent/models.json not found", hint }
  }
  const { refs, problems } = piModelsConfig(modelsJson, port)
  // pi rejects the whole file on any schema error, so a well-formed bridge
  // entry sitting beside a bad one is still not loaded. Report that first:
  // every model below would otherwise look available while pi sees none.
  if (problems.length > 0) {
    return {
      satisfied: false,
      summary: "~/.pi/agent/models.json fails pi's schema, so pi loads none of it",
      hint:
        `fix the errors below and re-check with \`pi --list-models\`. Each models ` +
        `entry must be an object with a string id ({ "id": "gemini-2.5-pro" }), not ` +
        `a bare string.`,
      detail: problems.map((problem) => `  ${problem}`)
    }
  }
  const bridged = refs.filter((entry) => entry.bridged)
  const usable = bridged.filter((entry) => entry.authConfigured).map((entry) => entry.ref)
  if (usable.length > 0) {
    return {
      satisfied: true,
      summary: `a provider in ~/.pi/agent/models.json points at ${needle}`,
      detail: [
        "bridge models — pass one as LLM4TS_GEMINI_BRIDGE_MODEL (pi's --model):",
        ...usable.map((ref) => `  ${ref}`)
      ]
    }
  }
  // Loaded but hidden: pi keeps a keyless provider's models out of `--model`
  // and `--list-models`. The bridge authenticates as gemini, not as pi, so
  // any placeholder satisfies this.
  if (bridged.length > 0) {
    return {
      satisfied: false,
      summary: `the provider pointing at ${needle} configures no apiKey, so pi hides its models`,
      hint:
        `give that provider any placeholder apiKey (the bridge never checks it — ` +
        `gemini's own OAuth session supplies the credential), or run \`pi /login\` ` +
        `for it.`,
      detail: bridged.map((entry) => `  ${entry.ref}`)
    }
  }
  // A provider can point at the bridge and still list no models: pi resolves
  // `--model` against that list, so the run fails with "Model not found"
  // while a check that only greps for the port reports success.
  const pointed = modelsJson.includes(needle)
  const others = refs.map((entry) => entry.ref)
  return {
    satisfied: false,
    summary: pointed
      ? `a provider in ~/.pi/agent/models.json points at ${needle} but lists no models`
      : `no provider in ~/.pi/agent/models.json points at ${needle}`,
    hint,
    ...(others.length === 0
      ? {}
      : {
          detail: [
            "models pi can resolve today, none of them bridged:",
            ...others.map((ref) => `  ${ref}`)
          ]
        })
  }
}

export const makeDoctorProgram = (
  registry: ConnectorRegistryShape = nodeFlowRunnerDependencies().registry,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  readPiModelsJson: () => string | undefined = defaultReadPiModelsJson
): Effect.Effect<string> =>
  Effect.map(registry.healthCheckAll, (statuses) => {
    const lines: Array<string> = []
    lines.push("llm4ts doctor")
    lines.push("")
    lines.push("connectors:")
    const sorted = Array.from(statuses.entries()).sort(([a], [b]) => a.value.localeCompare(b.value))
    for (const [id, status] of sorted) {
      lines.push(statusLine(id.value, status))
    }
    lines.push("")
    lines.push("credentials:")
    for (const key of credentialKeys) {
      const value = environment[key]
      lines.push(`  ${value === undefined || value.length === 0 ? "✖" : "✔"} ${key}`)
    }

    // Connector prerequisites the environment must carry BEFORE a run: shown
    // when the connector is selected or the machine has its CLI, because that
    // is exactly when a missing one turns into a confusing mid-run failure.
    const coder = selectedCoder(environment)
    const geminiRelevant =
      coder.startsWith("gemini") ||
      Array.from(statuses.keys()).some(
        (id) =>
          id.value === ConnectorIds.GeminiCli.value || id.value === ConnectorIds.GeminiApi.value
      )
    const bridge = geminiBridgePrerequisites(environment, readPiModelsJson())
    if (geminiRelevant || bridge !== undefined) {
      lines.push("")
      lines.push("prerequisites:")
      const pushReport = (label: string, report: PrerequisiteReport): void => {
        lines.push(`  ${report.satisfied ? "✔" : "?"} ${label}: ${report.summary}`)
        if (report.hint !== undefined) {
          lines.push(...wrap(report.hint, 78, "      "))
        }
        for (const line of report.detail ?? []) {
          lines.push(`      ${line}`)
        }
      }
      if (geminiRelevant) {
        pushReport("gemini", geminiPrerequisites(environment))
      }
      if (bridge !== undefined) {
        pushReport("pi-gemini-bridge", bridge)
      }
    }

    lines.push("")
    lines.push(`coder: ${coder}`)
    return `${lines.join("\n")}\n`
  })
