import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ConnectorCapabilities } from "@llm4ts/core/Models"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { FlowError } from "./FlowError.ts"
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
  /**
   * The same seats rebound to another directory (a story worktree, ADR
   * 0013): every CLI seat launched there, git rooted there, the run's
   * events and cost tracking shared. Absent when the runner cannot rebind
   * (an embedded context built by hand).
   */
  readonly contextFor?: (workDir: string) => Effect.Effect<FlowContextShape, FlowError, Scope.Scope>
}

export class FlowContext extends Context.Service<FlowContext, FlowContextShape>()(
  "@llm4ts/flow/FlowContext"
) {}
