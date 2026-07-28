import { StageCompleted, StageFailed, StageStarted, type FlowEvent } from "./FlowEvents.ts"
import type { TraceLine } from "./FlowRecorder.ts"

const escapeLabel = (label: string): string => label.replaceAll('"', "'")

export const renderMermaid = (events: ReadonlyArray<FlowEvent>): string => {
  const starts = events
    .filter((event): event is StageStarted => event._tag === "StageStarted")
    .map((event) => event.stage)
  const failed = new Set(
    events
      .filter((event): event is StageFailed => event._tag === "StageFailed")
      .map((event) => event.stage)
  )
  if (starts.length === 0) {
    return 'flowchart TD\n  none["(no stages)"]'
  }
  const order = [...new Set(starts)]
  const counts = new Map<string, number>()
  for (const stage of starts) {
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  const ids = new Map<string, string>()
  order.forEach((name, index) => ids.set(name, `n${index}`))
  const nodes = order.map((name) => {
    const count = counts.get(name) ?? 1
    const label = count > 1 ? `${name} ×${count}` : name
    return `  ${ids.get(name)}["${escapeLabel(label)}"]${failed.has(name) ? ":::failed" : ""}`
  })
  const edges = order
    .slice(1)
    .map((name, index) => `  ${ids.get(order[index] ?? "")} --> ${ids.get(name)}`)
  const styles = failed.size === 0 ? [] : ["  classDef failed fill:#fdd,stroke:#c00,color:#900;"]
  return ["flowchart TD", ...nodes, ...edges, ...styles].join("\n")
}

const traceStage = (line: TraceLine): FlowEvent | undefined => {
  const field = (key: string): string | undefined => {
    const direct = line.fields[key]
    if (typeof direct === "string") {
      return direct
    }
    const encoded = line.fields.event
    if (typeof encoded !== "string") {
      return undefined
    }
    try {
      const event: unknown = JSON.parse(encoded)
      if (typeof event !== "object" || event === null) {
        return undefined
      }
      const value = Reflect.get(event, key)
      return typeof value === "string" ? value : undefined
    } catch {
      return undefined
    }
  }
  switch (line.kind) {
    case "StageStarted": {
      const stage = field("stage")
      return stage === undefined ? undefined : StageStarted.make({ stage })
    }
    case "StageCompleted": {
      const stage = field("stage")
      return stage === undefined ? undefined : StageCompleted.make({ stage })
    }
    case "StageFailed": {
      const stage = field("stage")
      return stage === undefined
        ? undefined
        : StageFailed.make({ stage, message: field("message") ?? "" })
    }
    default:
      return undefined
  }
}

export const renderMermaidTrace = (lines: ReadonlyArray<TraceLine>): string =>
  renderMermaid(
    lines.flatMap((line) => {
      const event = traceStage(line)
      return event === undefined ? [] : [event]
    })
  )

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const base64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value)
  let encoded = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    const block = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    encoded += alphabet[(block >> 18) & 63]
    encoded += alphabet[(block >> 12) & 63]
    if (second !== undefined) {
      encoded += alphabet[(block >> 6) & 63]
    }
    if (third !== undefined) {
      encoded += alphabet[block & 63]
    }
  }
  return encoded
}

export const mermaidLiveUrl = (diagram: string): string =>
  `https://mermaid.ink/svg/${base64Url(diagram)}`

export const mermaidDocument = (diagram: string): string =>
  `\`\`\`mermaid\n${diagram}\n\`\`\`\n\n[View on mermaid.ink](${mermaidLiveUrl(diagram)})\n`
