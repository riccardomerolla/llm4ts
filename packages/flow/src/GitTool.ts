import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Capabilities, type Capability } from "@llm4ts/core/Capability"
import type { ProcessExecutorShape, ProcessResult } from "@llm4ts/core/ProcessExecutor"
import { MergeConflict, ProcessError, type FlowError } from "./FlowError.ts"
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
  /**
   * Every path with uncommitted changes, untracked files listed one by one
   * (not collapsed into their directory), minus the runner's `.llm4ts/`.
   */
  readonly uncommittedFiles: Effect.Effect<ReadonlyArray<string>, FlowError>
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
  /** Checks an EXISTING branch out into a new worktree at `path`. */
  readonly addWorktree: (path: string, branch: string) => Effect.Effect<void, FlowError>
  /** Creates `branch` at `startPoint` and checks it out into a new worktree at `path`. */
  readonly addWorktreeNewBranch: (
    path: string,
    branch: string,
    startPoint: string
  ) => Effect.Effect<void, FlowError>
  /** `force` also removes a worktree holding untracked or modified files. */
  readonly removeWorktree: (path: string, force?: boolean) => Effect.Effect<void, FlowError>
  /** Moves an existing worktree to `to`, keeping its branch and uncommitted work. */
  readonly moveWorktree: (from: string, to: string) => Effect.Effect<void, FlowError>
  /**
   * Puts `paths` back as they are on `source`: a path `source` has is checked
   * out from it, a path it lacks is deleted (tracked or not). Uncommitted.
   */
  readonly restorePaths: (
    source: string,
    paths: ReadonlyArray<string>
  ) => Effect.Effect<void, FlowError>
  readonly branchExists: (name: string) => Effect.Effect<boolean, FlowError>
  readonly deleteBranch: (name: string) => Effect.Effect<void, FlowError>
  /** Whether `commit` is reachable from `of` — a merged story branch is an ancestor of the epic head. */
  readonly isAncestor: (commit: string, of: string) => Effect.Effect<boolean, FlowError>
  /**
   * Merges `branch` into the checked-out branch with a merge commit. A
   * conflict fails typed with the conflicting paths and leaves the tree as it
   * was (the merge is aborted), so the next merge can proceed. A merge git
   * refuses before it starts (a dirty tree) fails typed with git's words.
   * `preferIncoming` resolves conflicting hunks to `branch`'s side
   * (`-X theirs`): the catch-up of a story branch with its epic, where the
   * epic side is authoritative for every path the story does not own.
   */
  readonly merge: (
    branch: string,
    message: string,
    options?: MergeOptions
  ) => Effect.Effect<void, FlowError>
}

export interface MergeOptions {
  readonly preferIncoming?: boolean
}

/**
 * The paths `git status --short` reports, minus the runner's own state under
 * `.llm4ts/`. A rename reports its destination.
 */
export const statusPaths = (status: string): ReadonlyArray<string> =>
  status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // `status` trims its output, so the first line may have lost the
      // leading blank of its two-letter code: match the code, not a column.
      const path = (/^[ MADRCTU?!]{1,2}\s+(.+)$/.exec(line)?.[1] ?? "").trim()
      const arrow = path.indexOf(" -> ")
      const target = arrow < 0 ? path : path.slice(arrow + 4)
      return target.replace(/^"|"$/g, "")
    })
    .filter((path) => path.length > 0 && !path.startsWith(".llm4ts/") && path !== ".llm4ts")

const nonInteractiveEnvironment = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes"
})

const text = (lines: ReadonlyArray<string>): string => lines.join("\n").trim()

const problem = (result: ProcessResult): string => {
  const detail = text([...result.stdout, ...result.stderr])
  return detail.length === 0 ? `process exited with code ${result.exitCode}` : detail
}

/**
 * The runner's own bookkeeping under `workDir/.llm4ts/`: the run trace and
 * the cost ledger. `commitAll` never stages them — they grow while the run
 * commits and belong to the machine, not the repository — while the rest of
 * `.llm4ts/` (plans, forked packs) is committed as before.
 */
export const runnerBookkeeping: ReadonlyArray<string> = [
  ".llm4ts/trace-*.jsonl",
  ".llm4ts/costs.jsonl"
]

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

  // Stage everything, then take the runner's bookkeeping back out of the
  // index: `reset -- <glob>` leaves an ignored or unmatched glob alone and
  // keeps a previously committed trace at its HEAD version, whereas an
  // `:(exclude)` pathspec makes `add` refuse the ignored files outright.
  const addAll = runOrFail(["add", "-A"]).pipe(
    Effect.andThen(runOrFail(["reset", "-q", "--", ...runnerBookkeeping])),
    Effect.asVoid
  )

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
    uncommittedFiles: read(
      "git uncommittedFiles",
      runOrFail(["status", "--porcelain", "--untracked-files=all"]).pipe(Effect.map(statusPaths))
    ),
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
    addWorktreeNewBranch: (path, branch, startPoint) =>
      write(
        "git worktree add -b",
        runOrFail(["worktree", "add", "-b", branch, path, startPoint]).pipe(Effect.asVoid)
      ),
    moveWorktree: (from, to) =>
      write(
        "git worktree move",
        Effect.gen(function* () {
          // git creates a new worktree's parents but not a moved one's.
          const parent = to.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "")
          if (parent.length > 0 && parent !== to) {
            yield* process
              .run(["mkdir", "-p", parent], workDir, nonInteractiveEnvironment)
              .pipe(
                Effect.mapError((error) =>
                  ProcessError.make({ message: `mkdir -p ${parent}`, detail: error.message })
                )
              )
          }
          yield* runOrFail(["worktree", "move", from, to])
        })
      ),
    restorePaths: (source, paths) =>
      write(
        "git restorePaths",
        Effect.gen(function* () {
          for (const path of paths) {
            const known = yield* run(["cat-file", "-e", `${source}:${path}`])
            if (known.exitCode === 0) {
              yield* runOrFail(["checkout", source, "--", path])
            } else {
              yield* runOrFail(["rm", "-r", "-f", "-q", "--ignore-unmatch", "--", path])
              yield* runOrFail(["clean", "-f", "-d", "-q", "--", path])
            }
          }
        })
      ),
    removeWorktree: (path, force = false) =>
      write(
        "git worktree remove",
        runOrFail(["worktree", "remove", ...(force ? ["--force"] : []), path]).pipe(Effect.asVoid)
      ),
    branchExists: (name) =>
      read(
        "git branchExists",
        Effect.map(verifiedRef(`refs/heads/${name}`), (found) => found !== undefined)
      ),
    deleteBranch: (name) =>
      write("git branch -D", runOrFail(["branch", "-D", name]).pipe(Effect.asVoid)),
    isAncestor: (commit, of) =>
      read(
        "git merge-base --is-ancestor",
        Effect.flatMap(run(["merge-base", "--is-ancestor", commit, of]), (result) =>
          result.exitCode === 0
            ? Effect.succeed(true)
            : result.exitCode === 1
              ? Effect.succeed(false)
              : Effect.fail(
                  ProcessError.make({
                    message: `git merge-base --is-ancestor ${commit} ${of}`,
                    detail: problem(result)
                  })
                )
        )
      ),
    merge: (branch, message, options = {}) =>
      write(
        "git merge",
        Effect.gen(function* () {
          const result = yield* run([
            "merge",
            "--no-ff",
            ...(options.preferIncoming === true ? ["-X", "theirs"] : []),
            "-m",
            message,
            branch
          ])
          if (result.exitCode === 0) {
            return
          }
          const into = yield* runOrFail(["rev-parse", "--abbrev-ref", "HEAD"])
          const unmerged = yield* run(["diff", "--name-only", "--diff-filter=U"])
          const paths = text(unmerged.stdout)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
          // Abort regardless of the outcome so the epic tree is clean for the
          // next story; a merge that failed before starting has nothing to
          // abort and git says so, which is not a second failure.
          yield* run(["merge", "--abort"])
          return yield* MergeConflict.make({
            branch,
            into,
            paths,
            ...(paths.length === 0 ? { detail: problem(result) } : {})
          })
        })
      )
  }
}
