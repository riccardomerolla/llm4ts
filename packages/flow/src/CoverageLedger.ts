import * as Schema from "effect/Schema"
import {
  BriefStatus,
  crossProblem,
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
  note: Schema.String,
  /** The epics this claim was kept against on purpose (`keep: <why>` in its brief). */
  keptAgainst: Schema.Array(Schema.String),
  /** Whether the claim still binds: false for a draft's, an overruled one, a deferral handed over. */
  standing: Schema.Boolean
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

interface Located {
  readonly epicId: string
  readonly approved: boolean
  readonly disposition: BriefDisposition
  readonly note: string
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

const trimmed = (path: string): string => path.replace(/[\\/]+$/, "")
const lastSegment = (path: string): string => trimmed(path).split(/[\\/]/).at(-1) ?? ""

/**
 * Whether two `Legacy:` paths name the same repository. The same checkout is
 * written with or without a trailing slash, and lives under another home on a
 * colleague's machine or in CI: the folder's name is what stays.
 */
export const sameLegacy = (left: string, right: string): boolean =>
  trimmed(left) === trimmed(right) ||
  (lastSegment(left).length > 0 && lastSegment(left) === lastSegment(right))

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

interface Settled {
  readonly status: LedgerStatus
  readonly owners: ReadonlyArray<string>
  readonly claims: ReadonlyArray<Claim>
}

export const buildLedger = (inputs: LedgerInputs): CoverageLedger => {
  const legacy = inputs.legacy
  const skipped = inputs.briefs
    .filter((entry) => legacy !== undefined && !sameLegacy(entry.brief.legacy, legacy))
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

  /**
   * The status the approved claims give a scenario. Deferrals bind nobody.
   * Every other pair of claims is put to `crossProblem`, the rule the
   * per-brief check uses: a clash nobody kept on purpose is a conflict;
   * shared ownership needs one `keep:`; a contradiction is settled for the
   * one brief that kept its decision, and the other claim becomes history.
   */
  const settle = (program: string, scenario: string, located: ReadonlyArray<Located>): Settled => {
    const binding = located.filter((claim) => claim.approved && claim.disposition !== "deferred")
    const deferrers = located.filter((claim) => claim.approved && claim.disposition === "deferred")
    const kept = (mine: Located, theirs: Located): boolean => {
      const brief = briefById.get(mine.epicId)
      const problem = crossProblem(program, scenario, mine.disposition, {
        epic: theirs.epicId,
        disposition: theirs.disposition
      })
      return brief !== undefined && problem !== undefined && hasOverride(brief, problem)
    }
    const keptAgainst = new Map<Located, Array<string>>()
    const overruled = new Set<Located>()
    let disputed = false
    for (let i = 0; i < binding.length; i += 1) {
      for (let j = i + 1; j < binding.length; j += 1) {
        const left = binding[i]
        const right = binding[j]
        if (left === undefined || right === undefined) continue
        if (left.epicId === right.epicId) {
          // One brief disposing of a scenario twice disagrees with itself.
          if (left.disposition !== right.disposition) disputed = true
          continue
        }
        const clash = crossProblem(program, scenario, left.disposition, {
          epic: right.epicId,
          disposition: right.disposition
        })
        if (clash === undefined) continue
        const leftKeeps = kept(left, right)
        const rightKeeps = kept(right, left)
        if (leftKeeps) keptAgainst.set(left, [...(keptAgainst.get(left) ?? []), right.epicId])
        if (rightKeeps) keptAgainst.set(right, [...(keptAgainst.get(right) ?? []), left.epicId])
        if (clash.kind === "AlreadyOwned") {
          if (!leftKeeps && !rightKeeps) disputed = true
        } else if (leftKeeps === rightKeeps) {
          // Nobody kept it, or both insist: still a contradiction.
          disputed = true
        } else {
          overruled.add(leftKeeps ? right : left)
        }
      }
    }
    const survivors = binding.filter((claim) => !overruled.has(claim))
    const conflict = disputed || (binding.length > 0 && survivors.length === 0)
    const status: LedgerStatus =
      located.filter((claim) => claim.approved).length === 0
        ? located.length === 0
          ? "unclaimed"
          : "proposed"
        : conflict
          ? "conflict"
          : (survivors[0]?.disposition ?? "deferred")
    const standing = (claim: Located): boolean =>
      !claim.approved
        ? false
        : conflict
          ? claim.disposition !== "deferred"
          : claim.disposition === "deferred"
            ? status === "deferred"
            : !overruled.has(claim)
    const owners =
      status === "conflict"
        ? unique(binding.map((claim) => claim.epicId))
        : status === "deferred"
          ? unique(deferrers.map((claim) => claim.epicId))
          : unique(survivors.map((claim) => claim.epicId))
    return {
      status,
      owners: located.filter((claim) => claim.approved).length === 0 ? [] : owners,
      claims: located.map((claim) => ({
        epicId: claim.epicId,
        approved: claim.approved,
        disposition: claim.disposition,
        note: claim.note,
        keptAgainst: keptAgainst.get(claim) ?? [],
        standing: standing(claim)
      }))
    }
  }

  const entries: Array<LedgerEntry> = []
  for (const program of inputs.pack.programs) {
    for (const scenario of program.scenarios) {
      const located = bySlot.get(`${program.name}\u0000${scenario}`) ?? []
      const { status, owners, claims } = settle(program.name, scenario, located)
      const [owner] = owners
      entries.push({
        program: program.name,
        scenario,
        status,
        claims,
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

/**
 * What approved briefs decided, scenario by scenario: the view another brief
 * inherits. Only claims that still stand: an overruled decision, or a
 * deferral another epic took up, binds nobody.
 */
export const inheritedFrom = (ledger: CoverageLedger): ReadonlyArray<InheritedDecision> =>
  ledger.entries.flatMap((entry) =>
    entry.claims
      .filter((claim) => claim.approved && claim.standing)
      .map((claim) => ({
        program: entry.program,
        scenario: entry.scenario,
        epic: claim.epicId,
        disposition: claim.disposition,
        note: claim.note,
        ...(claim.keptAgainst.length === 0 ? {} : { keptAgainst: claim.keptAgainst })
      }))
  )

// ---- The report -----------------------------------------------------------------

const percent = (part: number, whole: number): string =>
  // Floored: 299 of 300 is 99%, never a whole it has not reached.
  `${whole === 0 ? 0 : Math.floor((part / whole) * 100)}%`

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/** `142 scenarios · 96 accounted for (68%) · 58 delivered · 46 remaining · 2 conflicts`. */
export const ledgerHeadline = (ledger: CoverageLedger): string => {
  const totals = ledger.totals
  return [
    plural(totals.scenarios, "scenario"),
    `${totals.accounted} accounted for (${percent(totals.accounted, totals.scenarios)})`,
    `${totals.delivered} delivered`,
    `${totals.remaining} remaining`,
    plural(totals.conflicts, "conflict")
  ].join(" · ")
}

const deliveryWords: Readonly<Record<DeliveryState, string>> = {
  approved: "approved",
  planned: "planned",
  "in-progress": "in progress",
  landed: "landed"
}

const claimText = (claim: Claim): string =>
  `${claim.epicId}: ${dispositionWords[claim.disposition]}${claim.note.length === 0 ? "" : ` (${claim.note})`}`

const titled = (title: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length === 0 ? [] : [`## ${title}`, "", ...lines, ""]

export interface RenderLedgerOptions {
  /** The legacy repository the pack was read from. */
  readonly legacy: string
  /** Brief files that did not parse, with the first thing wrong in each. */
  readonly unreadable?: ReadonlyArray<{ readonly dir: string; readonly reason: string }>
}

/**
 * The ledger as a page a person reads: the headline, a table per program,
 * then only the lists that need someone: conflicts, scenarios still
 * deferred, unclaimed ones, what drafts propose, stale citations.
 */
export const renderLedger = (ledger: CoverageLedger, options: RenderLedgerOptions): string => {
  const of = (status: LedgerStatus): ReadonlyArray<LedgerEntry> =>
    ledger.entries.filter((entry) => entry.status === status)
  const name = (entry: LedgerEntry): string => `${entry.program} › ${entry.scenario}`
  const unclaimed = ledger.programs.flatMap((program) => {
    const open = of("unclaimed").filter((entry) => entry.program === program.program)
    return open.length === 0
      ? []
      : [`- ${program.program}: ${open.map((entry) => entry.scenario).join("; ")}`]
  })
  return [
    "# Coverage ledger",
    "",
    ledgerHeadline(ledger),
    "",
    `Legacy: ${options.legacy}`,
    "",
    "Derived from the epic briefs of this repository and the legacy extract pack. Regenerate",
    "it with `epic-design --coverage`; to change it, change a brief.",
    "",
    "## Briefs",
    "",
    ...(ledger.briefs.length === 0
      ? ["no epic brief yet"]
      : ledger.briefs.map((brief) => {
          const delivery =
            brief.delivery === undefined || brief.delivery === "approved"
              ? ""
              : `, ${deliveryWords[brief.delivery]}`
          return `- ${brief.epicId} — ${brief.status}${delivery}`
        })),
    "",
    "## Programs",
    "",
    "| Program | Scenarios | In scope | Dropped | Provided | Deferred | Proposed | Unclaimed | Conflicts | Accounted |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...ledger.programs.map(
      (program) =>
        `| ${[
          program.program,
          program.scenarios,
          program.inScope,
          program.dropped,
          program.provided,
          program.deferred,
          program.proposed,
          program.unclaimed,
          program.conflicts,
          percent(program.inScope + program.dropped + program.provided, program.scenarios)
        ].join(" | ")} |`
    ),
    "",
    ...titled(
      "Conflicts",
      of("conflict").map(
        (entry) =>
          `- ${name(entry)} — ${entry.claims
            .filter((claim) => claim.approved)
            .map(claimText)
            .join("; ")}`
      )
    ),
    ...titled(
      "Deferred, still waiting",
      of("deferred").map((entry) => {
        const claim = entry.claims.find((c) => c.approved && c.disposition === "deferred")
        return `- ${name(entry)} — deferred by ${claim?.epicId ?? entry.owners.join(", ")}${
          claim === undefined || claim.note.length === 0 ? "" : `: ${claim.note}`
        }`
      })
    ),
    ...titled("Unclaimed", unclaimed),
    ...titled(
      "Proposed by drafts",
      of("proposed").map((entry) => `- ${name(entry)} — ${entry.claims.map(claimText).join("; ")}`)
    ),
    ...titled(
      "Stale citations",
      ledger.stale.map(
        (claim) =>
          `- ${claim.epicId} cites ${claim.program} › ${claim.scenario} (${dispositionWords[claim.disposition]}), which the pack no longer has`
      )
    ),
    ...titled(
      "Skipped briefs",
      ledger.skipped.map((epicId) => `- ${epicId}`)
    ),
    ...titled(
      "Briefs that could not be read",
      (options.unreadable ?? []).map((brief) => `- ${brief.dir}: ${brief.reason}`)
    )
  ]
    .join("\n")
    .replace(/\n+$/, "\n")
}
