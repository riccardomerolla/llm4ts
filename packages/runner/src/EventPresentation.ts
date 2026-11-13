import * as Schema from "effect/Schema"
import type { FlowEvent, FlowEventByTag, FlowEventTag } from "@llm4ts/flow/FlowEvents"

export const Verbosity = Schema.Literals(["Quiet", "Normal", "Verbose", "Debug"])
export type Verbosity = typeof Verbosity.Type

const rank: Readonly<Record<Verbosity, number>> = { Quiet: 0, Normal: 1, Verbose: 2, Debug: 3 }

/** Whether `verbosity` is `least` or louder. */
export const atLeast = (verbosity: Verbosity, least: Verbosity): boolean =>
  rank[verbosity] >= rank[least]

/** A line of `llm4ts watch` and of the MCP run digests, and the lane it is filed under. */
export interface DigestLine {
  readonly text: string
  readonly lane?: string
}

/** How one event shows: on the terminal, in a profile's gaps, in a digest. */
export interface Presentation<E> {
  /**
   * Whether the terminal prints it as a line of its own: `never`, from a
   * verbosity up (`Quiet`: always), or by a rule of its own.
   */
  readonly line: "never" | Verbosity | ((event: E, verbosity: Verbosity) => boolean)
  /** The event by kind, never its content: how `llm4ts profile` names it around a gap. */
  readonly kind: string | ((event: E) => string)
  /** Its line in a digest. Absent: digests leave the event out. */
  readonly digest?: (event: E) => DigestLine
}

const laned = (lane: string | undefined): { readonly lane?: string } =>
  lane === undefined ? {} : { lane }

const capability = "a capability check"
const roster = "a roster change"
const other = "an event"

/**
 * Screen and digest policy for every event. Exhaustive by type: adding an
 * event class without an entry here fails `pnpm typecheck`.
 */
export const eventPresentation: {
  readonly [K in FlowEventTag]: Presentation<FlowEventByTag[K]>
} = {
  // Advise mode publishes a separate Info event for the operator.
  JudgmentObserved: { line: "never", kind: other },
  // For the trace file.
  BlackboardRun: { line: "never", kind: other },
  StageStarted: { line: "Quiet", kind: "a stage start" },
  StageCompleted: { line: "Quiet", kind: "a stage end" },
  StageFailed: {
    line: "Quiet",
    kind: "a stage failure",
    digest: (event) => ({ text: `${event.stage} failed: ${event.message}`, ...laned(event.lane) })
  },
  Aborted: {
    line: "Quiet",
    kind: other,
    digest: (event) => ({ text: `aborted: ${event.message}` })
  },
  Info: { line: "Normal", kind: "a log note" },
  ToolUse: { line: "Normal", kind: "a coder tool call" },
  AssistantMessage: { line: "Normal", kind: "an assistant message" },
  TokensUsed: { line: "Verbose", kind: "a token report" },
  // Progress feeds the status rows.
  UsageProgress: { line: "never", kind: other },
  ReviewFindings: { line: "Normal", kind: "a review round" },
  // Every git read and gate command is a capability event: useful in a
  // trace, noise on screen once several stories run.
  CapabilityUsed: { line: "Verbose", kind: capability },
  CapabilityDenied: { line: "Quiet", kind: capability },
  CapabilityUnenforceable: {
    line: "Quiet",
    kind: capability,
    digest: (event) => ({ text: `capability unenforceable: ${event.detail}` })
  },
  EvidenceChecked: { line: "Quiet", kind: "an evidence check" },
  ReviewFindingDemoted: { line: "Quiet", kind: "a review finding demoted" },
  ExecutorLeased: { line: "Normal", kind: roster },
  // A lease ending is routine.
  ExecutorReleased: { line: "never", kind: roster },
  ExecutorExcluded: {
    line: "Normal",
    kind: roster,
    digest: (event) => ({ text: `${event.executor} excluded: ${event.reason}` })
  },
  ExecutorResumed: { line: "Normal", kind: roster },
  ExecutorHandedOver: {
    line: "Normal",
    kind: roster,
    digest: (event) => ({
      text: `${event.from} handed over ${event.role} (${event.scope}): ${event.reason}`,
      ...laned(event.label)
    })
  },
  // The story's outcome already says whether the judge cleared it.
  StoryJudged: {
    line: "never",
    kind: "a judge verdict",
    digest: (event) => ({
      text: `${event.lane} judged round ${event.round}: ${event.cleared ? "cleared" : `${event.issues} issues`}`,
      lane: event.lane
    })
  },
  RoundtableTurn: { line: "never", kind: "a roundtable turn" },
  BriefReported: { line: "never", kind: "a brief report" },
  Timed: {
    line: "never",
    kind: (event) => {
      switch (event.kind) {
        case "model":
          return `the end of a ${event.label} call`
        case "tool":
          return `the end of tool ${event.label}`
        case "gate":
          return `the end of gate ${event.label}`
        case "wait":
          return `the end of a wait for the ${event.label}`
        default:
          return `the end of ${event.label}`
      }
    }
  },
  Began: {
    // A gate or a setup may run for many minutes: its start is a line, so a
    // long one reads as running, not stuck. Other work starts too often.
    line: (event, verbosity) => event.kind === "gate" && verbosity !== "Quiet",
    kind: (event) =>
      event.kind === "model"
        ? `the start of a ${event.label} call`
        : `the start of ${event.kind} ${event.label}`,
    digest: (event) => ({ text: `began ${event.kind} ${event.label}`, ...laned(event.lane) })
  },
  TasksPlanned: { line: "never", kind: other },
  TaskStarted: { line: "never", kind: other },
  TaskCompleted: { line: "never", kind: other },
  StoryStatusChanged: {
    line: "never",
    kind: other,
    digest: (event) => ({ text: `story ${event.id} ${event.status}`, lane: event.id })
  },
  CriterionChecked: {
    line: "Normal",
    kind: other,
    digest: (event) => ({ text: `criterion ${event.tag} ${event.status}`, lane: event.story })
  },
  Parked: {
    line: "Normal",
    kind: other,
    digest: (event) => ({ text: `parked ${event.item}: ${event.reason}`, lane: event.story })
  }
}

// A tag and its event are one value's, so the entry found by the tag takes
// the event. TypeScript does not correlate the two across the union; reading
// the entry through a generic key is the step that lets it.
const entryOf = <K extends FlowEventTag>(tag: K): Presentation<FlowEventByTag[K]> =>
  eventPresentation[tag]

/** The entry of an event, to apply to that event. */
export const presentationOf = (event: FlowEvent): Presentation<FlowEvent> => entryOf(event._tag)

/** The tags a digest shows: the entries with a `digest`. */
export const digestedTags: ReadonlyArray<string> = Object.entries(eventPresentation)
  .filter(([, entry]) => entry.digest !== undefined)
  .map(([tag]) => tag)
