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
  readonly diffVsBaseScoped: (
    base: string,
    paths: ReadonlyArray<string>,
    threeDot?: boolean
  ) => Effect.Effect<string, FlowError>
  readonly changedFilesVsBase: (
    base: string,
    threeDot?: boolean
  ) => Effect.Effect<ReadonlyArray<string>, FlowError>
  readonly addRemote: (name: string, url: string) => Effect.Effect<void, FlowError>
  readonly checkout: (name: string) => Effect.Effect<void, FlowError>
  readonly checkoutOrCreate: (name: string) => Effect.Effect<void, FlowError>
  readonly createBranch: (name: string) => Effect.Effect<CreateBranch, FlowError>
  readonly commitAll: (message: string) => Effect.Effect<CommitResult, FlowError>
  /**
   * Stage ONLY `paths` (added, modified, or deleted) and commit them. The
   * per-program commit primitive: when several programs are extracted at
   * once, `commitAll` would sweep another program's half-written files into
   * this program's commit. An empty `paths` is `NothingToCommit`.
   */
  readonly commitPaths: (
    message: string,
    paths: ReadonlyArray<string>
  ) => Effect.Effect<CommitResult, FlowError>
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

  /** The candidate when it resolves to a commit in this repository. */
  const verifiedRef = (candidate: string): Effect.Effect<string | undefined, FlowError> =>
    Effect.map(run(["rev-parse", "--verify", "--quiet", candidate]), (result) =>
      result.exitCode === 0 ? candidate : undefined
    )

  const firstVerifiedRef = (
    candidates: ReadonlyArray<string>
  ): Effect.Effect<string | undefined, FlowError> =>
    candidates.reduce<Effect.Effect<string | undefined, FlowError>>(
      (found, candidate) =>
        Effect.flatMap(found, (resolved) =>
          resolved === undefined ? verifiedRef(candidate) : Effect.succeed(resolved)
        ),
      Effect.succeed(undefined)
    )

  /**
   * The ref to diff a branch against. Every answer is verified to resolve in
   * this repository: returning an unverified name (this used to fall back to
   * the literal "main") makes the next `git diff <base>...HEAD` fail with
   * "unknown revision", which killed whole stages in repositories whose
   * default branch is named something else or which have no remote at all —
   * exactly what `modernize-seed` produces. When no conventional branch
   * exists, the current branch's root commit stands in, so a diff against it
   * still describes the work rather than erroring.
   */
  const defaultBaseEffect: Effect.Effect<string, FlowError> = Effect.gen(function* () {
    const symbolic = yield* run(["symbolic-ref", "refs/remotes/origin/HEAD"])
    const head = text(symbolic.stdout).replace(/^refs\/remotes\//, "")
    if (symbolic.exitCode === 0 && head.length > 0) {
      const verified = yield* verifiedRef(head)
      if (verified !== undefined) {
        return verified
      }
    }
    const conventional = yield* firstVerifiedRef(["origin/main", "origin/master", "main", "master"])
    if (conventional !== undefined) {
      return conventional
    }
    const root = yield* run(["rev-list", "--max-parents=0", "HEAD"])
    const firstCommit = text(root.stdout).split(/\r?\n/)[0]?.trim() ?? ""
    return root.exitCode === 0 && firstCommit.length > 0 ? firstCommit : "HEAD"
  })

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

  const commitStaged = (message: string): Effect.Effect<CommitResult, FlowError> =>
    Effect.gen(function* () {
      const result = yield* run(["commit", "-m", message])
      if (result.exitCode === 0) {
        return new Committed()
      }
      // "nothing to commit, working tree clean" when the tree is clean;
      // "nothing added to commit but untracked files present" when the only
      // changes are files this commit was not asked to stage.
      const detail = problem(result)
      if (detail.includes("nothing to commit") || detail.includes("nothing added to commit")) {
        return new NothingToCommit()
      }
      return yield* ProcessError.make({
        message: "git commit",
        detail: problem(result)
      })
    })

  const commitAllEffect = (message: string): Effect.Effect<CommitResult, FlowError> =>
    addAll.pipe(Effect.andThen(commitStaged(message)))

  // `add -A -- <paths>` stages additions, modifications, AND deletions of
  // exactly those paths; a plain `add` would refuse a deleted file. `--only`
  // on commit would also work but ignores paths that were never tracked.
  const commitPathsEffect = (
    message: string,
    paths: ReadonlyArray<string>
  ): Effect.Effect<CommitResult, FlowError> =>
    paths.length === 0
      ? Effect.succeed(new NothingToCommit())
      : runOrFail(["add", "-A", "--", ...paths]).pipe(Effect.andThen(commitStaged(message)))

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
    defaultBase: read("git defaultBase", defaultBaseEffect),
    diffVsBase: (base, threeDot = true) =>
      read("git diffVsBase", runOrFail(["diff", `${base}${threeDot ? "..." : ".."}HEAD`])),
    // Diff vs base restricted to paths — the per-program / per-lens scoping
    // primitive. An EMPTY paths list returns the empty string rather than the
    // whole diff: bare `git diff <range> --` means "everything", which would
    // silently defeat every caller that scopes by a computed, possibly-empty
    // file set. The empty check lives INSIDE read(...), not before it — a
    // pre-guard early return would let diffVsBaseScoped(base, []) silently
    // succeed under grants that deny GitRead, with no CapabilityDenied audit.
    diffVsBaseScoped: (base, paths, threeDot = true) =>
      read(
        "git diffVsBase (scoped)",
        Effect.suspend(() =>
          paths.length === 0
            ? Effect.succeed("")
            : runOrFail(["diff", `${base}${threeDot ? "..." : ".."}HEAD`, "--", ...paths])
        )
      ),
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
    commitPaths: (message, paths) => write("git commitPaths", commitPathsEffect(message, paths)),
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
