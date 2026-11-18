import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { GitToolShape } from "@llm4ts/flow/GitTool"

const unused = Effect.die("unused in these tests")

/** A git tool on `main` that logs checkouts; `dirty` is what `uncommittedFiles` reports. */
export const fakeGit = (
  log: Ref.Ref<ReadonlyArray<string>>,
  dirty: Ref.Ref<ReadonlyArray<string>>
): GitToolShape => {
  const ok = Effect.void
  return {
    init: ok,
    initBare: ok,
    config: () => ok,
    status: Effect.succeed(""),
    uncommittedFiles: Ref.get(dirty),
    currentBranch: Effect.succeed("main"),
    diff: Effect.succeed(""),
    diffAll: Effect.succeed(""),
    defaultBase: Effect.succeed("main"),
    diffVsBase: () => Effect.succeed(""),
    diffVsBaseScoped: () => Effect.succeed(""),
    listFiles: () => Effect.succeed([]),
    changedFilesVsBase: () => Effect.succeed([]),
    addRemote: () => ok,
    checkout: (name) => Ref.update(log, (all) => [...all, `checkout:${name}`]),
    checkoutOrCreate: () => ok,
    createBranch: () => unused,
    commitAll: () => unused,
    commitPaths: () => unused,
    push: () => ok,
    checkpoint: Effect.succeed("before"),
    rollback: () => ok,
    addWorktree: () => ok,
    addWorktreeNewBranch: () => ok,
    removeWorktree: () => ok,
    moveWorktree: () => ok,
    restorePaths: () => ok,
    branchExists: () => Effect.succeed(true),
    deleteBranch: () => ok,
    isAncestor: () => Effect.succeed(true),
    commitsAhead: () => Effect.succeed(0),
    merge: () => ok,
    mergeNoCommit: () => Effect.succeed([])
  }
}
