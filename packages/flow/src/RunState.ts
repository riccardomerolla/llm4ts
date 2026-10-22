// The run's own state lives under `<repo>/.llm4ts/`: traces, the cost
// ledger, plans, transcripts, epics. It belongs to the machine the run
// happened on, not to the repository: a committed trace is read by every
// reviewer at real cost, and a coder that reaches it can wipe an earlier
// run. So the first write under a `.llm4ts/` directory leaves a
// `.gitignore` there that ignores everything, and a flow commit never
// stages the directory (see `GitTool.commitAll`).
import * as Effect from "effect/Effect"
import type { PlainFileStoreShape } from "./Persistence.ts"

/** The directory name, as a path segment. */
export const RunStateDirectory = ".llm4ts"

/** What `<dir>/.llm4ts/.gitignore` holds: everything under it is ignored. */
export const runStateIgnoreContents = "*\n"

/**
 * The glob every CLI seat is denied by default (ADR 0027 amendment,
 * 2026-10-22): the run state, relative to the seat's working directory.
 */
export const runStateDeniedPaths: ReadonlyArray<string> = [`${RunStateDirectory}/**`]

const ignoreName = ".gitignore"

/**
 * The `<dir>/.llm4ts` prefix of `path` when the path has a `.llm4ts`
 * segment; the first such segment, so a worktree nested under the run
 * state (`.llm4ts/port/shards/1/.llm4ts/…`) still ignores the outer one
 * first. Separators are kept as written.
 */
export const runStateRootOf = (path: string): string | undefined => {
  const match = /^(.*?)(^|[\\/])\.llm4ts(?=[\\/]|$)/.exec(path)
  return match === null ? undefined : `${match[1] ?? ""}${match[2] ?? ""}${RunStateDirectory}`
}

/**
 * The store with one rule on top: the first write under any `.llm4ts/`
 * directory creates its `.gitignore` (`*`) when none exists, so nothing
 * the run writes there is ever staged. An ignore file the repository
 * already has is left as it is: a team that commits its own flows or
 * forked packs keeps its exceptions. Idempotent to wrap twice.
 */
export const ignoringRunState = (store: PlainFileStoreShape): PlainFileStoreShape => {
  const ensured = new Set<string>()
  const ensureIgnore = (path: string): Effect.Effect<void, never> => {
    const root = runStateRootOf(path)
    if (root === undefined || ensured.has(root)) {
      return Effect.void
    }
    const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/"
    const ignorePath = `${root}${separator}${ignoreName}`
    if (path === ignorePath) {
      return Effect.void
    }
    return store.read(ignorePath).pipe(
      Effect.flatMap((existing) =>
        existing === undefined ? store.writeAtomic(ignorePath, runStateIgnoreContents) : Effect.void
      ),
      // A store that cannot write the ignore file is about to fail the
      // write itself, with its own error; nothing to add here.
      Effect.catch(() => Effect.void),
      Effect.tap(() => Effect.sync(() => void ensured.add(root)))
    )
  }
  return {
    ...store,
    writeAtomic: (path, contents) =>
      ensureIgnore(path).pipe(Effect.andThen(store.writeAtomic(path, contents))),
    append: (path, contents) =>
      ensureIgnore(path).pipe(Effect.andThen(store.append(path, contents)))
  }
}
