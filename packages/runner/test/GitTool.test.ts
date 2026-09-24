import { assert, describe, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeGitTool, statusPaths } from "@llm4ts/flow/GitTool"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"

const temporaryRepository = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-git-"))),
  (directory) =>
    Effect.promise(() =>
      rm(directory, {
        recursive: true,
        force: true
      })
    )
)

describe("GitTool", () => {
  it.effect("covers local init, commit, branch, diff, checkpoint, and rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "one\n", "utf8"))
        assert.strictEqual((yield* git.commitAll("first"))._tag, "Committed")
        const checkpoint = yield* git.checkpoint
        assert.strictEqual(yield* git.currentBranch, "main")

        assert.strictEqual((yield* git.createBranch("feature"))._tag, "Created")
        assert.strictEqual((yield* git.createBranch("feature"))._tag, "AlreadyExists")
        yield* git.checkout("feature")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "two\n", "utf8"))
        assert.match(yield* git.diff, /two/)
        yield* git.commitAll("second")
        yield* git.rollback(checkpoint)

        assert.strictEqual(
          yield* Effect.promise(() => readFile(join(root, "value.txt"), "utf8")),
          "one\n"
        )
        assert.strictEqual(yield* git.status, "")
      })
    )
  )

  it.effect("commitAll stages everything except the runner's trace and cost ledger", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() =>
          mkdir(join(root, ".llm4ts", "kits", "forked"), { recursive: true })
        )
        for (const [path, contents] of [
          ["value.txt", "one\n"],
          [".llm4ts/trace-1700000000000.jsonl", "{}\n"],
          [".llm4ts/costs.jsonl", "{}\n"],
          [".llm4ts/plan-abc.md", "# plan\n"],
          [".llm4ts/kits/forked/pack.md", "# Pack\n"]
        ]) {
          yield* Effect.promise(() => writeFile(join(root, path), contents, "utf8"))
        }
        assert.strictEqual((yield* git.commitAll("first"))._tag, "Committed")
        const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
          .trim()
          .split("\n")
          .sort()

        assert.deepStrictEqual(tracked, [
          ".llm4ts/kits/forked/pack.md",
          ".llm4ts/plan-abc.md",
          "value.txt"
        ])
        assert.match(yield* git.status, /trace-1700000000000\.jsonl/)
      })
    )
  )

  it.effect("commits only the named paths and leaves the rest of the tree alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() => mkdir(join(root, "specs"), { recursive: true }))
        yield* Effect.promise(() => writeFile(join(root, "specs", "A.md"), "a\n", "utf8"))
        yield* Effect.promise(() => writeFile(join(root, "specs", "B.md"), "b\n", "utf8"))

        assert.strictEqual((yield* git.commitPaths("only A", ["specs/A.md"]))._tag, "Committed")
        // B is still untracked: a sibling's half-written work never rides along.
        assert.strictEqual(yield* git.status, "?? specs/B.md")
        assert.strictEqual((yield* git.commitPaths("nothing", []))._tag, "NothingToCommit")
        assert.strictEqual(
          (yield* git.commitPaths("A again", ["specs/A.md"]))._tag,
          "NothingToCommit"
        )

        // A deletion of a named path is staged too.
        yield* Effect.promise(() => rm(join(root, "specs", "A.md")))
        assert.strictEqual((yield* git.commitPaths("drop A", ["specs/A.md"]))._tag, "Committed")
        // With no tracked file left under specs/, git reports the untracked
        // directory itself; B is still the only thing in it.
        assert.strictEqual(yield* git.status, "?? specs/")
      })
    )
  )

  // A locally seeded target repository has no remote, and its default branch
  // is whatever git was configured to create. Answering "main" regardless made
  // the next `git diff main...HEAD` fail with "unknown revision", which killed
  // the stage that had just spent half an hour doing real work.
  it.effect("resolves a base that exists when there is no remote and no main", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "one\n", "utf8"))
        yield* git.commitAll("first")
        // Rename away from main so neither conventional branch resolves —
        // the shape of a repository initialised under another default.
        yield* nodeProcessExecutor.run(["git", "branch", "-m", "main", "trunk"], root, {})
        yield* git.createBranch("epic/work")
        yield* Effect.promise(() => writeFile(join(root, "added.txt"), "two\n", "utf8"))
        yield* git.commitAll("second")

        const base = yield* git.defaultBase
        assert.notStrictEqual(base, "main", "an unverified 'main' is what used to break the diff")
        // Whatever it resolved to must actually be diffable — that is the
        // property the flow depends on.
        const changed = yield* git.changedFilesVsBase(base)
        assert.include(changed, "added.txt")
      })
    )
  )

  it.effect("prefers a real main and keeps the diff working", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "one\n", "utf8"))
        yield* git.commitAll("first")
        yield* git.createBranch("epic/work")
        yield* Effect.promise(() => writeFile(join(root, "added.txt"), "two\n", "utf8"))
        yield* git.commitAll("second")

        assert.strictEqual(yield* git.defaultBase, "main")
        assert.deepStrictEqual(yield* git.changedFilesVsBase("main"), ["added.txt"])
      })
    )
  )

  it.effect("keeps read, write, and push grants distinct and audits denials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        const readOnly = new Grants({
          ...allGrants,
          git: "Read"
        })
        const writeOnly = new Grants({
          ...allGrants,
          git: "Write"
        })

        yield* restricted(readOnly)(git.status)
        const commitDenied = yield* Effect.flip(restricted(readOnly)(git.commitAll("denied")))
        const pushDenied = yield* Effect.flip(restricted(writeOnly)(git.push("origin", "main")))
        const recorded = yield* events.recorded

        assert.strictEqual(commitDenied._tag, "CapabilityDenied")
        assert.strictEqual(pushDenied._tag, "CapabilityDenied")
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "CapabilityDenied" && event.capability === "GitWrite"
          )
        )
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "CapabilityDenied" && event.capability === "GitPush"
          )
        )
      })
    )
  )

  it.effect("scopes diffVsBaseScoped to its paths, and empty paths never mean everything", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        yield* git.config("user.name", "llm4ts test")
        yield* git.config("user.email", "llm4ts@example.invalid")
        yield* Effect.promise(() => writeFile(join(root, "value.txt"), "one\n", "utf8"))
        yield* git.commitAll("first")
        yield* git.createBranch("epic/work")
        yield* Effect.promise(() => writeFile(join(root, "alpha.txt"), "alpha\n", "utf8"))
        yield* Effect.promise(() => writeFile(join(root, "beta.txt"), "beta\n", "utf8"))
        yield* git.commitAll("second")

        const scoped = yield* git.diffVsBaseScoped("main", ["alpha.txt"])
        assert.include(scoped, "alpha.txt")
        assert.notInclude(scoped, "beta.txt")

        assert.strictEqual(yield* git.diffVsBaseScoped("main", []), "")
      })
    )
  )

  // The empty-paths early return must sit INSIDE the capability guard: were it
  // hoisted out, diffVsBaseScoped(base, []) would silently succeed under
  // grants that deny GitRead — no typed failure, no audit event — the exact
  // hole no other GitRead method has.
  it.effect("consults the GitRead guard even when the path list is empty", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRepository
        const events = yield* makeCollectingFlowEvents
        const git = makeGitTool(nodeProcessExecutor, root, events)
        yield* git.init
        const noGit = new Grants({
          ...allGrants,
          git: "None"
        })

        const denied = yield* Effect.flip(restricted(noGit)(git.diffVsBaseScoped("main", [])))
        assert.strictEqual(denied._tag, "CapabilityDenied")
        const recorded = yield* events.recorded
        assert.isTrue(
          recorded.some(
            (event) => event._tag === "CapabilityDenied" && event.capability === "GitRead"
          )
        )
      })
    )
  )

  it("reads paths from git status, even with the first line's blank trimmed", () => {
    assert.deepStrictEqual(
      statusPaths(
        "M src/App.tsx\n M src/kit/a.ts\nA  src/x.ts\n?? src/features/conto/\nR  old.ts -> new.ts\n?? .llm4ts/epics/e/board.md"
      ),
      ["src/App.tsx", "src/kit/a.ts", "src/x.ts", "src/features/conto/", "new.ts"]
    )
    assert.deepStrictEqual(statusPaths(""), [])
  })

  it.effect(
    "catches a story worktree up, moves it, restores strays, and explains a refused merge",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRepository
          const repo = join(root, "portal")
          yield* Effect.promise(() => mkdir(repo))
          const events = yield* makeCollectingFlowEvents
          const epic = makeGitTool(nodeProcessExecutor, repo, events)
          yield* epic.init
          yield* epic.config("user.name", "llm4ts test")
          yield* epic.config("user.email", "llm4ts@example.invalid")
          const write = (dir: string, path: string, text: string) =>
            Effect.promise(async () => {
              await mkdir(join(dir, path, ".."), { recursive: true })
              await writeFile(join(dir, path), text)
            })
          yield* write(repo, "src/shared.ts", "a\nb\nc\n")
          yield* epic.commitAll("seed")
          yield* epic.checkoutOrCreate("epic")

          const nested = join(repo, ".llm4ts", "worktrees", "s")
          yield* epic.addWorktreeNewBranch(nested, "story", "epic")
          const inside = makeGitTool(nodeProcessExecutor, nested, events)
          yield* write(nested, "src/shared.ts", "a\nSTORY\nc\n")
          yield* write(nested, "src/own/x.ts", "mine\n")
          yield* inside.commitAll("story work")

          yield* write(repo, "src/shared.ts", "a\nEPIC\nc\n")
          yield* epic.commitAll("epic moved on")

          // Move out of the repository, parents created on the way.
          const outside = join(root, "portal.worktrees", "e", "s")
          yield* epic.moveWorktree(nested, outside)
          const story = makeGitTool(nodeProcessExecutor, outside, events)
          assert.isFalse(yield* story.isAncestor("epic", "HEAD"))

          yield* story.merge("epic", "catch up", { preferIncoming: true })
          assert.isTrue(yield* story.isAncestor("epic", "HEAD"))
          assert.strictEqual(
            yield* Effect.promise(() => readFile(join(outside, "src/shared.ts"), "utf8")),
            "a\nEPIC\nc\n"
          )

          yield* write(outside, "src/stray/new.ts", "stray\n")
          yield* write(outside, "src/shared.ts", "changed again\n")
          assert.deepStrictEqual([...(yield* story.uncommittedFiles)].sort(), [
            "src/shared.ts",
            "src/stray/new.ts"
          ])
          yield* story.restorePaths("epic", ["src/shared.ts", "src/stray/new.ts"])
          assert.deepStrictEqual(yield* story.uncommittedFiles, [])

          // A merge git refuses before starting names git's reason, not "conflicted".
          yield* write(repo, "src/own/x.ts", "leaked into the epic checkout\n")
          const refused = yield* Effect.flip(epic.merge("story", "merge story"))
          assert.strictEqual(refused._tag, "MergeConflict")
          assert.include(refused.message, "untracked working tree files would be overwritten")
          assert.include(refused.message, "src/own/x.ts")
        })
      )
  )
})
