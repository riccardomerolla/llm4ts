import { homedir } from "node:os"
import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import {
  encodeOperatorRunLine,
  latestRuns,
  OperatorRun,
  RunInProgress,
  UnknownRun
} from "@llm4ts/flow/OperatorSchemas"
import type { OperatorKnobs } from "@llm4ts/flow/OperatorSchemas"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { FlowLaunchError, FlowProcessHandle, FlowProcessShape } from "./FlowProcess.ts"

/**
 * Where the operator keeps one repository's registry and run logs:
 * `${XDG_STATE_HOME:-~/.local/state}/llm4ts/mcp/<repoId>`. An empty
 * `XDG_STATE_HOME` counts as unset; never under `<repo>/.llm4ts/`.
 */
export const operatorStateDir = (
  environment: Readonly<Record<string, string | undefined>>,
  repoId: string
): string => {
  const home =
    environment.HOME !== undefined && environment.HOME.length > 0 ? environment.HOME : homedir()
  const stateHome =
    environment.XDG_STATE_HOME !== undefined && environment.XDG_STATE_HOME.length > 0
      ? environment.XDG_STATE_HOME
      : join(home, ".local", "state")
  return join(stateHome, "llm4ts", "mcp", repoId)
}

export interface SupervisorRepo {
  readonly id: string
  readonly path: string
}

export interface StartRun {
  readonly repo: SupervisorRepo
  readonly flow: { readonly name: string; readonly path: string }
  readonly knobs: OperatorKnobs
  readonly baseEnvironment: Readonly<Record<string, string | undefined>>
}

export interface RunSupervisorShape {
  readonly start: (
    request: StartRun
  ) => Effect.Effect<OperatorRun, FlowLaunchError | RunInProgress | PersistenceError>
  readonly stop: (runId: string) => Effect.Effect<OperatorRun, UnknownRun>
  readonly get: (runId: string) => Effect.Effect<OperatorRun | undefined>
  readonly list: (repoId?: string) => Effect.Effect<ReadonlyArray<OperatorRun>>
}

export interface SupervisorOptions {
  readonly repos: ReadonlyArray<SupervisorRepo>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly files: PlainFileStoreShape
  readonly process: FlowProcessShape
  readonly parallelRuns: number
  /** How long `stop` waits after SIGINT before SIGTERM; default 30 s. */
  readonly graceMs?: number
  /** Flows that may run beside a busy repository; default `epic-retro`. */
  readonly readOnlyFlows?: ReadonlySet<string>
  /** The 4-hex run id suffix; injectable so tests are deterministic. */
  readonly random?: () => string
}

/** Knobs that become the flow's argv, in a fixed order; `flags` come last. */
export const knobsToArgs = (_flow: string, knobs: OperatorKnobs): ReadonlyArray<string> => [
  ...(knobs.task === undefined ? [] : [knobs.task]),
  ...(knobs.epic === undefined ? [] : ["--epic", knobs.epic]),
  ...(knobs.land === undefined ? [] : [`--land=${knobs.land}`]),
  ...(knobs.judgeRounds === undefined ? [] : ["--judge-rounds", String(knobs.judgeRounds)]),
  ...(knobs.mergeRevisions === undefined
    ? []
    : ["--merge-revisions", String(knobs.mergeRevisions)]),
  ...(knobs.flags ?? [])
]

/** The only knobs that reach the flow's environment. */
export const knobsToEnvironment = (knobs: OperatorKnobs): Record<string, string> => ({
  ...(knobs.executors === undefined ? {} : { LLM4TS_EXECUTORS: knobs.executors.join(",") }),
  ...(knobs.pack === undefined ? {} : { LLM4TS_PACK: knobs.pack }),
  ...(knobs.coder === undefined ? {} : { LLM4TS_CODER: knobs.coder })
})

const randomHex = (): string =>
  Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0")

interface LiveRun {
  readonly handle: FlowProcessHandle
  readonly stopping: Ref.Ref<boolean>
  readonly final: Deferred.Deferred<OperatorRun>
}

const isActive = (run: OperatorRun): boolean => run.state === "starting" || run.state === "running"

/** The server's own bearer token never reaches a child flow. */
const childEnvironment = (
  base: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(base).filter(([name]) => name !== "LLM4TS_MCP_TOKEN"))

export const makeRunSupervisor = (
  options: SupervisorOptions
): Effect.Effect<RunSupervisorShape, PersistenceError, Scope.Scope> =>
  Effect.gen(function* () {
    const graceMs = options.graceMs ?? 30_000
    const readOnlyFlows = options.readOnlyFlows ?? new Set(["epic-retro"])
    const random = options.random ?? randomHex
    const stateDir = (repoId: string) => operatorStateDir(options.environment, repoId)
    const registryPath = (repoId: string) => join(stateDir(repoId), "runs.jsonl")

    const readRepo = (repoId: string) =>
      options.files
        .read(registryPath(repoId))
        .pipe(Effect.map((contents) => latestRuns((contents ?? "").split("\n"))))
    const record = (run: OperatorRun) =>
      options.files.append(registryPath(run.repo), `${encodeOperatorRunLine(run)}\n`)
    const withState = (run: OperatorRun, fields: Partial<OperatorRun>): OperatorRun =>
      new OperatorRun({ ...run, ...fields })

    // Runs whose child died while no supervisor watched them.
    for (const repo of options.repos) {
      for (const run of yield* readRepo(repo.id)) {
        if (isActive(run) && (run.pid === undefined || !options.process.isAlive(run.pid))) {
          const endedAt = yield* Clock.currentTimeMillis
          yield* record(withState(run, { state: "lost", endedAt }))
        }
      }
    }

    const live = new Map<string, LiveRun>()
    // Runs between their `starting` record and their `live` entry.
    const launching = new Set<string>()
    // Orphan runs (alive, left by an earlier server) a `stop` already
    // signalled, with the outcome of their escalation.
    const orphansStopping = new Map<string, Deferred.Deferred<OperatorRun>>()
    const lock = yield* Semaphore.make(1)
    const watchers = yield* Scope.make()

    const isOrphan = (run: OperatorRun): boolean =>
      isActive(run) && !live.has(run.runId) && !launching.has(run.runId)

    // An active record nobody here watches: a run from an earlier server.
    // Its child is re-checked lazily; once gone the record becomes `lost`.
    const reconcile = (run: OperatorRun): Effect.Effect<OperatorRun, PersistenceError> =>
      Effect.gen(function* () {
        if (!isOrphan(run) || (run.pid !== undefined && options.process.isAlive(run.pid))) {
          return run
        }
        const endedAt = yield* Clock.currentTimeMillis
        const lost = withState(run, { state: "lost", endedAt })
        yield* record(lost)
        return lost
      })

    const readRepoLive = (repoId: string) =>
      readRepo(repoId).pipe(Effect.flatMap((runs) => Effect.forEach(runs, reconcile)))

    const allRuns = (repoId?: string) =>
      Effect.forEach(
        options.repos.filter((repo) => repoId === undefined || repo.id === repoId),
        (repo) => readRepoLive(repo.id)
      ).pipe(
        Effect.map((perRepo) => perRepo.flat().sort((a, b) => b.startedAt - a.startedAt)),
        Effect.orDie
      )

    const get = (runId: string) =>
      allRuns().pipe(Effect.map((runs) => runs.find((run) => run.runId === runId)))

    const watch = (running: OperatorRun, entry: LiveRun) =>
      Effect.gen(function* () {
        const exit = yield* entry.handle.exited
        const stopped = yield* Ref.get(entry.stopping)
        const endedAt = yield* Clock.currentTimeMillis
        const final = withState(running, {
          state: stopped ? "interrupted" : "exited",
          endedAt,
          ...(exit.code === undefined ? {} : { exitCode: exit.code }),
          ...(exit.signal === undefined ? {} : { signal: exit.signal })
        })
        // A failed append leaves the record active; with the child gone, the
        // next read reconciles it to `lost`. `stop` must not wait on it.
        yield* record(final).pipe(
          Effect.ignore,
          Effect.ensuring(
            Effect.suspend(() => {
              live.delete(running.runId)
              return Deferred.succeed(entry.final, final)
            })
          )
        )
      })

    const start = (request: StartRun) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* readRepoLive(request.repo.id)
          const requestId = request.knobs.requestId
          if (requestId !== undefined) {
            const repeated = existing.find((run) => run.requestId === requestId)
            if (repeated !== undefined) return repeated
          }
          if (!readOnlyFlows.has(request.flow.name)) {
            const busy = existing.filter((run) => isActive(run) && !readOnlyFlows.has(run.flow))
            const [newest] = busy
            if (newest !== undefined && busy.length >= options.parallelRuns) {
              return yield* new RunInProgress({
                message: `${request.repo.id} already runs ${newest.flow} (${newest.runId})`,
                runId: newest.runId
              })
            }
          }
          const startedAt = yield* Clock.currentTimeMillis
          const taken = (id: string) => live.has(id) || existing.some((run) => run.runId === id)
          let runId = `op-${startedAt}-${random()}`
          for (let attempt = 0; attempt < 16 && taken(runId); attempt++) {
            runId = `op-${startedAt}-${random()}`
          }
          const tracePath = join(request.repo.path, ".llm4ts", `trace-${startedAt}.jsonl`)
          const logDir = join(stateDir(request.repo.id), "runs", runId)
          const args = knobsToArgs(request.flow.name, request.knobs)
          const starting = new OperatorRun({
            runId,
            repo: request.repo.id,
            flow: request.flow.name,
            args,
            knobs: request.knobs,
            startedAt,
            tracePath,
            logDir,
            state: "starting",
            ...(requestId === undefined ? {} : { requestId })
          })
          launching.add(runId)
          return yield* Effect.gen(function* () {
            yield* record(starting)
            const handle = yield* options.process
              .start({
                flowPath: request.flow.path,
                args,
                environment: {
                  ...childEnvironment(request.baseEnvironment),
                  ...knobsToEnvironment(request.knobs),
                  LLM4TS_RUN_ID: runId,
                  LLM4TS_TRACE_PATH: tracePath,
                  LLM4TS_FLOW: request.flow.name
                },
                cwd: request.repo.path,
                stdio: { stdout: join(logDir, "stdout.log"), stderr: join(logDir, "stderr.log") },
                detached: true
              })
              .pipe(
                Effect.tapError(() =>
                  Effect.gen(function* () {
                    const endedAt = yield* Clock.currentTimeMillis
                    yield* record(withState(starting, { state: "exited", endedAt }))
                  })
                )
              )
            const running = withState(starting, { state: "running", pid: handle.pid })
            yield* record(running)
            const entry: LiveRun = {
              handle,
              stopping: yield* Ref.make(false),
              final: yield* Deferred.make<OperatorRun>()
            }
            live.set(runId, entry)
            yield* Effect.forkIn(watch(running, entry), watchers)
            return running
          }).pipe(Effect.ensuring(Effect.sync(() => launching.delete(runId))))
        })
      )

    // Polls until the pid is gone or `ms` elapses; true when it is gone.
    const awaitGone = (pid: number, ms: number): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const step = Math.max(1, Math.min(250, ms))
        for (let waited = 0; waited < ms; waited += step) {
          if (!options.process.isAlive(pid)) return true
          yield* Effect.sleep(step)
        }
        return !options.process.isAlive(pid)
      })

    // A live run's signal-and-escalate sequence. It runs in `watchers`, not
    // in the caller's fiber, so a cancelled `stop` still sends SIGTERM.
    const escalate = (entry: LiveRun): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(entry.final)) return
        yield* entry.handle.signal("SIGINT")
        const graceful = yield* Deferred.await(entry.final).pipe(Effect.timeoutOption(graceMs))
        if (graceful._tag === "None") yield* entry.handle.signal("SIGTERM")
      })

    // The same for an orphan, by pid. It records `interrupted` once the pid
    // is gone and always completes `outcome`, even when interrupted.
    const escalateOrphan = (
      run: OperatorRun,
      pid: number,
      outcome: Deferred.Deferred<OperatorRun>
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* options.process.signal(pid, "SIGINT")
        let gone = yield* awaitGone(pid, graceMs)
        if (!gone) {
          yield* options.process.signal(pid, "SIGTERM")
          gone = yield* awaitGone(pid, graceMs)
        }
        if (!gone) return
        const endedAt = yield* Clock.currentTimeMillis
        const interrupted = withState(run, { state: "interrupted", endedAt })
        yield* record(interrupted).pipe(Effect.ignore)
        yield* Deferred.succeed(outcome, interrupted)
      }).pipe(Effect.ensuring(Deferred.succeed(outcome, run)))

    const stopOrphan = (run: OperatorRun, pid: number): Effect.Effect<OperatorRun> =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<OperatorRun>()
        // Check-and-set and fork with no interruption point between them:
        // only the first stop signals, and its escalation always starts.
        const outcome = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const existing = orphansStopping.get(run.runId)
            if (existing !== undefined) return existing
            orphansStopping.set(run.runId, candidate)
            yield* Effect.forkIn(escalateOrphan(run, pid, candidate), watchers)
            return candidate
          })
        )
        const result = yield* Deferred.await(outcome)
        if (!isActive(result)) return result
        // The child ignored SIGTERM too: report where the registry stands.
        return (yield* get(run.runId)) ?? result
      })

    const stop = (runId: string): Effect.Effect<OperatorRun, UnknownRun> =>
      Effect.gen(function* () {
        const entry = live.get(runId)
        if (entry === undefined) {
          const known = yield* get(runId)
          if (known === undefined) {
            return yield* new UnknownRun({ message: `no run ${runId}` })
          }
          if (isOrphan(known) && known.pid !== undefined) {
            return yield* stopOrphan(known, known.pid)
          }
          return known
        }
        // Only the first stop signals: a second SIGINT kills a flow at once.
        // The winner forks the escalation into `watchers`; every caller,
        // the winner included, only awaits the outcome.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const already = yield* Ref.getAndSet(entry.stopping, true)
            if (!already) yield* Effect.forkIn(escalate(entry), watchers)
          })
        )
        const graceful = yield* Deferred.await(entry.final).pipe(Effect.timeoutOption(graceMs))
        if (graceful._tag === "Some") return graceful.value
        const forced = yield* Deferred.await(entry.final).pipe(Effect.timeoutOption(graceMs))
        if (forced._tag === "Some") return forced.value
        // The child ignored SIGTERM too: report where the registry stands.
        const latest = yield* get(runId)
        return latest ?? (yield* new UnknownRun({ message: `no run ${runId}` }))
      })

    // Live runs are stopped (their escalations finish within the stop's
    // wait) and pending orphan escalations awaited before `watchers` closes.
    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          Effect.forEach([...live.keys()], (runId) => Effect.ignore(stop(runId)), {
            concurrency: "unbounded",
            discard: true
          }),
          Effect.forEach([...orphansStopping.values()], Deferred.await, {
            concurrency: "unbounded",
            discard: true
          })
        ],
        { concurrency: "unbounded", discard: true }
      ).pipe(Effect.andThen(Scope.close(watchers, Exit.void)))
    )

    return {
      start,
      stop,
      get,
      list: allRuns
    } satisfies RunSupervisorShape
  })
