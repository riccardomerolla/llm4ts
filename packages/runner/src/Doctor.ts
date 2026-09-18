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
 * model is an entry in that provider's `models`. `bridged` marks the pairs
 * whose provider points at this machine's ACP bridge — the ones that draw
 * inference from gemini's OAuth session instead of a model API key.
 */
export interface PiModelRef {
  readonly ref: string
  readonly bridged: boolean
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

/** A `models` entry is a bare id or an object carrying one; pi writes both. */
const modelId = (entry: unknown): string | undefined => {
  if (typeof entry === "string") {
    return entry.length === 0 ? undefined : entry
  }
  if (!isRecord(entry)) {
    return undefined
  }
  const id = entry.id ?? entry.name
  return typeof id === "string" && id.length > 0 ? id : undefined
}

/**
 * Every `provider/model` pair pi could resolve from its own config, so a
 * caller can name one instead of guessing. Reporting only, and deliberately
 * total: an unreadable or malformed file yields no pairs rather than an
 * error, because this exists to explain a failure and must never cause one.
 */
export const piModelRefs = (
  modelsJson: string | undefined,
  port: string
): ReadonlyArray<PiModelRef> => {
  if (modelsJson === undefined) {
    return []
  }
  const parsed = parseJson(modelsJson)
  const providers = isRecord(parsed) ? parsed.providers : undefined
  if (!isRecord(providers)) {
    return []
  }
  const refs: Array<PiModelRef> = []
  for (const [provider, entry] of Object.entries(providers)) {
    if (!isRecord(entry)) {
      continue
    }
    const baseUrl = entry.baseUrl
    const bridged = typeof baseUrl === "string" && baseUrl.includes(`127.0.0.1:${port}`)
    const models = entry.models
    if (!Array.isArray(models)) {
      continue
    }
    for (const model of models) {
      const id = modelId(model)
      if (id !== undefined) {
        refs.push({ ref: `${provider}/${id}`, bridged })
      }
    }
  }
  return refs
}

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
  const refs = piModelRefs(modelsJson, port)
  const bridged = refs.filter((entry) => entry.bridged).map((entry) => entry.ref)
  if (bridged.length > 0) {
    return {
      satisfied: true,
      summary: `a provider in ~/.pi/agent/models.json points at ${needle}`,
      detail: [
        "bridge models — pass one as LLM4TS_GEMINI_BRIDGE_MODEL (pi's --model):",
        ...bridged.map((ref) => `  ${ref}`)
      ]
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
