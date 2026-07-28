import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities, type Capability } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { ProcessError, type FlowError } from "./FlowError.ts"
import type { FlowEventsShape } from "./FlowEvents.ts"
import { guarded } from "./CapabilityGuard.ts"

export class BranchCreated extends Schema.TaggedClass<BranchCreated>()("Created", {}) {}
export class BranchAlreadyExists extends Schema.TaggedClass<BranchAlreadyExists>()(
  "AlreadyExists",
  {}
) {}
export const CreateBranch = Schema.Union([BranchCreated, BranchAlreadyExists])
export type CreateBranch = typeof CreateBranch.Type

export class Committed extends Schema.TaggedClass<Committed>()("Committed", {}) {}
export class NothingToCommit extends Schema.TaggedClass<NothingToCommit>()("NothingToCommit", {}) {}
export const CommitResult = Schema.Union([Committed, NothingToCommit])
export type CommitResult = typeof CommitResult.Type

export interface GitToolShape {
  readonly init: Effect.Effect<void, FlowError>
  readonly initBare: Effect.Effect<void, FlowError>
  readonly config: (key: string, value: string) => Effect.Effect<void, FlowError>
  readonly status: Effect.Effect<string, FlowError>
  readonly currentBranch: Effect.Effect<string, FlowError>
  readonly diff: Effect.Effect<string, FlowError>
  readonly diffAll: Effect.Effect<string, FlowError>
  readonly defaultBase: Effect.Effect<string, FlowError>
  readonly diffVsBase: (base: string, threeDot?: boolean) => Effect.Effect<string, FlowError>
  readonly changedFilesVsBase: (
    base: string,
    threeDot?: boolean
  ) => Effect.Effect<ReadonlyArray<string>, FlowError>
  readonly addRemote: (name: string, url: string) => Effect.Effect<void, FlowError>
  readonly checkout: (name: string) => Effect.Effect<void, FlowError>
  readonly checkoutOrCreate: (name: string) => Effect.Effect<void, FlowError>
  readonly createBranch: (name: string) => Effect.Effect<CreateBranch, FlowError>
  readonly commitAll: (message: string) => Effect.Effect<CommitResult, FlowError>
  readonly push: (remote: string, branch: string) => Effect.Effect<void, FlowError>
  readonly checkpoint: Effect.Effect<string, FlowError>
  readonly rollback: (checkpoint: string) => Effect.Effect<void, FlowError>
  readonly addWorktree: (path: string, branch: string) => Effect.Effect<void, FlowError>
  readonly removeWorktree: (path: string) => Effect.Effect<void, FlowError>
}

const nonInteractiveEnvironment = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes"
})

const text = (lines: ReadonlyArray<string>): string => lines.join("\n").trim()

const problem = (result: ProcessResult): string => {
  const detail = text([...result.stdout, ...result.stderr])
  return detail.length === 0 ? `process exited with code ${result.exitCode}` : detail
}

export const makeGitTool = (
  process: ProcessExecutorShape,
  workDir: string,
  events: FlowEventsShape
): GitToolShape => {
  const run = (args: ReadonlyArray<string>): Effect.Effect<ProcessResult, FlowError> =>
    process.run(["git", ...args], workDir, nonInteractiveEnvironment).pipe(
      Effect.mapError((error) =>
        ProcessError.make({
          message: `git ${args.join(" ")}`,
          detail: error.message
        })
      )
    )

  const runOrFail = (args: ReadonlyArray<string>): Effect.Effect<string, FlowError> =>
    Effect.flatMap(run(args), (result) =>
      result.exitCode === 0
        ? Effect.succeed(text(result.stdout))
        : Effect.fail(
            ProcessError.make({
              message: `git ${args.join(" ")}`,
              detail: problem(result)
            })
          )
    )

  const gate = <A>(
    capability: Capability,
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => guarded(capability, operation, events, effect)

  const write = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => gate(Capabilities.GitWrite, operation, effect)

  const read = <A>(
    operation: string,
    effect: Effect.Effect<A, FlowError>
  ): Effect.Effect<A, FlowError> => gate(Capabilities.GitRead, operation, effect)

  const createBranch = (name: string): Effect.Effect<CreateBranch, FlowError> =>
    write(
      "git checkout -b",
      Effect.flatMap(
        run(["checkout", "-b", name]),
        (result): Effect.Effect<CreateBranch, FlowError> =>
          result.exitCode === 0
            ? Effect.succeed(new BranchCreated())
            : text(result.stderr).includes("already exists")
              ? Effect.succeed(new BranchAlreadyExists())
              : Effect.fail(
                  ProcessError.make({
                    message: `git checkout -b ${name}`,
                    detail: problem(result)
                  })
                )
      )
    )

  const checkout = (name: string): Effect.Effect<void, FlowError> =>
    write("git checkout", runOrFail(["checkout", name]).pipe(Effect.asVoid))

  const addAll = runOrFail(["add", "-A"]).pipe(Effect.asVoid)

  const commitAllEffect = (message: string): Effect.Effect<CommitResult, FlowError> =>
    Effect.gen(function* () {
      yield* addAll
      const result = yield* run(["commit", "-m", message])
      if (result.exitCode === 0) {
        return new Committed()
      }
      if (problem(result).includes("nothing to commit")) {
        return new NothingToCommit()
      }
      return yield* ProcessError.make({
        message: "git commit",
        detail: problem(result)
      })
    })

  return {
    init: write(
      "git init",
      runOrFail(["-c", "init.defaultBranch=main", "init"]).pipe(Effect.asVoid)
    ),
    initBare: write(
      "git init --bare",
      runOrFail(["-c", "init.defaultBranch=main", "init", "--bare"]).pipe(Effect.asVoid)
    ),
    config: (key, value) =>
      write("git config", runOrFail(["config", key, value]).pipe(Effect.asVoid)),
    status: read("git status", runOrFail(["status", "--short"])),
    currentBranch: read("git currentBranch", runOrFail(["rev-parse", "--abbrev-ref", "HEAD"])),
    diff: read("git diff", runOrFail(["diff"])),
    diffAll: read(
      "git diffAll",
      runOrFail(["add", "--intent-to-add", "-A"]).pipe(Effect.andThen(runOrFail(["diff"])))
    ),
    defaultBase: read(
      "git defaultBase",
      Effect.flatMap(run(["symbolic-ref", "refs/remotes/origin/HEAD"]), (symbolic) => {
        const value = text(symbolic.stdout)
        if (symbolic.exitCode === 0 && value.length > 0) {
          return Effect.succeed(value.replace(/^refs\/remotes\//, ""))
        }
        return Effect.flatMap(run(["rev-parse", "--verify", "--quiet", "origin/main"]), (main) =>
          main.exitCode === 0
            ? Effect.succeed("origin/main")
            : run(["rev-parse", "--verify", "--quiet", "origin/master"]).pipe(
                Effect.map((master) => (master.exitCode === 0 ? "origin/master" : "main"))
              )
        )
      })
    ),
    diffVsBase: (base, threeDot = true) =>
      read("git diffVsBase", runOrFail(["diff", `${base}${threeDot ? "..." : ".."}HEAD`])),
    changedFilesVsBase: (base, threeDot = true) =>
      read(
        "git changedFilesVsBase",
        runOrFail(["diff", "--name-only", `${base}${threeDot ? "..." : ".."}HEAD`]).pipe(
          Effect.map((output) =>
            output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
          )
        )
      ),
    addRemote: (name, url) =>
      write("git addRemote", runOrFail(["remote", "add", name, url]).pipe(Effect.asVoid)),
    checkout,
    createBranch,
    checkoutOrCreate: (name) =>
      Effect.flatMap(createBranch(name), (created) =>
        created._tag === "Created" ? Effect.void : checkout(name)
      ),
    commitAll: (message) => write("git commitAll", commitAllEffect(message)),
    push: (remote, branch) =>
      gate(
        Capabilities.GitPush,
        "git push",
        runOrFail(["push", "-u", remote, branch]).pipe(Effect.asVoid)
      ),
    checkpoint: read("git checkpoint", runOrFail(["rev-parse", "HEAD"])),
    rollback: (checkpoint) =>
      write("git rollback", runOrFail(["reset", "--hard", checkpoint]).pipe(Effect.asVoid)),
    addWorktree: (path, branch) =>
      write("git worktree add", runOrFail(["worktree", "add", path, branch]).pipe(Effect.asVoid)),
    removeWorktree: (path) =>
      write("git worktree remove", runOrFail(["worktree", "remove", path]).pipe(Effect.asVoid))
  }
}
