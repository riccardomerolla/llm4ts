import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import type { ConnectorCapabilities } from "@llm4ts/core/Models"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import type { GitToolShape } from "./GitTool.ts"
import type { GitHubToolShape } from "./GitHubTool.ts"
import type { RosterView } from "./RosterSeats.ts"

/** How a rebound context wants its coder (ADR 0019); ignored without a roster. */
export interface ContextOptions {
  /** The executor this context held before (a resumed story), taken first while free. */
  readonly prefer?: string
  /** Who the context is for, in the roster's events ("story conto-overview"). */
  readonly label?: string
}

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
   * Typed judgments (ADR 0017), over the run's `judgment` seat or the hosted
   * TypeSafe backend. Absent on a context built by hand; `judgmentOf` in
   * `Judgment.ts` then derives one from the reasoning seat.
   */
  readonly judgment?: JudgmentShape
  /**
   * The same seats rebound to another directory (a story worktree, ADR
   * 0013): every CLI seat launched there, git rooted there, the run's
   * events and cost tracking shared. Absent when the runner cannot rebind
   * (an embedded context built by hand).
   */
  readonly contextFor?: (
    workDir: string,
    options?: ContextOptions
  ) => Effect.Effect<FlowContextShape, FlowError, Scope.Scope>
  /**
   * The executor roster behind the seats (ADR 0019), when the run has one:
   * a seat per role, free and configured slots, and the executor holding
   * this context's coder. Absent on a run with one executor per seat.
   */
  readonly roster?: RosterView
}

export class FlowContext extends Context.Service<FlowContext, FlowContextShape>()(
  "@llm4ts/flow/FlowContext"
) {}
