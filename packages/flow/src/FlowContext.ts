import * as Context from "effect/Context"
import type { ConnectorCapabilities } from "@llm4ts/core/Models"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { FlowEventsShape } from "./FlowEvents.ts"
import type { GitToolShape } from "./GitTool.ts"
import type { GitHubToolShape } from "./GitHubTool.ts"

export interface FlowContextShape {
  readonly reasoning: LlmServiceShape
  readonly coder: LlmServiceShape
  readonly git: GitToolShape
  readonly hosting: GitHubToolShape
  readonly events: FlowEventsShape
  readonly reviewers: ReadonlyArray<LlmServiceShape>
  readonly coderCapabilities: ConnectorCapabilities
  readonly userPrompt: string
  readonly workDir: string
  readonly workspace: string
}

export class FlowContext extends Context.Service<FlowContext, FlowContextShape>()(
  "@llm4ts/flow/FlowContext"
) {}
