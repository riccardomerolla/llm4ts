import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { CheckoutBusy, PersistenceError } from "./FlowError.ts"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "./Persistence.ts"

/**
 * One writing run per checkout, across processes (ADR 0058). The flow process
 * itself holds a lock file outside the checkout for as long as it runs, so a
 * run started from a terminal, from the operator server or from anything
 * else is refused while another one writes.
 *
 * The file names the run's pid and the process groups of the children it has
 * running. A lock whose run is gone still holds while one of those groups is
 * alive: a coding agent that outlived a killed flow keeps writing.
 */
export class WriterHolder extends Schema.Class<WriterHolder>("WriterHolder")({
  pid: Schema.Int,
  runId: Schema.String,
  flow: Schema.optionalKey(Schema.String),
  workDir: Schema.String,
  startedAt: Schema.Number,
  /** Process groups of the children the run has running right now. */
  groups: Schema.Array(Schema.Int)
}) {}

const decodeHolder = Schema.decodeUnknownOption(Schema.fromJsonString(WriterHolder))
const encodeHolder = Schema.encodeSync(Schema.fromJsonString(WriterHolder))

/** What the lock needs from the machine; the Node host is in the runner. */
export interface WriterLockHost {
  readonly files: PlainFileStoreShape
  /** Creates the file with its contents only when it does not exist; false when it does. */
  readonly createExclusive: (
    path: string,
    contents: string
  ) => Effect.Effect<boolean, PersistenceError>
  readonly isAlive: (pid: number) => boolean
  /** True while any process of the group `pgid` leads is alive. */
  readonly groupAlive: (pgid: number) => boolean
  /** This process. */
  readonly pid: number
}

export interface WriterLockRequest {
  /** The lock file of the checkout. */
  readonly path: string
  readonly workDir: string
  readonly runId: string
  readonly flow?: string
  readonly startedAt: number
}

export interface HeldWriterLock {
  /** Records the process groups of the children running now. */
  readonly setGroups: (groups: ReadonlyArray<number>) => Effect.Effect<void>
}

/** Who holds a checkout: its run, or only processes that run left behind. */
export interface LiveHolder {
  readonly holder: WriterHolder
  readonly alive: "run" | "children"
  readonly groups: ReadonlyArray<number>
}

export interface WriterLockShape {
  /** Holds the checkout until the scope closes; `CheckoutBusy` when another run has it. */
  readonly hold: (
    request: WriterLockRequest
  ) => Effect.Effect<HeldWriterLock, CheckoutBusy | PersistenceError, Scope.Scope>
  /** The live holder of a lock file, if any. */
  readonly holder: (path: string) => Effect.Effect<LiveHolder | undefined, PersistenceError>
}

export const checkoutBusy = (path: string, live: LiveHolder): CheckoutBusy =>
  CheckoutBusy.make({
    workDir: live.holder.workDir,
    lockPath: path,
    pid: live.holder.pid,
    runId: live.holder.runId,
    alive: live.alive,
    groups: live.groups,
    ...(live.holder.flow === undefined ? {} : { flow: live.holder.flow })
  })

const guardStepMs = 25
const guardAttempts = 200

export const makeWriterLock = (host: WriterLockHost): WriterLockShape => {
  const readHolder = (path: string) =>
    host.files
      .read(path)
      .pipe(
        Effect.map((text) =>
          text === undefined ? undefined : Option.getOrUndefined(decodeHolder(text))
        )
      )

  const liveOf = (holder: WriterHolder | undefined): LiveHolder | undefined => {
    if (holder === undefined) return undefined
    if (host.isAlive(holder.pid)) return { holder, alive: "run", groups: [] }
    const groups = holder.groups.filter((group) => host.groupAlive(group))
    return groups.length === 0 ? undefined : { holder, alive: "children", groups }
  }

  // Check-and-take must be one step across processes. A guard file, created
  // exclusively, serializes it; a guard whose process is gone is removed.
  const takeGuard = (guard: string): Effect.Effect<void, PersistenceError> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < guardAttempts; attempt++) {
        if (yield* host.createExclusive(guard, String(host.pid))) return
        const owner = Number((yield* host.files.read(guard)) ?? "")
        if (!Number.isInteger(owner) || !host.isAlive(owner)) {
          yield* host.files.remove(guard)
        } else {
          yield* Effect.sleep(guardStepMs)
        }
      }
      return yield* PersistenceError.make({
        message: `could not take ${guard}: another llm4ts process holds it; remove the file if none is starting`
      })
    })

  const guarded = <A, E>(path: string, body: Effect.Effect<A, E>) => {
    const guard = `${path}.guard`
    return Effect.acquireUseRelease(
      takeGuard(guard),
      () => body,
      () => Effect.ignore(host.files.remove(guard))
    )
  }

  const hold: WriterLockShape["hold"] = (request) => {
    const mine = (groups: ReadonlyArray<number>): string =>
      encodeHolder(
        new WriterHolder({
          pid: host.pid,
          runId: request.runId,
          workDir: request.workDir,
          startedAt: request.startedAt,
          groups: [...groups],
          ...(request.flow === undefined ? {} : { flow: request.flow })
        })
      )
    const take = guarded(
      request.path,
      Effect.gen(function* () {
        const current = yield* readHolder(request.path)
        // A run nested in this process shares the outer run's hold.
        if (current?.pid === host.pid) return false
        const live = liveOf(current)
        if (live !== undefined) return yield* checkoutBusy(request.path, live)
        yield* host.files.writeAtomic(request.path, mine([]))
        return true
      })
    )
    const release = (owned: boolean) =>
      owned
        ? Effect.ignore(
            Effect.gen(function* () {
              const current = yield* readHolder(request.path)
              if (current?.pid === host.pid && current.runId === request.runId) {
                yield* host.files.remove(request.path)
              }
            })
          )
        : Effect.void
    return Effect.acquireRelease(take, release).pipe(
      Effect.map((owned) => ({
        setGroups: (groups) =>
          owned ? Effect.ignore(host.files.writeAtomic(request.path, mine(groups))) : Effect.void
      }))
    )
  }

  return { hold, holder: (path) => readHolder(path).pipe(Effect.map(liveOf)) }
}

export interface MemoryWriterLockHost {
  readonly host: WriterLockHost
  readonly files: Effect.Effect<Readonly<Record<string, string>>>
  readonly setAlive: (pid: number, alive: boolean) => void
  readonly setGroupAlive: (pgid: number, alive: boolean) => void
}

/** The in-memory host for tests: `pid` is alive from the start. */
export const makeMemoryWriterLockHost = (
  pid: number,
  shared?: MemoryWriterLockHost
): Effect.Effect<MemoryWriterLockHost> =>
  Effect.gen(function* () {
    if (shared !== undefined) {
      shared.setAlive(pid, true)
      return { ...shared, host: { ...shared.host, pid } }
    }
    const memory = yield* makeMemoryPlainFileStore()
    const exclusive = yield* Semaphore.make(1)
    const alive = new Set<number>([pid])
    const groups = new Set<number>()
    const toggle = (set: Set<number>) => (member: number, on: boolean) => {
      if (on) set.add(member)
      else set.delete(member)
    }
    return {
      host: {
        files: memory.store,
        createExclusive: (path, contents) =>
          exclusive.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* memory.store.read(path)) !== undefined) return false
              yield* memory.store.writeAtomic(path, contents)
              return true
            })
          ),
        isAlive: (candidate) => alive.has(candidate),
        groupAlive: (candidate) => groups.has(candidate),
        pid
      },
      files: memory.files,
      setAlive: toggle(alive),
      setGroupAlive: toggle(groups)
    }
  })
