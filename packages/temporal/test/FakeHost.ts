import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { WriterHolder, type LiveHolder } from "@llm4ts/flow/WriterLock"
import type { FlowChildExit, FlowChildRequest, FlowHost } from "@llm4ts/temporal/FlowHost"

/** A host with no process behind it: the test decides when a run ends and how. */
export interface FakeHost {
  readonly host: FlowHost
  /** Every `start`, oldest first. */
  readonly started: Array<FlowChildRequest>
  /** `interrupt` and `killGroup` calls, in order. */
  readonly signals: Array<string>
  /** The trace line a run writes when it ends. */
  readonly writeEnd: (
    repo: string,
    runId: string,
    outcome: string,
    error?: string
  ) => Effect.Effect<void>
  /** Ends the process `pid`. */
  readonly finish: (pid: number, exit?: FlowChildExit) => Effect.Effect<void>
  /** Makes a run the holder of the checkout, as if a live flow had the lock. */
  readonly hold: (runId: string, pid: number, groups?: ReadonlyArray<number>) => void
  readonly release: () => void
  /** What a run does when it gets the interrupt; default: it ends, interrupted. */
  onInterrupt: (pid: number) => Effect.Effect<void>
  readonly files: Effect.Effect<Readonly<Record<string, string>>>
}

export const tracePath = (repo: string, runId: string): string =>
  `${repo}/.llm4ts/trace-${runId}.jsonl`

export const makeFakeHost = (
  environment: Readonly<Record<string, string | undefined>> = {}
): Effect.Effect<FakeHost> =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const exits = new Map<number, Deferred.Deferred<FlowChildExit>>()
    const alive = new Set<number>()
    let holder: LiveHolder | undefined
    let nextPid = 100
    const exitOf = (pid: number) =>
      Effect.gen(function* () {
        const known = exits.get(pid)
        if (known !== undefined) return known
        const made = yield* Deferred.make<FlowChildExit>()
        exits.set(pid, made)
        return made
      })
    const finish = (pid: number, exit: FlowChildExit = { code: 0 }) =>
      Effect.gen(function* () {
        alive.delete(pid)
        if (holder?.holder.pid === pid) holder = undefined
        yield* Deferred.succeed(yield* exitOf(pid), exit)
      })
    const fake: FakeHost = {
      started: [],
      signals: [],
      files: memory.files,
      writeEnd: (repo, runId, outcome, error) =>
        memory.store
          .append(
            tracePath(repo, runId),
            `${JSON.stringify({
              schemaVersion: 1,
              seq: 9,
              timestamp: 1,
              runId,
              kind: "RunEnded",
              fields: { outcome, ...(error === undefined ? {} : { error }) }
            })}\n`
          )
          .pipe(Effect.orDie),
      finish,
      hold: (runId, pid, groups = []) => {
        alive.add(pid)
        holder = {
          holder: WriterHolder.make({
            pid,
            runId,
            workDir: "/repo",
            startedAt: 1,
            groups: [...groups]
          }),
          alive: "run",
          groups
        }
      },
      release: () => {
        holder = undefined
      },
      onInterrupt: (pid) => finish(pid, { code: 130 }),
      host: {
        environment,
        files: memory.store,
        start: (request) =>
          Effect.gen(function* () {
            fake.started.push(request)
            const pid = nextPid++
            alive.add(pid)
            return { pid, exited: Deferred.await(yield* exitOf(pid)) }
          }),
        isAlive: (pid) => alive.has(pid),
        interrupt: (pid) =>
          Effect.suspend(() => {
            fake.signals.push(`interrupt ${pid}`)
            return fake.onInterrupt(pid)
          }),
        killGroup: (pid) =>
          Effect.suspend(() => {
            fake.signals.push(`kill ${pid}`)
            return finish(pid, { signal: "SIGKILL" })
          }),
        holder: () => Effect.sync(() => holder),
        controlRoot: (repo) => `/state/control${repo}`
      }
    }
    return fake
  })
