// The executor roster (ADR 0019): executors — a harness and a model — leased
// by role, with slots, per-role priorities, automatic and manual exclusion,
// and exclusion state that outlives a run. The roster decides WHO serves a
// call; the runner turns an executor into a seat (`RosterSeats.ts`). Only
// infrastructure signals exclude an executor: the quality of its work fails
// the work, never the executor.
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type { LlmError } from "@llm4ts/core/Errors"
import { RosterExhausted, type FlowError } from "./FlowError.ts"
import { Info, type FlowEventsShape } from "./FlowEvents.ts"
import { loadVersioned, saveVersioned, type PlainFileStoreShape } from "./Persistence.ts"
import { isOutage } from "./TransientRetry.ts"

// ---- Schemas ----------------------------------------------------------------

export const Role = Schema.Literals(["planner", "coder", "reviewer", "judge", "verifier"])
export type Role = typeof Role.Type

export const roles: ReadonlyArray<Role> = ["planner", "coder", "reviewer", "judge", "verifier"]

/** How long each exclusion lasts, as duration strings ("30 minutes"). */
export class Cooldown extends Schema.Class<Cooldown>("Cooldown")({
  usageLimit: Schema.optionalKey(Schema.String),
  rateLimit: Schema.optionalKey(Schema.String),
  outage: Schema.optionalKey(Schema.String)
}) {}

/** One executor: a harness and a model, the roles it takes, its slots and priorities. */
export class ExecutorSpec extends Schema.Class<ExecutorSpec>("ExecutorSpec")({
  id: Schema.String,
  /** A CLI harness (`pi`, `claude`, `codex`, `opencode`, …) or an API provider (`lm-studio`, …). */
  harness: Schema.String,
  model: Schema.optionalKey(Schema.String),
  flags: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Environment for the harness process; secrets only as `${VAR}` references. */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Endpoint for an API harness. */
  baseUrl: Schema.optionalKey(Schema.String),
  roles: Schema.Array(Schema.String),
  slots: Schema.optionalKey(Schema.Number),
  /** Slots coders may use; default `slots - 1` when the executor also reasons. */
  coderSlots: Schema.optionalKey(Schema.Number),
  /** Lower first. A number for every role, or per role with a `default`. */
  priority: Schema.optionalKey(
    Schema.Union([Schema.Number, Schema.Record(Schema.String, Schema.Number)])
  ),
  /** A URL that answers 2xx when the executor's serving engine is up. */
  health: Schema.optionalKey(Schema.String),
  cooldown: Schema.optionalKey(Cooldown),
  /** In a repository roster: removes the user roster's entry with this id. */
  disabled: Schema.optionalKey(Schema.Boolean)
}) {}

export class RosterDocument extends Schema.Class<RosterDocument>("RosterDocument")({
  executors: Schema.Array(ExecutorSpec)
}) {}

export const ExclusionKind = Schema.Literals(["until", "health", "run", "manual"])
export type ExclusionKind = typeof ExclusionKind.Type

/**
 * Why an executor is out of the pick-up round, and until when: `until` an
 * instant, `health` its health URL answers, `run` the end of this run,
 * `manual` an operator's resume.
 */
export class Exclusion extends Schema.Class<Exclusion>("Exclusion")({
  id: Schema.String,
  reason: Schema.String,
  kind: ExclusionKind,
  /** Epoch milliseconds; for `until`, and as the next probe time for `health`. */
  until: Schema.optionalKey(Schema.Number)
}) {}

export const RosterStateVersion = 1

export class RosterState extends Schema.Class<RosterState>("RosterState")({
  exclusions: Schema.Array(Exclusion)
}) {}

// ---- Pure helpers -------------------------------------------------------------

const reasoningRoles: ReadonlyArray<Role> = ["planner", "reviewer", "judge", "verifier"]

export const isRole = (value: string): value is Role => roles.some((role) => role === value)

export const rolesOf = (spec: ExecutorSpec): ReadonlyArray<Role> => spec.roles.filter(isRole)

export const hasRole = (spec: ExecutorSpec, role: Role): boolean => rolesOf(spec).includes(role)

export const slotsOf = (spec: ExecutorSpec): number => Math.max(1, Math.floor(spec.slots ?? 1))

/** Slots coders may hold: one stays free for reasoning on an executor that does both. */
export const coderSlotsOf = (spec: ExecutorSpec): number => {
  const slots = slotsOf(spec)
  if (spec.coderSlots !== undefined) {
    return Math.max(0, Math.min(slots, Math.floor(spec.coderSlots)))
  }
  const reasons = rolesOf(spec).some((role) => reasoningRoles.includes(role))
  return hasRole(spec, "coder") && reasons && slots > 1 ? slots - 1 : slots
}

export const priorityOf = (spec: ExecutorSpec, role: Role): number => {
  const priority = spec.priority
  if (priority === undefined) {
    return 1
  }
  if (typeof priority === "number") {
    return priority
  }
  return priority[role] ?? priority.default ?? 1
}

const units: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(ms|millis|milliseconds?)$/, 1],
  [/^(s|secs?|seconds?)$/, 1_000],
  [/^(m|mins?|minutes?)$/, 60_000],
  [/^(h|hours?)$/, 3_600_000]
]

/** "30 minutes", "90s", "2h" — the cooldown vocabulary of a roster file. */
export const parseDuration = (text: string): Duration.Duration | undefined => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(text)
  if (match === null) {
    return undefined
  }
  const amount = Number(match[1])
  const unit = (match[2] ?? "").toLowerCase()
  const scale = units.find(([pattern]) => pattern.test(unit))?.[1]
  return scale === undefined ? undefined : Duration.millis(amount * scale)
}

const durationOr = (text: string | undefined, fallback: Duration.Input): Duration.Duration =>
  (text === undefined ? undefined : parseDuration(text)) ?? Duration.fromInputUnsafe(fallback)

export const usageLimitCooldown = (spec: ExecutorSpec): Duration.Duration =>
  durationOr(spec.cooldown?.usageLimit, "30 minutes")
export const rateLimitCooldown = (spec: ExecutorSpec): Duration.Duration =>
  durationOr(spec.cooldown?.rateLimit, "10 minutes")
export const outageCooldown = (spec: ExecutorSpec): Duration.Duration =>
  durationOr(spec.cooldown?.outage, "5 minutes")

/** Rate limits in this window count towards an exclusion. */
export const rateLimitWindow = Duration.minutes(10)
/** Rate limits within the window that exclude an executor. */
export const rateLimitsToExclude = 3
/** How often a health-excluded executor is probed while someone waits. */
export const healthProbeInterval = Duration.seconds(15)

/**
 * Every violation of a roster document, in one pass: duplicate ids, unknown
 * or missing roles, impossible slot counts, unparseable cooldowns. Harness
 * checks need the connector table and live in the runner.
 */
export const rosterViolations = (document: RosterDocument): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const seen = new Set<string>()
  for (const spec of document.executors) {
    const where = `executor '${spec.id}'`
    if (spec.id.trim().length === 0) {
      violations.push("an executor has an empty id")
    }
    if (seen.has(spec.id)) {
      violations.push(`${where} is listed twice`)
    }
    seen.add(spec.id)
    if (spec.harness.trim().length === 0) {
      violations.push(`${where} has no harness`)
    }
    const unknown = spec.roles.filter((role) => !isRole(role))
    if (unknown.length > 0) {
      violations.push(
        `${where} has unknown role(s) ${unknown.join(", ")} (roles: ${roles.join(", ")})`
      )
    }
    if (rolesOf(spec).length === 0) {
      violations.push(`${where} takes no role`)
    }
    if (spec.slots !== undefined && (!Number.isInteger(spec.slots) || spec.slots < 1)) {
      violations.push(`${where} needs a whole number of slots, at least 1`)
    }
    if (
      spec.coderSlots !== undefined &&
      (!Number.isInteger(spec.coderSlots) || spec.coderSlots < 0 || spec.coderSlots > slotsOf(spec))
    ) {
      violations.push(`${where} has coderSlots outside 0..slots`)
    }
    for (const [name, text] of Object.entries(spec.cooldown ?? {})) {
      if (typeof text === "string" && parseDuration(text) === undefined) {
        violations.push(`${where} has an unreadable ${name} cooldown '${text}'`)
      }
    }
  }
  return violations
}

/**
 * A repository roster over the user's: an entry replaces the user entry
 * with the same id, `disabled: true` removes it, a new id is added.
 */
export const mergeRosterDocuments = (
  user: RosterDocument | undefined,
  repo: RosterDocument | undefined
): RosterDocument => {
  const merged = new Map<string, ExecutorSpec>()
  for (const spec of user?.executors ?? []) {
    merged.set(spec.id, spec)
  }
  for (const spec of repo?.executors ?? []) {
    merged.set(spec.id, spec)
  }
  return RosterDocument.make({
    executors: [...merged.values()].filter((spec) => spec.disabled !== true)
  })
}

/** Only the named executors (`--executors a,b`); an empty list keeps all. */
export const narrowRoster = (
  document: RosterDocument,
  ids: ReadonlyArray<string>
): RosterDocument =>
  ids.length === 0
    ? document
    : RosterDocument.make({
        executors: document.executors.filter((spec) => ids.includes(spec.id))
      })

const describeUntil = (until: number): string => new Date(until).toISOString()

/**
 * The exclusion a failure earns, or none. `recentRateLimits` holds the
 * executor's rate-limit instants inside the window, this one included.
 */
export const exclusionFor = (
  error: LlmError,
  spec: ExecutorSpec,
  now: number,
  recentRateLimits: number
): Exclusion | undefined => {
  switch (error._tag) {
    case "UsageLimitError": {
      const reset = error.resetAt === undefined ? undefined : error.resetAt.epochMilliseconds
      const until =
        reset !== undefined && reset > now
          ? reset
          : now + Duration.toMillis(usageLimitCooldown(spec))
      return Exclusion.make({
        id: spec.id,
        kind: "until",
        until,
        reason: `usage limit (${error.message.slice(0, 160)})`
      })
    }
    case "RateLimitError":
      return recentRateLimits >= rateLimitsToExclude
        ? Exclusion.make({
            id: spec.id,
            kind: "until",
            until: now + Duration.toMillis(rateLimitCooldown(spec)),
            reason: `${recentRateLimits} rate limits within ${Duration.format(rateLimitWindow)}`
          })
        : undefined
    case "AuthenticationError":
      return Exclusion.make({
        id: spec.id,
        kind: "run",
        reason: `not signed in (${error.message.slice(0, 160)})`
      })
    case "ProviderError":
      if (!isOutage(error)) {
        return undefined
      }
      return spec.health === undefined
        ? Exclusion.make({
            id: spec.id,
            kind: "until",
            until: now + Duration.toMillis(outageCooldown(spec)),
            reason: `serving engine down (${error.message.slice(0, 160)})`
          })
        : Exclusion.make({
            id: spec.id,
            kind: "health",
            until: now,
            reason: `serving engine down (${error.message.slice(0, 160)})`
          })
    default:
      return undefined
  }
}

export const describeExclusion = (exclusion: Exclusion): string => {
  switch (exclusion.kind) {
    case "until":
      return `until ${exclusion.until === undefined ? "?" : describeUntil(exclusion.until)}: ${exclusion.reason}`
    case "health":
      return `until its health check answers: ${exclusion.reason}`
    case "run":
      return `for this run: ${exclusion.reason}`
    case "manual":
      return `paused${exclusion.until === undefined ? "" : ` until ${describeUntil(exclusion.until)}`}: ${exclusion.reason}`
  }
}

// ---- Persisted state -----------------------------------------------------------

export interface RosterStateStoreShape {
  readonly load: Effect.Effect<ReadonlyArray<Exclusion>, FlowError>
  /** Replaces the entries of `ids` with `exclusions`, keeping everyone else's. */
  readonly save: (
    ids: ReadonlyArray<string>,
    exclusions: ReadonlyArray<Exclusion>
  ) => Effect.Effect<void, FlowError>
}

/** Only exclusions that outlive a run are written; expired ones are dropped on load. */
const persisted = (exclusion: Exclusion): boolean => exclusion.kind !== "run"

export const makeRosterStateStore = (
  files: PlainFileStoreShape,
  path: string
): RosterStateStoreShape => {
  const read = Effect.gen(function* () {
    const state = yield* loadVersioned(files, path, RosterStateVersion, RosterState)
    const now = yield* Clock.currentTimeMillis
    return (state?.exclusions ?? []).filter(
      (exclusion) =>
        persisted(exclusion) &&
        !(exclusion.kind === "until" && (exclusion.until ?? 0) <= now) &&
        !(exclusion.kind === "manual" && exclusion.until !== undefined && exclusion.until <= now)
    )
  })
  return {
    load: read,
    save: (ids, exclusions) =>
      Effect.gen(function* () {
        const others = (yield* read).filter((exclusion) => !ids.includes(exclusion.id))
        yield* saveVersioned(
          files,
          path,
          RosterStateVersion,
          RosterState,
          RosterState.make({ exclusions: [...others, ...exclusions.filter(persisted)] })
        )
      })
  }
}

// ---- The roster ------------------------------------------------------------------

export interface Lease {
  readonly executor: ExecutorSpec
  readonly role: Role
  /** Frees the slot; idempotent, and also run when the lease's scope closes. */
  readonly release: Effect.Effect<void>
}

export interface LeaseOptions {
  /** Executors this lease must not use (independence, or a handover away from one). */
  readonly avoid?: ReadonlyArray<string>
  /** Taken first while free: the executor a resumed context held before. */
  readonly prefer?: string
  /** Who is asking, for the events (a story's worktree). */
  readonly label?: string
}

export interface ExecutorStatus {
  readonly executor: ExecutorSpec
  readonly busy: number
  readonly busyCoders: number
  readonly exclusion?: Exclusion
}

export interface RosterShape {
  readonly executors: ReadonlyArray<ExecutorSpec>
  /** Waits for a slot; fails `RosterExhausted` when none can ever come. */
  readonly lease: (
    role: Role,
    options?: LeaseOptions
  ) => Effect.Effect<Lease, RosterExhausted, Scope.Scope>
  /** A slot now, or `undefined`. */
  readonly tryLease: (
    role: Role,
    options?: LeaseOptions
  ) => Effect.Effect<Lease | undefined, never, Scope.Scope>
  /** Whether an executor outside `avoid` has the role and is not out for the run. */
  readonly canEverServe: (role: Role, avoid?: ReadonlyArray<string>) => Effect.Effect<boolean>
  /** Free slots for `role` now, across executors in the round. */
  readonly available: (role: Role) => Effect.Effect<number>
  /** Configured slots for `role`. */
  readonly slots: (role: Role) => number
  /** Classifies a failure of `id`'s call; returns the exclusion it earned, if any. */
  readonly report: (id: string, error: LlmError) => Effect.Effect<Exclusion | undefined>
  readonly exclude: (exclusion: Exclusion) => Effect.Effect<void>
  readonly resume: (id: string) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<ReadonlyArray<ExecutorStatus>>
}

export interface RosterOptions {
  readonly executors: ReadonlyArray<ExecutorSpec>
  readonly events: FlowEventsShape
  /** Exclusions that outlive a run; omit to keep them in memory. */
  readonly state?: RosterStateStoreShape
  /** Answers whether a health URL is up; omit and `health` exclusions wait out the outage cooldown. */
  readonly probe?: (url: string) => Effect.Effect<boolean>
}

interface Usage {
  busy: number
  busyCoders: number
}

export const makeRoster = Effect.fn("@llm4ts/flow/Roster.make")(function* (
  options: RosterOptions
): Effect.fn.Return<RosterShape, FlowError> {
  const { executors, events } = options
  const lock = yield* Semaphore.make(1)
  const usage = new Map<string, Usage>(
    executors.map((spec) => [spec.id, { busy: 0, busyCoders: 0 }])
  )
  const exclusions = new Map<string, Exclusion>()
  const rateLimits = new Map<string, ReadonlyArray<number>>()
  const lastLeased = new Map<string, number>()
  let leases = 0
  const changed = yield* Ref.make(yield* Deferred.make<void>())
  const known = new Set(executors.map((spec) => spec.id))

  for (const exclusion of options.state === undefined ? [] : yield* options.state.load) {
    if (known.has(exclusion.id)) {
      exclusions.set(exclusion.id, exclusion)
    }
  }

  const say = (message: string): Effect.Effect<void> =>
    events.publish(Info.make({ message: `roster: ${message}` }))

  const signal: Effect.Effect<void> = Effect.gen(function* () {
    const next = yield* Deferred.make<void>()
    const previous = yield* Ref.getAndSet(changed, next)
    yield* Deferred.succeed(previous, undefined)
  })

  // Suspended: the exclusions are read when the save runs, not when it is built.
  const persist: Effect.Effect<void> = Effect.suspend(() =>
    options.state === undefined
      ? Effect.void
      : options.state
          .save(
            executors.map((spec) => spec.id),
            [...exclusions.values()]
          )
          .pipe(Effect.catch((error) => say(`could not save the roster state: ${error.message}`)))
  )

  /** Ends every exclusion whose time has come; returns the ids that came back. */
  const expire = (now: number): ReadonlyArray<string> => {
    const back: Array<string> = []
    for (const [id, exclusion] of exclusions) {
      const timed = exclusion.kind === "until" || exclusion.kind === "manual"
      if (timed && exclusion.until !== undefined && exclusion.until <= now) {
        exclusions.delete(id)
        back.push(id)
      }
    }
    return back
  }

  const freeFor = (spec: ExecutorSpec, role: Role): boolean => {
    const used = usage.get(spec.id) ?? { busy: 0, busyCoders: 0 }
    if (used.busy >= slotsOf(spec)) {
      return false
    }
    return role !== "coder" || used.busyCoders < coderSlotsOf(spec)
  }

  const eligible = (role: Role, avoid: ReadonlyArray<string>): ReadonlyArray<ExecutorSpec> =>
    executors.filter(
      (spec) => hasRole(spec, role) && !avoid.includes(spec.id) && !exclusions.has(spec.id)
    )

  const pick = (role: Role, leaseOptions: LeaseOptions): ExecutorSpec | undefined => {
    const avoid = leaseOptions.avoid ?? []
    const candidates = eligible(role, avoid).filter((spec) => freeFor(spec, role))
    const preferred = candidates.find((spec) => spec.id === leaseOptions.prefer)
    if (preferred !== undefined) {
      return preferred
    }
    return [...candidates].sort(
      (left, right) =>
        priorityOf(left, role) - priorityOf(right, role) ||
        (lastLeased.get(left.id) ?? -1) - (lastLeased.get(right.id) ?? -1)
    )[0]
  }

  const release = (spec: ExecutorSpec, role: Role): Effect.Effect<void> =>
    lock
      .withPermit(
        Effect.sync(() => {
          const used = usage.get(spec.id)
          if (used !== undefined) {
            used.busy = Math.max(0, used.busy - 1)
            if (role === "coder") {
              used.busyCoders = Math.max(0, used.busyCoders - 1)
            }
          }
        })
      )
      .pipe(Effect.andThen(signal))

  const leaseOf = (spec: ExecutorSpec, role: Role): Effect.Effect<Lease, never, Scope.Scope> =>
    Effect.gen(function* () {
      const done = yield* Ref.make(false)
      const free = Effect.flatMap(Ref.getAndSet(done, true), (was) =>
        was ? Effect.void : release(spec, role)
      )
      yield* Effect.addFinalizer(() => free)
      return { executor: spec, role, release: free }
    })

  /** One attempt: expire, pick, take the slot — all under the lock. */
  const attempt = (
    role: Role,
    leaseOptions: LeaseOptions
  ): Effect.Effect<ExecutorSpec | undefined> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const { spec, back } = yield* lock.withPermit(
        Effect.sync(() => {
          const back = expire(now)
          const spec = pick(role, leaseOptions)
          if (spec !== undefined) {
            const used = usage.get(spec.id)
            if (used !== undefined) {
              used.busy += 1
              if (role === "coder") {
                used.busyCoders += 1
              }
            }
            leases += 1
            lastLeased.set(spec.id, leases)
          }
          return { spec, back }
        })
      )
      if (back.length > 0) {
        yield* say(`${back.join(", ")} back in the round`)
        yield* persist
      }
      return spec
    })

  const canEverServe = (role: Role, avoid: ReadonlyArray<string> = []): Effect.Effect<boolean> =>
    lock.withPermit(
      Effect.sync(() =>
        executors.some(
          (spec) =>
            hasRole(spec, role) &&
            !avoid.includes(spec.id) &&
            exclusions.get(spec.id)?.kind !== "run"
        )
      )
    )

  /** Probes every `health` exclusion whose next probe is due; a live one comes back. */
  const probeDue: Effect.Effect<void> = Effect.gen(function* () {
    const probe = options.probe
    const now = yield* Clock.currentTimeMillis
    const due = yield* lock.withPermit(
      Effect.sync(() =>
        [...exclusions.values()].filter(
          (exclusion) => exclusion.kind === "health" && (exclusion.until ?? 0) <= now
        )
      )
    )
    for (const exclusion of due) {
      const spec = executors.find((candidate) => candidate.id === exclusion.id)
      const url = spec?.health
      const up =
        probe === undefined || url === undefined
          ? // Nothing to probe: the outage cooldown decides, measured from now.
            false
          : yield* probe(url)
      yield* lock.withPermit(
        Effect.sync(() => {
          if (up) {
            exclusions.delete(exclusion.id)
          } else if (probe === undefined || url === undefined) {
            exclusions.set(
              exclusion.id,
              Exclusion.make({
                ...exclusion,
                kind: "until",
                until:
                  now +
                  Duration.toMillis(spec === undefined ? Duration.minutes(5) : outageCooldown(spec))
              })
            )
          } else {
            exclusions.set(
              exclusion.id,
              Exclusion.make({ ...exclusion, until: now + Duration.toMillis(healthProbeInterval) })
            )
          }
        })
      )
      if (up) {
        yield* say(`${exclusion.id} answers its health check again; back in the round`)
        yield* persist
        yield* signal
      }
    }
  })

  /** Sleeps until something that could free a slot happens. */
  const waitForChange = (role: Role): Effect.Effect<void> =>
    Effect.gen(function* () {
      const wake = yield* Ref.get(changed)
      const now = yield* Clock.currentTimeMillis
      const deadlines = yield* lock.withPermit(
        Effect.sync(() =>
          [...exclusions.values()]
            .filter((exclusion) => {
              const spec = executors.find((candidate) => candidate.id === exclusion.id)
              return spec !== undefined && hasRole(spec, role) && exclusion.kind !== "run"
            })
            .flatMap((exclusion) =>
              exclusion.until === undefined ? [] : [Math.max(0, exclusion.until - now)]
            )
        )
      )
      const soonest = deadlines.length === 0 ? undefined : Math.min(...deadlines)
      yield* soonest === undefined
        ? Deferred.await(wake)
        : Effect.raceFirst(Deferred.await(wake), Effect.sleep(Duration.millis(soonest)))
    })

  const waitingReport = (role: Role, avoid: ReadonlyArray<string>): Effect.Effect<string> =>
    lock.withPermit(
      Effect.sync(() =>
        executors
          .filter((spec) => hasRole(spec, role) && !avoid.includes(spec.id))
          .map((spec) => {
            const exclusion = exclusions.get(spec.id)
            return exclusion === undefined
              ? `${spec.id} busy`
              : `${spec.id} ${describeExclusion(exclusion)}`
          })
          .join("; ")
      )
    )

  const lease = (
    role: Role,
    leaseOptions: LeaseOptions = {}
  ): Effect.Effect<Lease, RosterExhausted, Scope.Scope> =>
    Effect.gen(function* () {
      const avoid = leaseOptions.avoid ?? []
      let announced = false
      while (true) {
        const spec = yield* attempt(role, leaseOptions)
        if (spec !== undefined) {
          yield* say(
            `${spec.id} takes ${role}${leaseOptions.label === undefined ? "" : ` for ${leaseOptions.label}`}`
          )
          return yield* leaseOf(spec, role)
        }
        if (!(yield* canEverServe(role, avoid))) {
          const reasons = yield* lock.withPermit(
            Effect.sync(() =>
              executors
                .filter((spec) => hasRole(spec, role) && !avoid.includes(spec.id))
                .map((spec) => {
                  const exclusion = exclusions.get(spec.id)
                  return `${spec.id} ${exclusion === undefined ? "unavailable" : describeExclusion(exclusion)}`
                })
            )
          )
          return yield* RosterExhausted.make({
            role,
            reasons: reasons.length === 0 ? ["no executor in the roster takes this role"] : reasons
          })
        }
        if (!announced) {
          announced = true
          yield* say(
            `waiting for an executor to take ${role}${leaseOptions.label === undefined ? "" : ` for ${leaseOptions.label}`}: ${yield* waitingReport(role, avoid)}`
          )
        }
        yield* probeDue
        const recovered = yield* attempt(role, leaseOptions)
        if (recovered !== undefined) {
          yield* say(
            `${recovered.id} takes ${role}${leaseOptions.label === undefined ? "" : ` for ${leaseOptions.label}`}`
          )
          return yield* leaseOf(recovered, role)
        }
        const probing = yield* lock.withPermit(
          Effect.sync(() =>
            [...exclusions.values()].some((exclusion) => exclusion.kind === "health")
          )
        )
        yield* probing
          ? Effect.raceFirst(waitForChange(role), Effect.sleep(healthProbeInterval))
          : waitForChange(role)
      }
    })

  const tryLease = (
    role: Role,
    leaseOptions: LeaseOptions = {}
  ): Effect.Effect<Lease | undefined, never, Scope.Scope> =>
    Effect.flatMap(attempt(role, leaseOptions), (spec) =>
      spec === undefined ? Effect.succeed(undefined) : leaseOf(spec, role)
    )

  const exclude = (exclusion: Exclusion): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!known.has(exclusion.id)) {
        return
      }
      yield* lock.withPermit(Effect.sync(() => exclusions.set(exclusion.id, exclusion)))
      yield* say(`${exclusion.id} out of the round ${describeExclusion(exclusion)}`)
      yield* persist
      yield* signal
    })

  const report = (id: string, error: LlmError): Effect.Effect<Exclusion | undefined> =>
    Effect.gen(function* () {
      const spec = executors.find((candidate) => candidate.id === id)
      if (spec === undefined) {
        return undefined
      }
      const now = yield* Clock.currentTimeMillis
      const windowStart = now - Duration.toMillis(rateLimitWindow)
      const recent =
        error._tag === "RateLimitError"
          ? yield* lock.withPermit(
              Effect.sync(() => {
                const kept = [...(rateLimits.get(id) ?? []).filter((at) => at > windowStart), now]
                rateLimits.set(id, kept)
                return kept.length
              })
            )
          : 0
      const exclusion = exclusionFor(error, spec, now, recent)
      if (exclusion !== undefined) {
        if (error._tag === "RateLimitError") {
          yield* lock.withPermit(Effect.sync(() => rateLimits.delete(id)))
        }
        yield* exclude(exclusion)
      }
      return exclusion
    })

  const resume = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const removed = yield* lock.withPermit(Effect.sync(() => exclusions.delete(id)))
      if (removed) {
        yield* say(`${id} resumed`)
        yield* persist
        yield* signal
      }
    })

  const available = (role: Role): Effect.Effect<number> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* lock.withPermit(
        Effect.sync(() => {
          expire(now)
          return eligible(role, []).reduce((sum, spec) => {
            const used = usage.get(spec.id) ?? { busy: 0, busyCoders: 0 }
            const free =
              role === "coder"
                ? Math.min(slotsOf(spec) - used.busy, coderSlotsOf(spec) - used.busyCoders)
                : slotsOf(spec) - used.busy
            return sum + Math.max(0, free)
          }, 0)
        })
      )
    })

  const slots = (role: Role): number =>
    executors
      .filter((spec) => hasRole(spec, role))
      .reduce((sum, spec) => sum + (role === "coder" ? coderSlotsOf(spec) : slotsOf(spec)), 0)

  const snapshot: Effect.Effect<ReadonlyArray<ExecutorStatus>> = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* lock.withPermit(
      Effect.sync(() => {
        expire(now)
        return executors.map((spec) => {
          const used = usage.get(spec.id) ?? { busy: 0, busyCoders: 0 }
          const exclusion = exclusions.get(spec.id)
          return {
            executor: spec,
            busy: used.busy,
            busyCoders: used.busyCoders,
            ...(exclusion === undefined ? {} : { exclusion })
          }
        })
      })
    )
  })

  return {
    executors,
    lease,
    tryLease,
    canEverServe,
    available,
    slots,
    report,
    exclude,
    resume,
    snapshot
  }
})
