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
    const lock = yield* Semaphore.make(1)
    const watchers = yield* Scope.make()

    const allRuns = (repoId?: string) =>
      Effect.forEach(
        options.repos.filter((repo) => repoId === undefined || repo.id === repoId),
        (repo) => readRepo(repo.id)
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
        yield* record(final).pipe(Effect.orDie)
        live.delete(running.runId)
        yield* Deferred.succeed(entry.final, final)
      })

    const start = (request: StartRun) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* readRepo(request.repo.id)
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
          yield* record(starting)
          const handle = yield* options.process
            .start({
              flowPath: request.flow.path,
              args,
              environment: {
                ...request.baseEnvironment,
                ...knobsToEnvironment(request.knobs),
                LLM4TS_RUN_ID: runId,
                LLM4TS_TRACE_PATH: tracePath,
                LLM4TS_FLOW: request.flow.name
              },
              cwd: request.repo.path,
              stdio: { stdout: join(logDir, "stdout.log"), stderr: join(logDir, "stderr.log") }
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
        })
      )

    const stop = (runId: string): Effect.Effect<OperatorRun, UnknownRun> =>
      Effect.gen(function* () {
        const entry = live.get(runId)
        if (entry === undefined) {
          const known = yield* get(runId)
          if (known === undefined) {
            return yield* new UnknownRun({ message: `no run ${runId}` })
          }
          return known
        }
        yield* Ref.set(entry.stopping, true)
        yield* entry.handle.signal("SIGINT")
        const graceful = yield* Deferred.await(entry.final).pipe(Effect.timeoutOption(graceMs))
        if (graceful._tag === "Some") return graceful.value
        yield* entry.handle.signal("SIGTERM")
        const forced = yield* Deferred.await(entry.final).pipe(Effect.timeoutOption(graceMs))
        if (forced._tag === "Some") return forced.value
        // The child ignored SIGTERM too: report where the registry stands.
        const latest = yield* get(runId)
        return latest ?? (yield* new UnknownRun({ message: `no run ${runId}` }))
      })

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...live.keys()], (runId) => Effect.ignore(stop(runId)), {
        concurrency: "unbounded",
        discard: true
      }).pipe(Effect.andThen(Scope.close(watchers, Exit.void)))
    )

    return {
      start,
      stop,
      get,
      list: allRuns
    } satisfies RunSupervisorShape
  })
