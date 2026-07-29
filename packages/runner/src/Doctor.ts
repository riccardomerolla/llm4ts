import * as Effect from "effect/Effect"
import type { HealthStatus } from "@llm4ts/core/Models"
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

export const makeDoctorProgram = (
  registry: ConnectorRegistryShape = nodeFlowRunnerDependencies().registry,
  environment: Readonly<Record<string, string | undefined>> = process.env
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
    lines.push("")
    lines.push(
      `coder: ${environment.LLM4TS_CODER ?? environment.LLM4ZIO_CODER ?? "claude (default)"}`
    )
    return `${lines.join("\n")}\n`
  })
