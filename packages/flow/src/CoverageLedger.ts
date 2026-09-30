import * as Schema from "effect/Schema"
import {
  BriefStatus,
  dispositionWords,
  hasOverride,
  type BriefDisposition,
  type EpicBrief,
  type InheritedDecision,
  type PackIndex
} from "./EpicBrief.ts"

/**
 * The coverage ledger: what the epic briefs of a target repository have
 * decided about a legacy extract pack, scenario by scenario. It is derived,
 * never state: a pure function of the pack, the briefs and the epics'
 * recorded progress. The report, the context the next brief inherits and the
 * checks across briefs all read it. Only approved briefs bind; a draft's
 * claims are shown as proposed.
 */

const Disposition = Schema.Literals(["in-scope", "dropped", "provided", "deferred"])

/** One brief's word on one scenario. */
export const Claim = Schema.Struct({
  epicId: Schema.String,
  /** Whether the brief is approved; a draft's claim binds nothing. */
  approved: Schema.Boolean,
  disposition: Disposition,
  /** The in-scope item's title, the reason, the pointer or the deferral note. */
  note: Schema.String
})
export type Claim = typeof Claim.Type

export const LedgerStatus = Schema.Literals([
  "unclaimed",
  "in-scope",
  "dropped",
  "provided",
  "deferred",
  "proposed",
  "conflict"
])
export type LedgerStatus = typeof LedgerStatus.Type

/** How far the owning epic is: brief approved, planned, stories merging, landed. */
export const DeliveryState = Schema.Literals(["approved", "planned", "in-progress", "landed"])
export type DeliveryState = typeof DeliveryState.Type

export const LedgerEntry = Schema.Struct({
  program: Schema.String,
  scenario: Schema.String,
  status: LedgerStatus,
  /** Every claim on the scenario, approved or not, in brief order. */
  claims: Schema.Array(Claim),
  /** The approved epics behind the status; both sides of a conflict. */
  owners: Schema.Array(Schema.String),
  /** In-scope entries only: the owning epic's delivery state. */
  delivery: Schema.optionalKey(DeliveryState)
})
export type LedgerEntry = typeof LedgerEntry.Type

export const ProgramTotals = Schema.Struct({
  program: Schema.String,
  scenarios: Schema.Int,
  inScope: Schema.Int,
  dropped: Schema.Int,
  provided: Schema.Int,
  deferred: Schema.Int,
  proposed: Schema.Int,
  unclaimed: Schema.Int,
  conflicts: Schema.Int
})
export type ProgramTotals = typeof ProgramTotals.Type

/** A claim on a program or scenario the pack no longer has. */
export const StaleClaim = Schema.Struct({
  epicId: Schema.String,
  program: Schema.String,
  scenario: Schema.String,
  disposition: Disposition
})
export type StaleClaim = typeof StaleClaim.Type

export const LedgerBriefInfo = Schema.Struct({
  epicId: Schema.String,
  status: BriefStatus,
  delivery: Schema.optionalKey(DeliveryState)
})
export type LedgerBriefInfo = typeof LedgerBriefInfo.Type

export const CoverageLedger = Schema.Struct({
  entries: Schema.Array(LedgerEntry),
  programs: Schema.Array(ProgramTotals),
  stale: Schema.Array(StaleClaim),
  /** Briefs designed against another legacy repository than the pack in hand. */
  skipped: Schema.Array(Schema.String),
  briefs: Schema.Array(LedgerBriefInfo),
  totals: Schema.Struct({
    scenarios: Schema.Int,
    /** Decided: in scope, dropped or provided by an approved brief. */
    accounted: Schema.Int,
    /** Dropped, provided, or in scope in an epic that landed. */
    delivered: Schema.Int,
    /** Unclaimed, deferred, only proposed, or in conflict. */
    remaining: Schema.Int,
    conflicts: Schema.Int
  })
})
export type CoverageLedger = typeof CoverageLedger.Type

export interface LedgerBrief {
  /** The epic's folder name. */
  readonly epicId: string
  readonly brief: EpicBrief
}

/** What `epic-stories` recorded for an epic. */
export interface EpicProgress {
  readonly epicId: string
  readonly planned: boolean
  readonly stories: number
  readonly merged: number
  readonly landed: boolean
}

export interface LedgerInputs {
  readonly pack: PackIndex
  readonly briefs: ReadonlyArray<LedgerBrief>
  readonly epics: ReadonlyArray<EpicProgress>
  /** The legacy repository the pack came from; briefs naming another are skipped. */
  readonly legacy?: string
}

interface Located extends Claim {
  readonly program: string
  readonly scenario: string
}

const claimsOf = (epicId: string, brief: EpicBrief): ReadonlyArray<Located> => {
  const approved = brief.status === "approved"
  const disposed = (
    disposition: BriefDisposition,
    entries: EpicBrief["dropped"]
  ): ReadonlyArray<Located> =>
    entries.map((entry) => ({
      epicId,
      approved,
      disposition,
      note: entry.note,
      program: entry.program,
      scenario: entry.scenario
    }))
  return [
    ...brief.scope.flatMap((item) =>
      item.citations.map(
        (citation): Located => ({
          epicId,
          approved,
          disposition: "in-scope",
          note: item.title,
          program: citation.program,
          scenario: citation.scenario
        })
      )
    ),
    ...disposed("dropped", brief.dropped),
    ...disposed("provided", brief.provided),
    ...disposed("deferred", brief.deferred)
  ]
}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

const deliveryOf = (progress: EpicProgress | undefined): DeliveryState =>
  progress === undefined
    ? "approved"
    : progress.landed
      ? "landed"
      : progress.merged > 0
        ? "in-progress"
        : progress.planned
          ? "planned"
          : "approved"

export const buildLedger = (inputs: LedgerInputs): CoverageLedger => {
  const skipped = inputs.briefs
    .filter((entry) => inputs.legacy !== undefined && entry.brief.legacy !== inputs.legacy)
    .map((entry) => entry.epicId)
  const read = inputs.briefs.filter((entry) => !skipped.includes(entry.epicId))
  const briefById = new Map(read.map((entry) => [entry.epicId, entry.brief]))
  const progressById = new Map(inputs.epics.map((epic) => [epic.epicId, epic]))
  const known = new Map(inputs.pack.programs.map((program) => [program.name, program.scenarios]))

  const bySlot = new Map<string, Array<Located>>()
  const stale: Array<StaleClaim> = []
  for (const entry of read) {
    for (const claim of claimsOf(entry.epicId, entry.brief)) {
      if (!(known.get(claim.program) ?? []).includes(claim.scenario)) {
        stale.push({
          epicId: claim.epicId,
          program: claim.program,
          scenario: claim.scenario,
          disposition: claim.disposition
        })
        continue
      }
      const key = `${claim.program}\u0000${claim.scenario}`
      bySlot.set(key, [...(bySlot.get(key) ?? []), claim])
    }
  }

  /** The status the approved claims give a scenario, and the epics behind it. */
  const settle = (
    program: string,
    scenario: string,
    claims: ReadonlyArray<Located>
  ): { readonly status: LedgerStatus; readonly owners: ReadonlyArray<string> } => {
    const approved = claims.filter((claim) => claim.approved)
    if (approved.length === 0) {
      return { status: claims.length === 0 ? "unclaimed" : "proposed", owners: [] }
    }
    const epicsWith = (disposition: BriefDisposition): ReadonlyArray<string> =>
      unique(approved.filter((c) => c.disposition === disposition).map((c) => c.epicId))
    const owners = epicsWith("in-scope")
    const droppers = epicsWith("dropped")
    const providers = epicsWith("provided")
    if (owners.length > 0) {
      const kept = (owner: string, other: string, disposition: BriefDisposition): boolean => {
        const brief = briefById.get(owner)
        if (brief === undefined) return false
        return disposition === "in-scope"
          ? hasOverride(brief, { kind: "AlreadyOwned", program, scenario, epic: other })
          : hasOverride(brief, {
              kind: "ContradictsBrief",
              program,
              scenario,
              epic: other,
              here: dispositionWords["in-scope"],
              disposition: dispositionWords[disposition]
            })
      }
      // Several owners are fine only when one of them kept it on purpose.
      const shared =
        owners.length === 1 ||
        owners.some((owner) =>
          owners.some((other) => other !== owner && kept(owner, other, "in-scope"))
        )
      const against = [
        ...droppers.map((epic) => ({ epic, disposition: "dropped" as const })),
        ...providers.map((epic) => ({ epic, disposition: "provided" as const }))
      ].filter((other) => !owners.includes(other.epic))
      const overruled = against.every((other) =>
        owners.some((owner) => kept(owner, other.epic, other.disposition))
      )
      return shared && overruled
        ? { status: "in-scope", owners }
        : { status: "conflict", owners: unique([...owners, ...against.map((o) => o.epic)]) }
    }
    if (droppers.length > 0 && providers.length > 0) {
      return { status: "conflict", owners: unique([...droppers, ...providers]) }
    }
    if (droppers.length > 0) return { status: "dropped", owners: droppers }
    if (providers.length > 0) return { status: "provided", owners: providers }
    return { status: "deferred", owners: epicsWith("deferred") }
  }

  const entries: Array<LedgerEntry> = []
  for (const program of inputs.pack.programs) {
    for (const scenario of program.scenarios) {
      const located = bySlot.get(`${program.name}\u0000${scenario}`) ?? []
      const { status, owners } = settle(program.name, scenario, located)
      const [owner] = owners
      entries.push({
        program: program.name,
        scenario,
        status,
        claims: located.map((claim) => ({
          epicId: claim.epicId,
          approved: claim.approved,
          disposition: claim.disposition,
          note: claim.note
        })),
        owners,
        ...(status === "in-scope" && owner !== undefined
          ? { delivery: deliveryOf(progressById.get(owner)) }
          : {})
      })
    }
  }

  const count = (list: ReadonlyArray<LedgerEntry>, status: LedgerStatus): number =>
    list.filter((entry) => entry.status === status).length
  const programs = inputs.pack.programs.map((program): ProgramTotals => {
    const own = entries.filter((entry) => entry.program === program.name)
    return {
      program: program.name,
      scenarios: own.length,
      inScope: count(own, "in-scope"),
      dropped: count(own, "dropped"),
      provided: count(own, "provided"),
      deferred: count(own, "deferred"),
      proposed: count(own, "proposed"),
      unclaimed: count(own, "unclaimed"),
      conflicts: count(own, "conflict")
    }
  })
  const accounted =
    count(entries, "in-scope") + count(entries, "dropped") + count(entries, "provided")
  return {
    entries,
    programs,
    stale,
    skipped,
    briefs: read.map((entry) => ({
      epicId: entry.epicId,
      status: entry.brief.status,
      ...(entry.brief.status === "approved"
        ? { delivery: deliveryOf(progressById.get(entry.epicId)) }
        : {})
    })),
    totals: {
      scenarios: entries.length,
      accounted,
      delivered:
        count(entries, "dropped") +
        count(entries, "provided") +
        entries.filter((entry) => entry.status === "in-scope" && entry.delivery === "landed")
          .length,
      remaining: entries.length - accounted,
      conflicts: count(entries, "conflict")
    }
  }
}

/** What approved briefs decided, scenario by scenario: the view another brief inherits. */
export const inheritedFrom = (ledger: CoverageLedger): ReadonlyArray<InheritedDecision> =>
  ledger.entries.flatMap((entry) =>
    entry.claims
      .filter((claim) => claim.approved)
      .map((claim) => ({
        program: entry.program,
        scenario: entry.scenario,
        epic: claim.epicId,
        disposition: claim.disposition,
        note: claim.note
      }))
  )
