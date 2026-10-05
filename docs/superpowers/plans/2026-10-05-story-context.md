# Story Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an `epic-stories` coder start each story and each task knowing where to go and what done looks like, and make `llm4ts profile` show when it did not.

**Architecture:** Three pure modules in `packages/flow` (an orientation digest over `git ls-files`, carried per-task findings, two new Story fields with mechanical anchor pruning) are wired into the existing seams: `startingCodeOf`/`storyPrompt` in `Stories.ts`, `implementPlanFlow` in `Flow.ts`, the planner/judge prompts in `flows/lib/epic-stories.ts`, and `profileOf` in the runner. Transcripts default on for epic-stories and are compacted, not deleted, on land.

**Tech Stack:** TypeScript, Effect 4.0.0 (services, `Schema.Class`, `Effect.gen`), `@effect/vitest`, pnpm workspace. Relative imports use `.ts` extensions; new flow modules are added to `packages/flow/package.json` `exports`.

**Spec:** `docs/superpowers/specs/2026-10-05-story-context-design.md`

## Global Constraints

- Effect pins are exact `4.0.0`; do not touch dependency versions.
- No `any`, no unchecked type assertions, no namespaces, no global `Error` as a domain error; expected failures are `Schema.TaggedError` (reuse `FlowError` members here, no new error types needed).
- Explicit package subpath exports: every new `packages/flow/src/X.ts` gets `"./X": "./dist/X.js"` in `packages/flow/package.json`.
- Tests are deterministic (`@effect/vitest`), use the in-src fakes (`makeMemoryPlainFileStore`, fake `GitToolShape`), never the network or a provider CLI.
- Existing story hashes must not change: `readFirst`/`acceptance` enter `storyHash` only when non-empty.
- Transcripts and the profile stay content-free where they were (`Timed` events carry no content; compacted transcripts keep no inputs, replies, tool args or outputs).
- Default budgets: orientation `8_000` chars (`LLM4TS_ORIENTATION_CHARS`), carried notes `6_000` chars, one findings section `1_500` chars.
- Verification before every commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (run `pnpm format` to fix formatting first).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A plan written before 2.29.0** (no `readFirst`/`acceptance` keys in its JSON block) must parse, keep every story's hash, and run unchanged. Pinned in Task 1 (`storyHash` unchanged test, `parseStoryPlan` without the keys).
2. **A coder that stops with `BLOCKED_ON:`** must still be detected: `blockedOnIn` reads the last non-empty line, so the findings request must tell the coder BLOCKED_ON stays last, and `findingsIn` must strip a trailing BLOCKED_ON line rather than swallow it. Pinned in Task 3.
3. **A `readFirst` folder, not a file** (e.g. `src/features/accounts`) must count as existing when any tracked file lies under it, and its files must join the starting code. Pinned in Task 1 (`pruneReadFirst` with a folder) and Task 4 (`startingCodeOf` lists the folder).
4. **An empty or huge repository** must not break the digest: zero tracked files → `undefined`; 20k files → capped at the budget with the head and tail kept. Pinned in Task 2.
5. **A trace from before 2.29.0** (tool events without `category`, or no tool events) must still profile: counts stay zero, `firstEditMs` absent, no finding emitted, existing fixtures unchanged. Pinned in Task 7.

---

### Task 1: Story schema — `readFirst`, `acceptance`, stable hash, anchor pruning

**Files:**

- Modify: `packages/flow/src/StoryPlan.ts`
- Test: `packages/flow/test/StoryPlan.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `Story.readFirst: ReadonlyArray<string>`, `Story.acceptance: ReadonlyArray<string>` (both default `[]`); `pruneReadFirst(plan: StoryPlan, known: ReadonlySet<string>): { readonly plan: StoryPlan; readonly dropped: ReadonlyArray<{ readonly story: string; readonly path: string }> }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/flow/test/StoryPlan.test.ts` (add `pruneReadFirst` to the import list from `@llm4ts/flow/StoryPlan`):

````ts
describe("readFirst and acceptance", () => {
  it("default to empty and leave an older story's hash unchanged", () => {
    const plain = story("accounts-page", ["src/features/accounts"])
    const withDefaults = Story.make({ ...plain, readFirst: [], acceptance: [] })
    assert.deepStrictEqual(plain.readFirst, [])
    assert.deepStrictEqual(plain.acceptance, [])
    assert.strictEqual(storyHash(withDefaults), storyHash(plain))
    const anchored = Story.make({ ...plain, readFirst: ["src/features/exemplar"] })
    const specified = Story.make({ ...plain, acceptance: ["/accounts lists the accounts"] })
    assert.notStrictEqual(storyHash(anchored), storyHash(plain))
    assert.notStrictEqual(storyHash(specified), storyHash(plain))
  })

  it.effect("parse a plan block written without the new keys, and render them when present", () =>
    Effect.gen(function* () {
      const older = [
        "# Epic: old",
        "",
        "```json storyplan",
        JSON.stringify({
          epicId: "old",
          epic: "Old epic.",
          stories: [
            {
              id: "a",
              title: "A",
              description: "Do a.",
              dependsOn: [],
              owned: ["src/a"],
              sharedReadOnly: [],
              provides: []
            }
          ]
        }),
        "```"
      ].join("\n")
      const parsed = yield* parseStoryPlan(older)
      assert.deepStrictEqual(parsed.stories[0]?.readFirst, [])
      assert.deepStrictEqual(parsed.stories[0]?.acceptance, [])

      const plan = StoryPlan.make({
        epicId: "new",
        epic: "New epic.",
        stories: [
          Story.make({
            ...story("a", ["src/a"]),
            readFirst: ["src/features/exemplar", "src/contracts/accounts.ts"],
            acceptance: ["GET /a answers 200", "a test beside the feature covers the list"]
          })
        ]
      })
      const rendered = yield* renderStoryPlan(plan)
      assert.include(rendered, "Done when:")
      assert.include(rendered, "1. GET /a answers 200")
      assert.include(rendered, "- read first: src/features/exemplar, src/contracts/accounts.ts")
      const reparsed = yield* parseStoryPlan(rendered)
      assert.deepStrictEqual(reparsed.stories[0]?.acceptance, plan.stories[0]?.acceptance)
    })
  )

  it("pruneReadFirst keeps anchors some tracked file lies under and drops the rest", () => {
    const plan = StoryPlan.make({
      epicId: "p",
      epic: "P.",
      stories: [
        Story.make({
          ...story("a", ["src/a"]),
          readFirst: ["src/features/exemplar", "src/contracts/accounts.ts", "src/nowhere"]
        }),
        Story.make({ ...story("b", ["src/b"]), readFirst: ["docs/missing.md"] })
      ]
    })
    const known = new Set(["src/features/exemplar/page.tsx", "src/contracts/accounts.ts"])
    const { plan: pruned, dropped } = pruneReadFirst(plan, known)
    assert.deepStrictEqual(pruned.stories[0]?.readFirst, [
      "src/features/exemplar",
      "src/contracts/accounts.ts"
    ])
    assert.deepStrictEqual(pruned.stories[1]?.readFirst, [])
    assert.deepStrictEqual(dropped, [
      { story: "a", path: "src/nowhere" },
      { story: "b", path: "docs/missing.md" }
    ])
    assert.strictEqual(pruneReadFirst(plan, known).plan.epicId, "p")
  })
})
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/StoryPlan.test.ts`
Expected: FAIL — `readFirst` is `undefined`, `pruneReadFirst` is not exported.

- [ ] **Step 3: Add the fields, the hash rule, the render lines and `pruneReadFirst`**

In `packages/flow/src/StoryPlan.ts`, inside `Story`, after `provides`:

```ts
  ,
  /**
   * Paths the planner says to read before touching anything: the exemplar
   * feature to imitate, the contract this story extends, the kit component to
   * reuse. Pruned to paths that exist; their contents open the starting code.
   */
  readFirst: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  /** Observable outcomes that make the story done; the coder plans against them, the judge scores against them. */
  acceptance: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  )
```

Replace `storyHash`:

```ts
/**
 * Stable over the story entry's content — a changed entry means a fresh
 * branch. The 2.29 fields enter only when set, so a plan written earlier
 * keeps every hash and an upgrade restarts no story.
 */
export const storyHash = (story: Story): string =>
  stableHash(
    JSON.stringify({
      id: story.id,
      title: story.title,
      description: story.description,
      dependsOn: [...story.dependsOn],
      owned: [...story.owned].map(normalizePath),
      sharedReadOnly: [...story.sharedReadOnly].map(normalizePath),
      provides: [...story.provides],
      ...(story.readFirst.length === 0
        ? {}
        : { readFirst: [...story.readFirst].map(normalizePath) }),
      ...(story.acceptance.length === 0 ? {} : { acceptance: [...story.acceptance] })
    })
  )
```

In `renderStoryPlan`, replace the per-story `lines.push(...)` with:

```ts
lines.push(
  `### ${story.id} — ${story.title}`,
  "",
  story.description.trim(),
  "",
  ...(story.acceptance.length === 0
    ? []
    : [
        "Done when:",
        "",
        ...story.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
        ""
      ]),
  `- depends on: ${list(story.dependsOn)}`,
  `- owned: ${list(story.owned)}`,
  `- shared read-only: ${list(story.sharedReadOnly)}`,
  `- read first: ${list(story.readFirst)}`,
  `- provides: ${list(story.provides)}`,
  ""
)
```

Add after `storyPlanViolations`:

```ts
/**
 * The plan with every `readFirst` anchor that no tracked file lies under
 * removed, and the list of what was dropped. A planner names paths from a
 * layout digest and sometimes guesses; a guess must not reach a coder as
 * something to read.
 */
export const pruneReadFirst = (
  plan: StoryPlan,
  known: ReadonlySet<string>
): {
  readonly plan: StoryPlan
  readonly dropped: ReadonlyArray<{ readonly story: string; readonly path: string }>
} => {
  const files = [...known].map(normalizePath)
  const dropped: Array<{ readonly story: string; readonly path: string }> = []
  const stories = plan.stories.map((story) => {
    const kept = story.readFirst.filter((anchor) => {
      const exists = files.some((file) => pathWithin(file, anchor))
      if (!exists) {
        dropped.push({ story: story.id, path: anchor })
      }
      return exists
    })
    return kept.length === story.readFirst.length ? story : new Story({ ...story, readFirst: kept })
  })
  return { plan: dropped.length === 0 ? plan : new StoryPlan({ ...plan, stories }), dropped }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/StoryPlan.test.ts test/Stories.test.ts`
Expected: PASS (the Stories tests still pass: the new fields default to empty).

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/StoryPlan.ts packages/flow/test/StoryPlan.test.ts
git commit -m "story plan: readFirst anchors and acceptance criteria, hash-stable for older plans

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Orientation digest — `packages/flow/src/Orientation.ts`

**Files:**

- Create: `packages/flow/src/Orientation.ts`
- Modify: `packages/flow/package.json` (exports)
- Test: `packages/flow/test/Orientation.test.ts`

**Interfaces:**

- Consumes: `cap` from `./Context.ts`.
- Produces:

  ```ts
  export interface OrientationInput {
    readonly files: ReadonlyArray<string>   // tracked, repo-relative
    readonly packageJson?: string            // the app's package.json text
    readonly appDir?: string                 // "." or a subfolder
    readonly budget: number                  // chars; <= 0 → undefined
  }
  export const defaultOrientationChars = 8_000
  export const orientationOf = (input: OrientationInput) => string | undefined
  export const orientationChars = (environment: Readonly<Record<string, string | undefined>>) => { readonly orientationChars?: number }
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/flow/test/Orientation.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { defaultOrientationChars, orientationChars, orientationOf } from "@llm4ts/flow/Orientation"

const files = [
  "package.json",
  "pnpm-lock.yaml",
  "CONTRIBUTING.md",
  "src/App.tsx",
  "src/kit/Button.tsx",
  "src/kit/Table.tsx",
  "src/features/accounts/page.tsx",
  "src/features/accounts/page.test.tsx",
  "src/features/accounts/messages.it.json",
  "src/features/accounts/messages.en.json",
  "src/features/transfers/page.tsx",
  "src/features/transfers/page.test.tsx",
  "src/contracts/accounts.ts",
  "src/contracts/accounts.fake.ts",
  "node_modules/left-pad/index.js",
  "dist/bundle.js",
  ".llm4ts/epics/x/plan.md"
]

const packageJson = JSON.stringify({
  name: "portal",
  scripts: { dev: "next dev", test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint ." }
})

describe("orientationOf", () => {
  it("lists folders with their file counts, small folders in full, and skips noise", () => {
    const text = orientationOf({ files, packageJson, appDir: ".", budget: defaultOrientationChars })
    assert.isDefined(text)
    assert.include(text, "## Repository orientation")
    assert.include(text, "src/ (11 files)")
    assert.include(text, "src/features/ (6 files)")
    assert.include(text, "src/kit/ (2 files)")
    // a small folder is listed in full, so the coder never runs `ls` on it
    assert.include(text, "src/kit/Button.tsx")
    assert.include(text, "src/contracts/accounts.fake.ts")
    assert.include(text, "package.json")
    assert.include(text, "CONTRIBUTING.md")
    assert.notInclude(text, "node_modules")
    assert.notInclude(text, "dist/")
    assert.notInclude(text, ".llm4ts")
    assert.notInclude(text, "pnpm-lock.yaml")
  })

  it("names the scripts and where the tests live", () => {
    const text = orientationOf({ files, packageJson, appDir: ".", budget: defaultOrientationChars })
    assert.include(
      text,
      "Scripts (package.json): dev: next dev; test: vitest run; typecheck: tsc --noEmit; lint: eslint ."
    )
    assert.include(
      text,
      "Tests live beside the code in: src/features/accounts (1), src/features/transfers (1)"
    )
  })

  it("says where the app lives when it is a subfolder", () => {
    const nested = files.map((file) => `frontend/${file}`)
    const text = orientationOf({ files: nested, packageJson, appDir: "frontend", budget: 8_000 })
    assert.include(text, "The application lives in frontend/")
    assert.include(text, "frontend/src/ (11 files)")
  })

  it("is undefined with no files or no budget, and never longer than the budget", () => {
    assert.isUndefined(orientationOf({ files: [], budget: 8_000 }))
    assert.isUndefined(orientationOf({ files, budget: 0 }))
    const many = Array.from({ length: 3_000 }, (_, index) => `src/gen/part${index}/file${index}.ts`)
    const text = orientationOf({ files: many, budget: 2_000 })
    assert.isDefined(text)
    assert.isAtMost(text.length, 2_000)
    assert.include(text, "## Repository orientation")
  })

  it("a folder too deep is summarised by its count, not expanded", () => {
    const deep = ["a/b/c/d/e/one.ts", "a/b/c/d/e/two.ts", "a/b/c/d/f/three.ts"]
    const text = orientationOf({ files: deep, budget: 8_000 })
    assert.include(text, "a/ (3 files)")
    assert.include(text, "a/b/c/d/e/one.ts")
  })
})

describe("orientationChars", () => {
  it("reads LLM4TS_ORIENTATION_CHARS and leaves the default otherwise", () => {
    assert.deepStrictEqual(orientationChars({}), {})
    assert.deepStrictEqual(orientationChars({ LLM4TS_ORIENTATION_CHARS: "0" }), {
      orientationChars: 0
    })
    assert.deepStrictEqual(orientationChars({ LLM4TS_ORIENTATION_CHARS: "12000" }), {
      orientationChars: 12_000
    })
    assert.deepStrictEqual(orientationChars({ LLM4TS_ORIENTATION_CHARS: "lots" }), {})
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Orientation.test.ts`
Expected: FAIL — module `@llm4ts/flow/Orientation` not found.

- [ ] **Step 3: Write the module**

Create `packages/flow/src/Orientation.ts`:

```ts
// The repository as a planner and a coder should see it before they look:
// a deterministic digest of the tracked files — folders with their counts,
// small folders in full, the package scripts, where the tests live. No model
// call, computed once per epic, so every story stops rediscovering the
// layout with `ls`, `find` and `grep` round trips.
import { cap } from "./Context.ts"

export interface OrientationInput {
  /** Tracked files, repo-relative, as `git ls-files` prints them. */
  readonly files: ReadonlyArray<string>
  /** The application's `package.json` text, when there is one. */
  readonly packageJson?: string
  /** Where the application lives: `.` for the repository root, else a subfolder. */
  readonly appDir?: string
  /** Characters the digest may take; `<= 0` leaves it out. */
  readonly budget: number
}

export const defaultOrientationChars = 8_000

/** Folders never worth a coder's attention: dependencies, build output, llm4ts state. */
const noiseDirs = new Set(["node_modules", "dist", "build", "out", "coverage", ".git", ".llm4ts"])
const noiseFiles = new Set(["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"])

/** Folders deeper than this are summarised by their count. */
const maxDepth = 3
/** A folder with this many files or fewer is listed in full. */
const smallFolder = 12
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/u

interface Folder {
  readonly path: string
  files: number
  readonly children: Map<string, Folder>
  readonly own: Array<string>
}

const folderOf = (path: string): Folder => ({ path, files: 0, children: new Map(), own: [] })

const isNoise = (file: string): boolean => {
  const parts = file.split("/")
  return parts.some((part) => noiseDirs.has(part)) || noiseFiles.has(parts.at(-1) ?? "")
}

const treeOf = (files: ReadonlyArray<string>): Folder => {
  const root = folderOf("")
  for (const file of files) {
    const parts = file.split("/").filter((part) => part.length > 0)
    let folder = root
    folder.files += 1
    for (const part of parts.slice(0, -1)) {
      let child = folder.children.get(part)
      if (child === undefined) {
        child = folderOf(folder.path.length === 0 ? part : `${folder.path}/${part}`)
        folder.children.set(part, child)
      }
      child.files += 1
      folder = child
    }
    folder.own.push(file)
  }
  return root
}

const allFiles = (folder: Folder): ReadonlyArray<string> => [
  ...folder.own,
  ...[...folder.children.values()].flatMap(allFiles)
]

const layoutLines = (folder: Folder, depth: number): ReadonlyArray<string> => {
  const indent = "  ".repeat(depth)
  const lines: Array<string> = []
  const children = [...folder.children.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  )
  for (const child of children) {
    lines.push(`${indent}${child.path}/ (${child.files} ${child.files === 1 ? "file" : "files"})`)
    if (child.files <= smallFolder) {
      for (const file of [...allFiles(child)].sort()) {
        lines.push(`${indent}  ${file}`)
      }
    } else if (depth + 1 < maxDepth) {
      lines.push(...layoutLines(child, depth + 1))
    }
  }
  return lines
}

const scriptsLine = (packageJson: string | undefined): string | undefined => {
  if (packageJson === undefined) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return undefined
  }
  const scripts = parsed.scripts
  if (typeof scripts !== "object" || scripts === null) {
    return undefined
  }
  const entries = Object.entries(scripts).flatMap(([name, command]) =>
    typeof command === "string" ? [`${name}: ${cap(command, 80).text}`] : []
  )
  return entries.length === 0 ? undefined : `Scripts (package.json): ${entries.join("; ")}`
}

const testsLine = (files: ReadonlyArray<string>): string | undefined => {
  const counts = new Map<string, number>()
  for (const file of files) {
    if (testFile.test(file) || file.includes("/__tests__/")) {
      const folder = file.split("/").slice(0, -1).join("/") || "."
      counts.set(folder, (counts.get(folder) ?? 0) + 1)
    }
  }
  if (counts.size === 0) {
    return undefined
  }
  const shown = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([folder, count]) => `${folder} (${count})`)
  const more = counts.size - shown.length
  return `Tests live beside the code in: ${shown.join(", ")}${more > 0 ? ` and ${more} more folder(s)` : ""}`
}

/**
 * The digest, or `undefined` when there is nothing to say (no tracked files)
 * or no budget. Never longer than `budget`: the head (the layout) and the
 * tail (scripts, tests) survive a cut, the middle of a long listing does not.
 */
export const orientationOf = (input: OrientationInput): string | undefined => {
  if (input.budget <= 0) {
    return undefined
  }
  const files = input.files.filter((file) => !isNoise(file))
  if (files.length === 0) {
    return undefined
  }
  const root = treeOf(files)
  const appDir = input.appDir ?? "."
  const text = [
    "## Repository orientation",
    "Tracked files by folder (counts; small folders listed in full) — go straight to the right",
    "place instead of listing directories or searching for where things live.",
    ...(appDir === "."
      ? []
      : [`The application lives in ${appDir}/ — its package.json, sources and tests.`]),
    "",
    ...[...root.own].sort(),
    ...layoutLines(root, 0),
    ...[scriptsLine(input.packageJson), testsLine(files)].flatMap((line) =>
      line === undefined ? [] : ["", line]
    )
  ].join("\n")
  return cap(text, input.budget).text
}

/**
 * LLM4TS_ORIENTATION_CHARS: how much of the repository digest the planner and
 * every coder see (0 leaves it out); the default otherwise.
 */
export const orientationChars = (
  environment: Readonly<Record<string, string | undefined>>
): { readonly orientationChars?: number } => {
  const raw = environment.LLM4TS_ORIENTATION_CHARS
  const value = Number(raw?.trim() ?? "")
  return raw === undefined || !Number.isInteger(value) || value < 0
    ? {}
    : { orientationChars: value }
}
```

Add to `packages/flow/package.json` `exports`, in alphabetical position after `"./NodePreflight"`:

```json
    "./Orientation": "./dist/Orientation.js",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Orientation.test.ts`
Expected: PASS. If the count assertions differ by the noise filter (e.g. `src/ (11 files)`), recount from the fixture: `src/` holds App.tsx, 2 kit, 6 features, 2 contracts = 11.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/Orientation.ts packages/flow/package.json packages/flow/test/Orientation.test.ts
git commit -m "flow: a deterministic repository orientation digest for planners and coders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Carried findings — `CarriedNotes.ts` and the `carry` option of `implementPlanFlow`

**Files:**

- Create: `packages/flow/src/CarriedNotes.ts`
- Modify: `packages/flow/src/Flow.ts` (`ImplementPlanOptions.carry`, the per-task ask)
- Modify: `packages/flow/package.json` (exports)
- Test: `packages/flow/test/CarriedNotes.test.ts`, `packages/flow/test/Flow.test.ts`

**Interfaces:**

- Consumes: `FlowError` from `./FlowError.ts`.
- Produces:

  ```ts
  export const notesHeading = "## Findings"
  export const findingsRequest: string
  export const findingsIn = (reply: string) => string | undefined
  export const notesLimit = 6_000
  export const appendNote = (
    notes: string | undefined,
    title: string,
    found: string,
    limit?: number
  ) => string
  export const withNotes = (prompt: string, notes: string | undefined) => string
  export interface CarriedNotes {
    readonly read: Effect.Effect<string | undefined, FlowError>
    readonly write: (notes: string) => Effect.Effect<void, FlowError>
  }
  ```

  and `ImplementPlanOptions.carry?: CarriedNotes` in `Flow.ts`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/flow/test/CarriedNotes.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import {
  appendNote,
  findingsIn,
  findingsRequest,
  notesHeading,
  withNotes
} from "@llm4ts/flow/CarriedNotes"

describe("findingsIn", () => {
  it("takes the text after the last Findings heading", () => {
    const reply = [
      "I added the page.",
      "",
      "## Findings",
      "- tests live beside the feature (page.test.tsx)",
      "- the kit Table takes `rows` and `columns`"
    ].join("\n")
    assert.strictEqual(
      findingsIn(reply),
      "- tests live beside the feature (page.test.tsx)\n- the kit Table takes `rows` and `columns`"
    )
    assert.strictEqual(findingsIn("### findings\nonly this"), "only this")
  })

  it("is undefined without a heading or with an empty section, and keeps BLOCKED_ON out of it", () => {
    assert.isUndefined(findingsIn("done, nothing to report"))
    assert.isUndefined(findingsIn("## Findings\n\n   "))
    assert.strictEqual(
      findingsIn("## Findings\n- the route exists\nBLOCKED_ON: src/kit/Money.ts from story kit"),
      "- the route exists"
    )
  })

  it("caps a long section", () => {
    const long = `## Findings\n${"x".repeat(5_000)}`
    const found = findingsIn(long)
    assert.isDefined(found)
    assert.isAtMost(found.length, 1_500)
  })
})

describe("appendNote and withNotes", () => {
  it("adds a titled section and drops the oldest when over the limit", () => {
    const first = appendNote(undefined, "first task", "- a")
    assert.strictEqual(first, "### first task\n- a")
    const second = appendNote(first, "second task", "- b")
    assert.strictEqual(second, "### first task\n- a\n\n### second task\n- b")
    const trimmed = appendNote(second, "third task", `- ${"c".repeat(40)}`, 60)
    assert.notInclude(trimmed, "### first task")
    assert.include(trimmed, "### third task")
  })

  it("the newest section always survives, even alone over the limit", () => {
    const only = appendNote(undefined, "big", "y".repeat(100), 20)
    assert.include(only, "### big")
  })

  it("withNotes prepends what earlier tasks learned, or leaves the prompt alone", () => {
    assert.strictEqual(withNotes("do it", undefined), "do it")
    assert.strictEqual(withNotes("do it", "   "), "do it")
    const prompt = withNotes("do it", "### first\n- tests live in src/x")
    assert.isTrue(prompt.startsWith("What earlier tasks of this story learned"))
    assert.include(prompt, "- tests live in src/x")
    assert.isTrue(prompt.endsWith("do it"))
  })

  it("the request names the heading and keeps BLOCKED_ON last", () => {
    assert.include(findingsRequest, notesHeading)
    assert.include(findingsRequest, "BLOCKED_ON:")
  })
})
```

- [ ] **Step 2: Write the failing Flow test**

Append to `packages/flow/test/Flow.test.ts` inside the existing `describe` that holds the `chatPerTask` tests (the imports `makeMemoryPlainFileStore`, `makePlanStore`, `messageSnapshotCoderService`, `makeFakeGit`, `failingHosting`, `cleanReviewer`, `Plan`, `Task`, `Ref`, `Message` are already there):

```ts
it.effect("carry: a task's Findings section is saved and opens the next task's prompt", () =>
  Effect.gen(function* () {
    const events = yield* makeFlowEventHub()
    const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
    const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
    const memory = yield* makeMemoryPlainFileStore()
    const store = makePlanStore(memory.store)
    const plan = Plan.make({
      epicId: "epic-carry",
      tasks: [
        Task.make({ title: "first task", description: "do the first thing" }),
        Task.make({ title: "second task", description: "do the second thing" })
      ]
    })
    const context: FlowContextShape = {
      reasoning: cleanReviewer,
      coder: messageSnapshotCoderService(
        snapshots,
        "did it\n\n## Findings\n- tests live in src/x\n- use kit Table"
      ),
      git: makeFakeGit(gitLog),
      hosting: failingHosting,
      events,
      reviewers: [cleanReviewer],
      coderCapabilities: ConnectorCapabilities.make({}),
      userPrompt: "implement the plan",
      workDir: "/repo",
      workspace: "/repo"
    }

    yield* implementPlanFlow(context, {
      store,
      planPath: ".llm4ts/plan-carry.md",
      plan: Effect.succeed(plan),
      chatPerTask: true,
      carry: {
        read: memory.store.read(".llm4ts/notes.md"),
        write: (notes) => memory.store.writeAtomic(".llm4ts/notes.md", notes)
      }
    })

    const seen = yield* Ref.get(snapshots)
    const userPrompt = (index: number) =>
      seen[index]?.filter((message) => message.role === "User").at(-1)?.content ?? ""
    // The first task is asked for findings and gets none to start from.
    assert.isTrue(userPrompt(0).startsWith("do the first thing"))
    assert.include(userPrompt(0), "## Findings")
    // The second starts from what the first learned.
    assert.isTrue(userPrompt(1).startsWith("What earlier tasks of this story learned"))
    assert.include(userPrompt(1), "- tests live in src/x")
    assert.include(userPrompt(1), "do the second thing")
    const notes = yield* memory.store.read(".llm4ts/notes.md")
    assert.include(notes ?? "", "### first task")
    assert.include(notes ?? "", "### second task")
  })
)
```

If `GitLog` or `makeFakeGit` are named differently in this test file, use the names the `chatPerTask` tests above it use.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/CarriedNotes.test.ts test/Flow.test.ts`
Expected: FAIL — module not found; `carry` is not a known option.

- [ ] **Step 4: Write the module and wire the option**

Create `packages/flow/src/CarriedNotes.ts`:

```ts
// What a story's earlier tasks learned, carried into the next task's prompt.
// With one chat per task (ADR 0003) every task starts cold; without this a
// six-task story explores the repository six times. The coder ends each task
// with a short Findings section; code saves it beside the story and prepends
// the accumulated notes to the next task. Pure helpers here, the seam in Flow.
import type * as Effect from "effect/Effect"
import type { FlowError } from "./FlowError.ts"

export const notesHeading = "## Findings"

/** Appended to every task prompt that carries notes. */
export const findingsRequest = [
  "",
  `When the task is done, end your reply with a section headed \`${notesHeading}\` of at most`,
  "ten lines: files you read or changed that matter for the rest of this story, conventions",
  "you learned (where tests live, how a feature is registered, which kit component to use),",
  "and commands that worked. Nothing follows it — unless you must stop with BLOCKED_ON:,",
  "which stays the last line."
].join("\n")

const sectionChars = 1_500
const headingPattern = /^#{1,3}[ \t]*findings[ \t]*$/imu
const blockedLine = /^BLOCKED_ON:.*$/u

/**
 * The text after the LAST Findings heading, without a trailing BLOCKED_ON
 * line (that stays the reply's last line for `blockedOnIn`), capped;
 * undefined when there is no heading or nothing under it.
 */
export const findingsIn = (reply: string): string | undefined => {
  let last: RegExpExecArray | undefined
  const pattern = new RegExp(
    headingPattern.source,
    headingPattern.flags.includes("g") ? headingPattern.flags : `${headingPattern.flags}g`
  )
  for (let match = pattern.exec(reply); match !== null; match = pattern.exec(reply)) {
    last = match
  }
  if (last === undefined) {
    return undefined
  }
  const lines = reply
    .slice(last.index + last[0].length)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
  while (lines.length > 0 && (lines.at(-1) ?? "").trim().length === 0) {
    lines.pop()
  }
  if (lines.length > 0 && blockedLine.test((lines.at(-1) ?? "").trim())) {
    lines.pop()
  }
  const text = lines.join("\n").trim()
  return text.length === 0 ? undefined : text.slice(0, sectionChars)
}

export const notesLimit = 6_000

/**
 * `notes` plus a titled section for `found`; when the result is over `limit`
 * the oldest sections go first, the newest always stays.
 */
export const appendNote = (
  notes: string | undefined,
  title: string,
  found: string,
  limit = notesLimit
): string => {
  const sections = [
    ...(notes === undefined || notes.trim().length === 0 ? [] : notes.split(/\n\n(?=### )/u)),
    `### ${title}\n${found.trim()}`
  ]
  while (sections.length > 1 && sections.join("\n\n").length > limit) {
    sections.shift()
  }
  return sections.join("\n\n")
}

/** The prompt with the notes in front, or the prompt itself when there are none. */
export const withNotes = (prompt: string, notes: string | undefined): string =>
  notes === undefined || notes.trim().length === 0
    ? prompt
    : [
        "What earlier tasks of this story learned — trust it before exploring:",
        "",
        notes.trim(),
        "",
        "---",
        "",
        prompt
      ].join("\n")

/** Where a story keeps its carried notes: read before a task, written after it. */
export interface CarriedNotes {
  readonly read: Effect.Effect<string | undefined, FlowError>
  readonly write: (notes: string) => Effect.Effect<void, FlowError>
}
```

Simplify `findingsIn`'s pattern construction if the lint complains: define `const headingPattern = /^#{1,3}[ \t]*findings[ \t]*$/gimu` once and reset `headingPattern.lastIndex = 0` before the loop instead of rebuilding it.

In `packages/flow/src/Flow.ts`:

Add the import:

```ts
import {
  appendNote,
  findingsIn,
  findingsRequest,
  withNotes,
  type CarriedNotes
} from "./CarriedNotes.ts"
```

Add to `ImplementPlanOptions` after `satisfiedProbe`:

```ts
  /**
   * Notes carried from one task to the next (meant for `chatPerTask`, where
   * every task starts cold): the accumulated notes open each task's prompt,
   * the task is asked to end with a Findings section, and what it reports is
   * appended. Omit to carry nothing.
   */
  readonly carry?: CarriedNotes
```

Replace the line `yield* coder.ask(plan.taskPrompt(task))` and its comment block with:

```ts
// `plan.taskPrompt` deliberately reads the frozen `plan` captured at
// the top of this function: a task prompt only needs that task's own
// details. `planSoFar`, threaded through by implementTaskLoop, is the
// single source of truth for completion progress instead.
const notes = options.carry === undefined ? undefined : yield * options.carry.read
const reply =
  yield *
  coder.ask(
    options.carry === undefined
      ? plan.taskPrompt(task)
      : `${withNotes(plan.taskPrompt(task), notes)}\n${findingsRequest}`
  )
if (options.carry !== undefined) {
  const found = findingsIn(reply)
  if (found !== undefined) {
    yield * options.carry.write(appendNote(notes, task.title, found))
  }
}
```

Add to `packages/flow/package.json` `exports` after `"./CapabilityGuard"`:

```json
    "./CarriedNotes": "./dist/CarriedNotes.js",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/CarriedNotes.test.ts test/Flow.test.ts`
Expected: PASS, including the older `chatPerTask` tests (no `carry` → prompts unchanged).

- [ ] **Step 6: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/CarriedNotes.ts packages/flow/src/Flow.ts packages/flow/package.json packages/flow/test/CarriedNotes.test.ts packages/flow/test/Flow.test.ts
git commit -m "flow: carry each task's Findings into the next task's prompt

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Stories — anchors open the starting code, acceptance in the prompts, notes carried per story

**Files:**

- Modify: `packages/flow/src/Stories.ts` (`startingCodeOf`, `storyPrompt`, `storyTaskPlanInstructions`, the `implementPlanFlow` call)
- Test: `packages/flow/test/Stories.test.ts`

**Interfaces:**

- Consumes: `Story.readFirst`, `Story.acceptance` (Task 1); `ImplementPlanOptions.carry` (Task 3).
- Produces: `storyPrompt(story)` ends with a numbered "Done when" list when `acceptance` is set; `startingCodeOf` opens with a "Read first" section; the story's notes live at `<stateDir>/stories/<id>.notes.md`.

- [ ] **Step 1: Write the failing tests**

In `packages/flow/test/Stories.test.ts`, add `storyPrompt` and `storyTaskPlanInstructions` to the import from `@llm4ts/flow/Stories`, then append:

```ts
describe("story prompts carry the acceptance criteria", () => {
  const specified = Story.make({
    ...story("a"),
    acceptance: ["GET /a answers 200", "a test beside the feature covers the list"]
  })

  it("storyPrompt ends with a numbered Done when list", () => {
    const prompt = storyPrompt(specified)
    assert.include(prompt, "Done when (each must hold, observably):")
    assert.include(prompt, "1. GET /a answers 200")
    assert.include(prompt, "2. a test beside the feature covers the list")
    assert.notInclude(storyPrompt(story("b")), "Done when")
  })

  it("storyTaskPlanInstructions ask every task to name the criteria it satisfies", () => {
    const instructions = storyTaskPlanInstructions(specified)
    assert.include(instructions, "1. GET /a answers 200")
    assert.include(instructions, "Satisfies: <n>")
    assert.notInclude(storyTaskPlanInstructions(story("b")), "Satisfies:")
  })
})
```

Then extend the existing test `"gives the coder the code it starts from, and says the gates run after each task"`: change the `diamond` plan it uses to one whose story `a` has `readFirst: ["src/features/exemplar"]`, add the exemplar file to the memory store and to `listed`, and assert the order. Concretely, inside that test:

```ts
const anchored = StoryPlan.make({
  ...diamond,
  stories: diamond.stories.map((item) =>
    item.id === "a" ? Story.make({ ...item, readFirst: ["src/features/exemplar"] }) : item
  )
})
const memory =
  yield *
  makeMemoryPlainFileStore({
    "/repo/.llm4ts/worktrees/a/src/kit/Button.tsx": "export const Button = () => null",
    "/repo/.llm4ts/worktrees/a/src/features/a/index.ts": "export const a = 1",
    "/repo/.llm4ts/worktrees/a/src/features/exemplar/page.tsx": "export const Exemplar = () => null"
  })
const listed: Readonly<Record<string, ReadonlyArray<string>>> = {
  "src/kit": ["src/kit/Button.tsx"],
  "src/features/a": ["src/features/a/index.ts"],
  "src/features/exemplar": ["src/features/exemplar/page.tsx"]
}
```

use `anchored` wherever the test used `diamond` (`makeOptions(harness, anchored, …)`, `storyOf(anchored, workDir)`, `plan.story(...)` in the git fake), and add at the end:

```ts
assert.include(all, "Read first — what the planner says to imitate or build on:")
assert.include(all, "### src/features/exemplar/page.tsx")
assert.isBelow(
  all.indexOf("### src/features/exemplar/page.tsx"),
  all.indexOf("### src/kit/Button.tsx")
)
```

Add a new test after it:

```ts
it.effect("a task's Findings are kept beside the story and shown to the next task", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness()
    const context = yield* makeContext(harness)
    const memory = yield* makeMemoryPlainFileStore()
    const prompts: Array<string> = []
    const options = yield* makeOptions(harness, single, context, {
      concurrency: 1,
      files: memory.store,
      planTasks: () =>
        Effect.succeed(
          Plan.make({
            epicId: "a",
            tasks: [
              Task.make({ title: "first", description: "do the first thing" }),
              Task.make({ title: "second", description: "do the second thing" })
            ]
          })
        ),
      contextFor: (workDir) => {
        const story = storyOf(single, workDir)
        return Effect.succeed({
          context: {
            ...context,
            coder: {
              ...coder("done"),
              executeStreamWithHistory: (messages) => {
                const user = messages.filter((message) => message.role === "User").at(-1)
                if (user !== undefined) prompts.push(user.content)
                return Stream.make(
                  LlmChunk.make({
                    delta: "did it\n\n## Findings\n- tests live in src/features/a",
                    finishReason: "stop"
                  })
                )
              }
            },
            git: worktreeGit(harness, workDir, story),
            workDir
          }
        })
      }
    })
    yield* implementStoriesFlow(context, options)
    const notes = yield* memory.store.read("/repo/.llm4ts/epics/single/stories/a.notes.md")
    assert.include(notes ?? "", "### first")
    assert.include(notes ?? "", "- tests live in src/features/a")
    const second = prompts.find((prompt) => prompt.includes("do the second thing"))
    assert.isDefined(second)
    assert.isTrue(second.startsWith("What earlier tasks of this story learned"))
  })
)
```

If the harness's `worktreeGit` reports an empty diff for a task (so the task is confirmed via the no-op path), the second user prompt is still the task ask; keep the `find` by task text as written.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Stories.test.ts`
Expected: FAIL — no "Done when", no "Read first", no notes file.

- [ ] **Step 3: Change `Stories.ts`**

`startingCodeOf`: replace the body after `const owned = …` so the anchors come first and a file is shown once:

```ts
const anchors = yield * git.listFiles(story.readFirst)
const shared = yield * git.listFiles(story.sharedReadOnly)
const owned = yield * git.listFiles(story.owned)
if (anchors.length + shared.length + owned.length === 0) {
  return undefined
}
let left = budget
const leftOut: Array<string> = []
const shown = new Set<string>()
const section = (title: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parts: Array<string> = []
    for (const path of paths) {
      if (shown.has(path)) {
        continue
      }
      const text = yield* Effect.orElseSucceed(files.read(join(worktree, path)), () => undefined)
      if (text === undefined || left <= 0) {
        leftOut.push(path)
        continue
      }
      shown.add(path)
      const piece = cap(text, Math.min(fileChars, left)).text
      left -= piece.length
      parts.push(`### ${path}\n\`\`\`\n${piece}\n\`\`\``)
    }
    return parts.length === 0 ? [] : [title, ...parts]
  })
return [
  "## The code you start from",
  "Read this before exploring: it is the current content of the files below.",
  ...(yield * section("Read first — what the planner says to imitate or build on:", anchors)),
  ...(yield * section("Shared, read-only — use these as they are:", shared)),
  ...(yield * section("Yours — the story's owned files so far:", owned)),
  ...(leftOut.length === 0 ? [] : [`Not shown (over the budget): ${leftOut.join(", ")}`])
].join("\n\n")
```

Also update the function's doc comment: "the planner's read-first anchors, then the shared read-only files it builds on, then the files it owns".

`storyPrompt`:

```ts
const numbered = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.map((item, index) => `${index + 1}. ${item}`)

export const storyPrompt = (story: Story): string =>
  [
    `Story: ${story.title}`,
    "",
    story.description.trim(),
    ...(story.acceptance.length === 0
      ? []
      : ["", "Done when (each must hold, observably):", ...numbered(story.acceptance)])
  ].join("\n")
```

`storyTaskPlanInstructions`: insert after the `bullets(story.owned)` line:

```ts
    ...(story.acceptance.length === 0
      ? []
      : [
          "The story is done when every one of these holds:",
          ...numbered(story.acceptance),
          "End every task's description with `Satisfies: <n>` naming the criteria it serves, and",
          "make sure every criterion is served by at least one task."
        ]),
```

Add the notes path next to `findingsPath` in `implementStoriesFlow`:

```ts
/** What the coder's tasks learned, carried into the next task of the same story. */
const notesPath = (story: Story): string => join(options.stateDir, `stories/${story.id}.notes.md`)
```

And in the `implementPlanFlow(storyContext, { … })` call, after `chatPerTask: true,`:

```ts
      carry: {
        read: files.read(notesPath(story)),
        write: (notes) => files.writeAtomic(notesPath(story), notes)
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @llm4ts/flow exec vitest run test/Stories.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/Stories.ts packages/flow/test/Stories.test.ts
git commit -m "stories: anchors open the starting code, acceptance in the prompts, notes carried per story

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Planner, judge and coder system prompt in `epic-stories`

**Files:**

- Modify: `flows/lib/epic-stories.ts` (`storyPlanJsonSchema`, `storyPlanInstructions`, `generateStoryPlan`, `refinePlanInstructions`/`RefinePlanInputs`, `storyDimensions`, `storyJudgeQuery`, the run body)
- Modify: `flows/lib/story-board.ts` (`StoryBrief`, `storyBriefOf`, `stateOf`)
- Test: `flows/test/epic-stories.test.ts`, `flows/test/story-board.test.ts`

**Interfaces:**

- Consumes: `Story.readFirst`/`acceptance`, `pruneReadFirst` (Task 1); `orientationOf`, `orientationChars`, `defaultOrientationChars` (Task 2).
- Produces:

  ```ts
  export const storyPlanInstructions = (epicId: string, guidance: string, orientation?: string) =>
    string
  export const generateStoryPlan = (
    reasoning,
    events,
    epic,
    epicId,
    guidance,
    brief?: string,
    orientation?: string
  ) => Effect<StoryPlan, FlowLlmError>
  export const orientationFor = (
    git: GitToolShape,
    files: PlainFileStoreShape,
    workDir: string,
    appDir: string,
    environment
  ) => Effect<string | undefined, FlowError>
  export const pruneUnknownAnchors = (
    plan: StoryPlan,
    git: GitToolShape,
    events: FlowEventsShape
  ) => Effect<StoryPlan, FlowError>
  ```

  `RefinePlanInputs.orientation?: string`; `StoryBrief.acceptance`.

- [ ] **Step 1: Write the failing tests**

In `flows/test/epic-stories.test.ts`, add `orientationFor`, `pruneUnknownAnchors`, `storyJudgeQuery` to the import from `../lib/epic-stories.ts` (whatever relative path the file already uses for `storyPlanInstructions`), and `Story`, `StoryPlan` to the `@llm4ts/flow/StoryPlan` import. Extend the test at the line `assert.include(storyPlanInstructions("conto-bonifico", "rules"), "pairwise DISJOINT")` with:

```ts
const instructions = storyPlanInstructions(
  "conto-bonifico",
  "rules",
  "## Repository orientation\nsrc/ (3 files)"
)
assert.include(instructions, "`readFirst`")
assert.include(instructions, "`acceptance`")
assert.include(instructions, '"readFirst":[],"acceptance":[]')
assert.include(instructions, "## Repository orientation\nsrc/ (3 files)")
assert.notInclude(storyPlanInstructions("conto-bonifico", "rules"), "Repository layout")
```

Append new tests:

```ts
describe("pruneUnknownAnchors", () => {
  const plan = StoryPlan.make({
    epicId: "p",
    epic: "P.",
    stories: [
      Story.make({
        id: "a",
        title: "A",
        description: "Do a.",
        owned: ["src/a"],
        readFirst: ["src/features/exemplar", "src/ghost.ts"],
        acceptance: ["GET /a answers 200"]
      })
    ]
  })
  const gitListing = (known: ReadonlyArray<string>): GitToolShape =>
    ({
      ...fakeGit,
      listFiles: (paths) =>
        Effect.succeed(known.filter((file) => paths.some((prefix) => file.startsWith(prefix))))
    }) as GitToolShape

  it.effect("drops anchors no tracked file lies under and says so", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const pruned = yield* pruneUnknownAnchors(
        plan,
        gitListing(["src/features/exemplar/page.tsx"]),
        events
      )
      assert.deepStrictEqual(pruned.stories[0]?.readFirst, ["src/features/exemplar"])
      const notes = (yield* events.recorded).flatMap((event) =>
        event._tag === "Info" ? [event.message] : []
      )
      assert.include(notes.join("\n"), "a: src/ghost.ts")
    })
  )
})

describe("orientationFor", () => {
  it.effect(
    "digests the tracked files and the app's package.json, within LLM4TS_ORIENTATION_CHARS",
    () =>
      Effect.gen(function* () {
        const memory = yield* makeMemoryPlainFileStore({
          "/repo/frontend/package.json": JSON.stringify({ scripts: { test: "vitest run" } })
        })
        const git = {
          ...fakeGit,
          listFiles: () => Effect.succeed(["frontend/package.json", "frontend/src/App.tsx"])
        } as GitToolShape
        const text = yield* orientationFor(git, memory.store, "/repo", "frontend", {})
        assert.include(text ?? "", "frontend/src/ (1 file)")
        assert.include(text ?? "", "Scripts (package.json): test: vitest run")
        const off = yield* orientationFor(git, memory.store, "/repo", "frontend", {
          LLM4TS_ORIENTATION_CHARS: "0"
        })
        assert.isUndefined(off)
      })
  )
})

describe("storyJudgeQuery", () => {
  it("lists the acceptance criteria the judge scores against", () => {
    const specified = Story.make({
      id: "a",
      title: "A",
      description: "Do a.",
      owned: ["src/a"],
      acceptance: ["GET /a answers 200"]
    })
    const query = storyJudgeQuery(specified)
    assert.include(query, "Done when (the story's acceptance criteria")
    assert.include(query, "1. GET /a answers 200")
  })
})
```

`fakeGit` and `makeCollectingFlowEvents`: the test file already builds fake `GitToolShape` objects for `implementStoriesFlow` tests; reuse the one it has (search for `listFiles: () => Effect.succeed([])` in the file) under the name it uses, or define `const fakeGit = { … }` from that object. Import `makeCollectingFlowEvents` from `@llm4ts/flow/FlowEvents` if it is not already imported.

In `flows/test/story-board.test.ts`, extend `"the brief carries the dependencies' declared interface"`:

```ts
const brief = storyBriefOf(Story.make({ ...story, acceptance: ["the list renders"] }), plan)
assert.deepStrictEqual(brief.acceptance, ["the list renders"])
assert.include(stateOf(brief, "+ diff", "rules"), "Done when")
```

(import `stateOf` and `Story` if needed).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run flows/test/epic-stories.test.ts flows/test/story-board.test.ts`
Expected: FAIL — exports missing, instructions lack the rules.

- [ ] **Step 3: Change `flows/lib/epic-stories.ts`**

Imports to add:

```ts
import { defaultOrientationChars, orientationChars, orientationOf } from "@llm4ts/flow/Orientation"
import type { GitToolShape } from "@llm4ts/flow/GitTool"
```

and add `pruneReadFirst` to the existing `@llm4ts/flow/StoryPlan` import.

`storyPlanJsonSchema`: add inside `properties` of a story:

```ts
          readFirst: { type: "array", items: { type: "string" } },
          acceptance: { type: "array", items: { type: "string" } }
```

and to its `required`: `"readFirst", "acceptance"`.

`storyPlanInstructions`:

```ts
export const storyPlanInstructions = (
  epicId: string,
  guidance: string,
  /** The repository digest (`orientationOf`): the paths the planner may name. */
  orientation?: string
): string =>
  [
    "You are the orchestrator of a parallel implementation. Split the epic below into stories",
    "that independent coding agents will implement AT THE SAME TIME, each in its own git worktree,",
    "each confined to the paths it owns. Dependencies are declared here and never discovered later.",
    "",
    "Rules (violations are rejected mechanically):",
    "- Every story has a kebab-case id, a title, a description precise enough to implement alone,",
    "  `dependsOn` (ids it must wait for), `owned` (repo-relative path prefixes it may create or",
    "  change), `sharedReadOnly` (prefixes it may read but never change), `readFirst`, `acceptance`,",
    "  and `provides` (routes, exports, contracts other stories may rely on).",
    "- `readFirst`: one to four EXISTING repo-relative paths (files or folders) the coder must read",
    "  before touching anything — the exemplar feature to imitate, the contract the story extends,",
    "  the kit component to reuse. Name them from the repository layout below; a path that does",
    "  not exist there is dropped.",
    "- `acceptance`: two to six observable outcomes that make the story done, each checkable from",
    "  the diff by a reviewer who will not run the app (a route that answers, a screen that shows",
    "  X, a test file beside the feature that covers Y). The coder plans its tasks against them",
    "  and the judge scores against them.",
    "- `owned` sets are pairwise DISJOINT: no path prefix appears under two stories.",
    "- Shared surfaces (the kit, the theme, house rules) are never edited by a feature story. A new",
    "  shared component is its own story, and every story using it depends on it.",
    "- Every new service domain is its own contract story (contract + fake routes) that the pages",
    "  depend on.",
    "- Exactly ONE story owns the composition point (`src/App.tsx`): the fan-in that depends on",
    "  every screen story and wires them in.",
    "- A story fits one agent session: one screen, one contract, or one component.",
    "- Every story OWNS the test files it must write (the judge asks for tests): list them",
    "  in `owned` explicitly — a story cannot add a test outside its owned paths.",
    `- Use exactly this epicId: "${epicId}". Copy the epic text into "epic".`,
    "",
    "Respond only with JSON:",
    '{"epicId":"...","epic":"...","stories":[{"id":"...","title":"...","description":"...",',
    '"dependsOn":[],"owned":[],"sharedReadOnly":[],"readFirst":[],"acceptance":[],"provides":[]}]}',
    "",
    "Target repository guidance (house rules and layout — the vocabulary to use):",
    guidance,
    ...(orientation === undefined
      ? []
      : [
          "",
          "Repository layout (tracked files per folder, scripts, where tests live):",
          orientation
        ])
  ].join("\n")
```

`generateStoryPlan`: add a trailing parameter `orientation?: string` and pass it: `storyPlanInstructions(epicId, guidance, orientation)`.

`RefinePlanInputs`: add `readonly orientation?: string`. In `refinePlanInstructions`, add two rules after the `provides` rule:

```ts
    "- `readFirst` names one to four existing paths the coder reads before changing anything;",
    "  `acceptance` lists two to six observable outcomes a reviewer can check from the diff.",
```

update its JSON example to include `"readFirst":[],"acceptance":[]`, and append the orientation block exactly as in `storyPlanInstructions`. Pass `orientation` where `refinePlanInstructions` inputs are built in the run body (search `refinePlanInstructions(` / `generateRefineProposal(`; add `...(orientation === undefined ? {} : { orientation })`).

New helpers, placed after `storyContextChars`:

```ts
/**
 * The repository as the planner and every coder see it before they look: a
 * digest of the epic checkout's tracked files (`orientationOf`), no model
 * call, within LLM4TS_ORIENTATION_CHARS.
 */
export const orientationFor = (
  git: GitToolShape,
  files: PlainFileStoreShape,
  workDir: string,
  appDir: string,
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<string | undefined, FlowError> =>
  Effect.gen(function* () {
    const chars = orientationChars(environment).orientationChars ?? defaultOrientationChars
    if (chars <= 0) {
      return undefined
    }
    const tracked = yield* git.listFiles(["."])
    const manifest =
      appDir === "." ? join(workDir, "package.json") : join(workDir, appDir, "package.json")
    const packageJson = yield* Effect.orElseSucceed(files.read(manifest), () => undefined)
    return orientationOf({
      files: tracked,
      ...(packageJson === undefined ? {} : { packageJson }),
      appDir,
      budget: chars
    })
  })

/**
 * The plan with every `readFirst` anchor that is not in the checkout removed
 * (`pruneReadFirst` over `git ls-files`), the drops named in an Info note.
 */
export const pruneUnknownAnchors = (
  plan: StoryPlan,
  git: GitToolShape,
  events: FlowEventsShape
): Effect.Effect<StoryPlan, FlowError> =>
  Effect.gen(function* () {
    const wanted = [...new Set(plan.stories.flatMap((story) => story.readFirst))]
    if (wanted.length === 0) {
      return plan
    }
    const known = new Set(yield* git.listFiles(wanted))
    const { plan: pruned, dropped } = pruneReadFirst(plan, known)
    if (dropped.length > 0) {
      yield* events.publish(
        Info.make({
          message: `story plan: dropped ${dropped.length} readFirst path(s) that are not in the repository: ${dropped
            .map((drop) => `${drop.story}: ${drop.path}`)
            .join(", ")}`
        })
      )
    }
    return pruned
  })
```

Run body (inside the `runNode` callback):

1. Move the line `const appDir = yield* appDirFor(input.workDir, process.env)` from its current place (before `appDirNote`) up to just after `const guidance = …` so it is known before planning; delete the later duplicate.
2. After it: `const orientation = yield* orientationFor(context.git, files, input.workDir, appDir, process.env)`.
3. In the `"story plan"` stage, replace the `generateStoryPlan(…)` call with:

```ts
generateStoryPlan(
  reasoningMeter.service,
  events,
  input.prompt,
  epicId,
  guidance,
  brief,
  orientation
).pipe(Effect.flatMap((generated) => pruneUnknownAnchors(generated, context.git, events)))
```

4. In `system: (story) => Effect.succeed([...])`, append after `...appDirNote`:

```ts
                    ...(orientation === undefined ? [] : ["", orientation])
```

Judge:

```ts
  Dimension.make({
    name: "provides",
    rubric:
      "Everything the story promised to provide (routes, exports, contracts) exists in the diff and is complete enough for a dependent story to use, and every acceptance criterion listed under 'Done when' is observably met. 2 = all present, complete, every criterion met; 1 = present but partial, or a criterion unmet; 0 = missing."
  }),
```

In `storyJudgeQuery`, after `story.description,` insert:

```ts
    ...(story.acceptance.length === 0
      ? []
      : [
          "",
          "Done when (the story's acceptance criteria — `provides` is scored against them too):",
          ...story.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`)
        ]),
```

`flows/lib/story-board.ts`: add `acceptance: Schema.Array(Schema.String)` to `StoryBrief`; set `acceptance: story.acceptance` in `storyBriefOf`; in `stateOf`, after `brief.description,` insert the same "Done when" block using `brief.acceptance`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run flows/test/epic-stories.test.ts flows/test/story-board.test.ts`
Expected: PASS. If the committed demo plan fixture test (`"the committed Conto e Bonifico plan is valid…"`) still passes unchanged, good: the fixture has no new keys and defaults apply.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add flows/lib/epic-stories.ts flows/lib/story-board.ts flows/test/epic-stories.test.ts flows/test/story-board.test.ts
git commit -m "epic-stories: the planner sees the repository and names anchors and acceptance; the judge scores against them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Transcripts on by default for epic-stories, compacted on land

**Files:**

- Modify: `flows/lib/epic-stories.ts` (`storiesEnvironment`, `compactTranscripts` replacing `removeTranscripts`, the two call sites)
- Modify: `flows/epic-stories.ts` (header comment), `packages/flow/src/Transcript.ts` (doc comment), `packages/shell/src/Cli.ts` (`--transcript` description), `docs/configuration.md`
- Test: `flows/test/epic-stories.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export const storiesEnvironment = (environment: Readonly<Record<string, string | undefined>>) =>
    Readonly<Record<string, string | undefined>>
  export const compactTranscripts = (workDir: string, runIds: ReadonlyArray<string>) =>
    Effect.Effect<number>
  ```

- [ ] **Step 1: Write the failing tests**

In `flows/test/epic-stories.test.ts`, replace the `describe("removeTranscripts", …)` block with:

```ts
describe("compactTranscripts", () => {
  it.effect("keeps the shape of the named runs' transcripts and removes their content", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-transcripts-")))
      const dir = (run: string) => join(root, ".llm4ts", "transcripts", run)
      const entries = [
        {
          _tag: "Call",
          at: 1,
          call: "call-1",
          role: "coder",
          executor: "gemini",
          system: "rules",
          input: "do it"
        },
        { _tag: "Tool", at: 2, call: "call-1", tool: "grep", args: "-r secret src" },
        { _tag: "ToolResult", at: 3, call: "call-1", output: "src/a.ts: const secret = 1" },
        { _tag: "Reply", at: 4, call: "call-1", text: "I changed src/a.ts" },
        { _tag: "End", at: 5, call: "call-1", ms: 4 }
      ]
      for (const run of ["run-1", "run-2"]) {
        yield* Effect.promise(() => mkdir(dir(run), { recursive: true }))
        yield* Effect.promise(() =>
          writeFile(
            join(dir(run), "home.jsonl"),
            entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
          )
        )
      }
      const compacted = yield* compactTranscripts(root, ["run-1", "missing"])
      assert.strictEqual(compacted, 1)
      const text = yield* Effect.promise(() => readFile(join(dir("run-1"), "home.jsonl"), "utf8"))
      const lines = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.deepStrictEqual(
        lines.map((line) => line._tag),
        ["Call", "Tool", "ToolResult", "End"]
      )
      assert.strictEqual(lines[0]?.input, "")
      assert.isUndefined(lines[0]?.system)
      assert.strictEqual(lines[0]?.role, "coder")
      assert.strictEqual(lines[1]?.tool, "grep")
      assert.strictEqual(lines[1]?.args, "")
      assert.strictEqual(lines[2]?.output, "")
      assert.strictEqual(lines[3]?.ms, 4)
      assert.notInclude(text, "secret")
      // the other run is untouched
      const other = yield* Effect.promise(() => readFile(join(dir("run-2"), "home.jsonl"), "utf8"))
      assert.include(other, "secret")
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }))
    })
  )
})

describe("storiesEnvironment", () => {
  it("turns transcripts on unless the environment says otherwise", () => {
    assert.strictEqual(storiesEnvironment({}).LLM4TS_TRANSCRIPT, "on")
    assert.strictEqual(storiesEnvironment({ LLM4TS_TRANSCRIPT: "off" }).LLM4TS_TRANSCRIPT, "off")
    assert.strictEqual(storiesEnvironment({ LLM4TS_TRANSCRIPT: "on" }).LLM4TS_TRANSCRIPT, "on")
    assert.strictEqual(storiesEnvironment({ HOME: "/x" }).HOME, "/x")
  })
})
```

Add `readFile` to the `node:fs/promises` import and `compactTranscripts`, `storiesEnvironment` to the lib import (remove `removeTranscripts`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run flows/test/epic-stories.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

In `flows/lib/epic-stories.ts`, change the `node:fs/promises` import to `import { readdir, readFile, stat, writeFile } from "node:fs/promises"` (drop `rm` if nothing else uses it; check with a grep). Add:

```ts
import { TranscriptEntry } from "@llm4ts/flow/Transcript"
```

Replace `removeTranscripts` with:

```ts
/**
 * Transcripts are on by default for epic-stories: a slow story is only
 * explainable from them. `LLM4TS_TRANSCRIPT=off` (or `0`, `false`, `no`)
 * turns them off; an explicit value is never overridden.
 */
export const storiesEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | undefined>> =>
  environment.LLM4TS_TRANSCRIPT === undefined
    ? { ...environment, LLM4TS_TRANSCRIPT: "on" }
    : environment

const decodeTranscriptLine = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptEntry))
const encodeTranscriptLine = Schema.encodeSync(Schema.fromJsonString(TranscriptEntry))

/** The entry with its content removed; `undefined` for a reply, which is only content. */
const compactedEntry = (entry: TranscriptEntry): TranscriptEntry | undefined => {
  switch (entry._tag) {
    case "Call": {
      const { system: _system, ...rest } = entry
      return { ...rest, input: "" }
    }
    case "Tool":
      return { ...entry, args: "" }
    case "ToolResult":
      return { ...entry, output: "" }
    case "Reply":
      return undefined
    case "End":
      return entry
  }
}

/**
 * Rewrites the transcripts of these runs keeping their shape — calls, roles,
 * executors, tool names, timings — and dropping every input, reply, tool
 * argument and output, so a landed epic keeps no copy of its customer code
 * yet `llm4ts profile` and a retro can still see how each story went.
 * Returns how many runs had transcripts.
 */
export const compactTranscripts = (
  workDir: string,
  runIds: ReadonlyArray<string>
): Effect.Effect<number> =>
  Effect.reduce(runIds, 0, (compacted, runId) => {
    const directory = join(workDir, ".llm4ts", "transcripts", runId)
    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => stat(directory))
      const names = yield* Effect.tryPromise(() => readdir(directory))
      for (const name of names.filter((candidate) => candidate.endsWith(".jsonl"))) {
        const path = join(directory, name)
        const text = yield* Effect.tryPromise(() => readFile(path, "utf8"))
        const lines = text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .flatMap((line) => {
            const decoded = decodeTranscriptLine(line)
            if (decoded._tag === "None") {
              return []
            }
            const kept = compactedEntry(decoded.value)
            return kept === undefined ? [] : [encodeTranscriptLine(kept)]
          })
        yield* Effect.tryPromise(() =>
          writeFile(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 })
        )
      }
      return compacted + 1
    }).pipe(Effect.orElseSucceed(() => compacted))
  })
```

If `Schema.decodeUnknownOption` returns an `Option` whose tag check differs in Effect 4 (`Option.isNone(decoded)`), use that form; `packages/runner/src/Transcripts.ts` `parseTranscript` shows the working idiom to copy.

Call sites: at the land path replace `removeTranscripts(input.workDir, earlier)` with `compactTranscripts(input.workDir, earlier)` and the message with `` `epic ${plan.epicId}: compacted ${removed} run transcript(s) (shape kept, content removed)` ``. In `runNode({ … environment: process.env, … })` use `environment: storiesEnvironment(process.env)`.

Doc touches:

- `flows/epic-stories.ts` header: add a line "Transcripts (what each seat was told and answered) are ON by default for this flow; LLM4TS_TRANSCRIPT=off turns them off. --land compacts them (shape kept, content removed)."
- `packages/flow/src/Transcript.ts` top comment: change "an opt-in record (`llm4ts run --transcript`)" to "a record (`llm4ts run --transcript`; on by default in epic-stories, `LLM4TS_TRANSCRIPT=off` to turn it off)".
- `packages/shell/src/Cli.ts` `--transcript` description: append "; epic-stories records them by default, LLM4TS_TRANSCRIPT=off turns that off".
- `docs/configuration.md`: after the `LLM4TS_STORY_CONTEXT_CHARS` sentence add: "`LLM4TS_ORIENTATION_CHARS` (default `8000`, `0` to turn it off) is how much of the repository orientation digest (folders with counts, scripts, where tests live) the planner and every coder see." and change the transcript sentence to: "`LLM4TS_TRANSCRIPT=on` (what `llm4ts run --transcript` sets) records each seat's input and output under `.llm4ts/transcripts/`, for `llm4ts watch --tail`; `epic-stories` records them by default (`off` to stop), and `--land` compacts them to their shape."
- Any `docs/` or `kits/` mention of `removeTranscripts`/"removed … transcripts" (grep `transcripts` under `docs/`) gets the same wording as the Info message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run flows/test/epic-stories.test.ts packages/runner/test/Transcripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add flows/lib/epic-stories.ts flows/epic-stories.ts flows/test/epic-stories.test.ts packages/flow/src/Transcript.ts packages/shell/src/Cli.ts docs/configuration.md
git commit -m "epic-stories: transcripts on by default, compacted rather than deleted on land

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `llm4ts profile` — coder work per story and the wandering finding

**Files:**

- Modify: `packages/runner/src/Profile.ts`
- Test: `packages/runner/test/Profile.test.ts`

**Interfaces:**

- Consumes: `Timed{kind:"tool", category}` and `StageStarted` events (unchanged).
- Produces: on `StoryProfile`: `toolCalls: { explore, edit, test, other }`, `tasks`, `firstEditMs?`, `exploreBeforeEdit`; a finding `"<id>: N explore calls and T before the coder's first edit — it found its way instead of being told where to go"`; a rendered table "Coder work per story".

- [ ] **Step 1: Write the failing tests**

Append to `packages/runner/test/Profile.test.ts`:

```ts
/**
 * One story, "list", whose coder gave itself two tasks and spent 16 explore
 * calls over 8 minutes before its first edit; a later test call; 10 minutes
 * in all.
 */
const wandering: ReadonlyArray<TreeInput> = [
  at(0, StageStarted.make({ stage: "story list", lane: "list", executor: "gemini" })),
  at(1, StageStarted.make({ stage: "Add the list page", lane: "list" })),
  ...Array.from({ length: 16 }, (_, index) =>
    at(
      10 + index * 30,
      Timed.make({ kind: "tool", label: "grep", category: "explore", ms: 200, lane: "list" })
    )
  ),
  at(
    8 * minute,
    Timed.make({ kind: "tool", label: "write_file", category: "edit", ms: 300, lane: "list" })
  ),
  at(8 * minute + 5, Timed.make({ kind: "model", label: "coder", ms: 8 * 60_000, lane: "list" })),
  at(8 * minute + 10, StageStarted.make({ stage: "Add the list test", lane: "list" })),
  at(
    9 * minute,
    Timed.make({
      kind: "tool",
      label: "run_shell_command",
      category: "test",
      ms: 20_000,
      lane: "list"
    })
  ),
  at(
    9 * minute + 30,
    Timed.make({ kind: "tool", label: "write_file", category: "edit", ms: 300, lane: "list" })
  ),
  at(10 * minute, Timed.make({ kind: "model", label: "coder", ms: 110_000, lane: "list" })),
  at(10 * minute, StageCompleted.make({ stage: "story list", lane: "list" }))
]

describe("coder work per story", () => {
  it("counts tool calls by kind, the coder's tasks, and what came before the first edit", () => {
    const [list] = profileOf(wandering).stories
    assert.deepStrictEqual(list?.toolCalls, { explore: 16, edit: 2, test: 1, other: 0 })
    assert.strictEqual(list?.tasks, 2)
    assert.strictEqual(list?.firstEditMs, 8 * 60_000)
    assert.strictEqual(list?.exploreBeforeEdit, 16)
  })

  it("names a story that found its way instead of being told where to go", () => {
    const findings = profileOf(wandering).findings.map((finding) => finding.text)
    assert.include(
      findings.join("\n"),
      "list: 16 explore calls and 8m00s before the coder's first edit — it found its way instead of being told where to go"
    )
    const text = renderProfile(profileOf(wandering))
    assert.include(text, "Coder work per story")
    assert.include(text, "before 1st edit")
  })

  it("an older trace without tool categories profiles as before", () => {
    const [home] = profileOf(measured).stories
    assert.deepStrictEqual(home?.toolCalls, { explore: 0, edit: 0, test: 0, other: 0 })
    assert.isUndefined(home?.firstEditMs)
    assert.strictEqual(home?.exploreBeforeEdit, 0)
    assert.notInclude(renderProfile(profileOf(measured)), "Coder work per story")
    assert.notInclude(
      profileOf(measured)
        .findings.map((finding) => finding.text)
        .join("\n"),
      "found its way"
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @llm4ts/runner exec vitest run test/Profile.test.ts`
Expected: FAIL — `toolCalls` undefined.

- [ ] **Step 3: Implement**

In `packages/runner/src/Profile.ts`:

Schema, after `Gap`:

```ts
/** The coder's tool calls by kind of work (build, install and git count as other). */
export const ToolCalls = Schema.Struct({
  explore: Schema.Int,
  edit: Schema.Int,
  test: Schema.Int,
  other: Schema.Int
})
export type ToolCalls = typeof ToolCalls.Type
```

Add to `StoryProfile` after `openTurnTools`:

```ts
  ,
  toolCalls: ToolCalls,
  /** Task stages the coder ran on this lane: the tasks it gave itself, plus any revision. */
  tasks: Schema.Int,
  /** From the story's start to the coder's first edit; absent when it never edited. */
  firstEditMs: Schema.optionalKey(Ms),
  /** Explore calls (ls, find, grep, read) made before that first edit. */
  exploreBeforeEdit: Schema.Int
```

`Lane` interface, add:

```ts
tasks: number
toolCalls: {
  explore: number
  edit: number
  test: number
  other: number
}
firstEdit: number | undefined
exploreBeforeEdit: number
```

Where a lane is created (`lanes.set(story, { … openTools: 0 })`), add `tasks: 0, toolCalls: { explore: 0, edit: 0, test: 0, other: 0 }, firstEdit: undefined, exploreBeforeEdit: 0`.

In the `StageStarted` case, before `break`, after the story-lane creation branch:

```ts
if (
  lane !== undefined &&
  !storyStage.test(event.stage) &&
  !event.stage.startsWith(`story ${lane.id}:`)
) {
  lane.tasks += 1
}
```

In the `Timed` case, after `lane?.timed.push({ at, event })`:

```ts
if (lane !== undefined && event.kind === "tool" && event.category !== undefined) {
  const kind =
    event.category === "explore" || event.category === "edit" || event.category === "test"
      ? event.category
      : "other"
  lane.toolCalls[kind] += 1
  if (kind === "edit" && lane.firstEdit === undefined) {
    lane.firstEdit = at - lane.start
    lane.exploreBeforeEdit = lane.toolCalls.explore
  }
}
```

In `storyProfile`'s returned object add:

```ts
    toolCalls: { ...lane.toolCalls },
    tasks: lane.tasks,
    ...(lane.firstEdit === undefined ? {} : { firstEditMs: lane.firstEdit }),
    exploreBeforeEdit: lane.exploreBeforeEdit,
```

In `findingsOf`, after the `openTurnMs` loop over `facts.stories`:

```ts
for (const story of facts.stories) {
  const wandered =
    story.firstEditMs !== undefined &&
    story.wallMs >= 60_000 &&
    (story.exploreBeforeEdit >= 15 || story.firstEditMs >= story.wallMs / 4)
  if (wandered && story.firstEditMs !== undefined) {
    candidates.push({
      ms: story.firstEditMs,
      text: `${story.id}: ${plural(story.exploreBeforeEdit, "explore call")} and ${duration(story.firstEditMs)} before the coder's first edit — it found its way instead of being told where to go`
    })
  }
}
```

In `renderProfile`, after the `Stories` table block (before `skipped`), add:

```ts
    ...(report.stories.every(
      (story) =>
        story.toolCalls.explore + story.toolCalls.edit + story.toolCalls.test + story.toolCalls.other === 0
    )
      ? []
      : [
          "",
          "Coder work per story",
          ...table(
            ["story", "tasks", "explore", "edit", "test", "other", "before 1st edit", "1st edit at"],
            report.stories.map((story) => [
              story.id,
              String(story.tasks),
              String(story.toolCalls.explore),
              String(story.toolCalls.edit),
              String(story.toolCalls.test),
              String(story.toolCalls.other),
              story.firstEditMs === undefined ? "" : `${story.exploreBeforeEdit} explore`,
              story.firstEditMs === undefined ? "never" : duration(story.firstEditMs)
            ])
          )
        ]),
```

Check `plural` and `duration` are in scope where used (both are module-level in `Profile.ts`). If `duration(8 * 60_000)` renders as something other than `8m00s`, read `duration` in `AgentTree.ts` and adjust the expected string in the test to its format.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @llm4ts/runner exec vitest run test/Profile.test.ts test/AgentTree.test.ts test/Watch.test.ts`
Expected: PASS. If an existing assertion compares a whole `StoryProfile` object, extend it with the new fields rather than loosening it.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/runner/src/Profile.ts packages/runner/test/Profile.test.ts
git commit -m "profile: coder work per story — tool calls by kind, tasks, and what came before the first edit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: ADR 0025, parity note, changelog, version 2.29.0

**Files:**

- Create: `docs/adr/0025-story-context.md`
- Modify: `docs/parity.md`, `CHANGELOG.md`, `README.md` (only if it lists the `epic-stories` env vars or the profile's columns), all five `packages/*/package.json` via `pnpm version:set`
- Modify: `docs/superpowers/specs/2026-10-05-story-context-design.md` status line → "implemented in 2.29.0"

- [ ] **Step 1: Write ADR 0025**

Create `docs/adr/0025-story-context.md`:

```markdown
# ADR 0025: Story Context — Orientation, Anchors, Acceptance, Carried Findings

Status: Accepted · Date: 2026-10-05

## Context

A customer runs `epic-stories` with the Gemini CLI as its only executor and an
epic takes days. Watching `llm4ts watch --tail`, the coder spends its time
listing and grepping the repository, then struggles with the task it gave
itself. `llm4ts profile` showed nothing: tool time is milliseconds, the
minutes are the model's turns between tool calls, and the profile never
showed turns.

Reading the executor explained the shape:

- every task runs in a fresh chat (ADR 0003), so a six-task story explores up
  to six times;
- the planner sees only CONTRIBUTING.md and the brief, so a story cannot name
  the exemplar feature, the contract it extends or the kit component to reuse;
- a story has `provides` but no acceptance criteria, so neither the coder's
  task plan nor the judge has a statement of done.

## Decision

1. **A deterministic orientation digest** (`flow/src/Orientation.ts`) of the
   epic checkout's tracked files — folders with counts, small folders in
   full, package scripts, where tests live — computed once per epic without a
   model call, under its own budget (`LLM4TS_ORIENTATION_CHARS`, default
   8000), given to the planner and to every coder's system prompt.
2. **Stories carry `readFirst` anchors** the planner names from the digest.
   Anchors no tracked file lies under are dropped mechanically with an Info
   note (`pruneReadFirst`); the rest open the coder's starting code, before
   the shared read-only files, under `LLM4TS_STORY_CONTEXT_CHARS`.
3. **Stories carry `acceptance` criteria**: observable outcomes the planner
   writes. The coder sees them as "Done when", its task plan names the
   criterion each task satisfies, and the judge's `provides` dimension scores
   against them (rubric judge and story-board alike).
4. **Findings are carried across tasks** (`flow/src/CarriedNotes.ts`,
   `implementPlanFlow({ carry })`): each task ends with a `## Findings`
   section, saved at `stories/<id>.notes.md` and prepended to the next task's
   prompt. ADR 0003's fresh chat per task stays; what travels is a note, not
   the history.
5. **The profile shows coder work per story**: tool calls by kind, the tasks
   the coder gave itself, and the explore calls and time before its first
   edit, with a finding when a story found its way instead of being told.
6. **Transcripts are on by default for epic-stories** (`LLM4TS_TRANSCRIPT=off`
   turns them off) and `--land` compacts them — shape kept, inputs, replies,
   tool arguments and outputs removed — instead of deleting them.
7. **A symbol-level code index is parked.** It is reconsidered only if the
   new profile still shows explore turns dominating; if so it is distilled
   (a cached index file), never a dependency, as ADR 0007 did for memory.

## Consequences

- Both new Story fields default to empty and enter `storyHash` only when set:
  a plan written before 2.29 parses and resumes with every hash intact.
- Each task prompt grows by the carried notes (at most 6000 characters) and
  each coder system prompt by the digest (at most 8000); each task reply
  grows by a ten-line section.
- The digest is generic (tracked files, package scripts, test files). What
  the exemplar is stays the planner's judgment, now made with the layout in
  front of it.
- Divergence from the pinned llm4zio (which has no story context of this
  kind) is recorded in `docs/parity.md`.

## Not decided here

A symbol index; acceptance criteria checked mechanically; GEMINI.md or any
Gemini-specific context file (the system prompt is already flattened into
Gemini's prompt).
```

- [ ] **Step 2: Parity note and changelog**

Append to `docs/parity.md`:

```markdown
- Story context (ADR 0025, 2026-10-05): a deterministic repository
  orientation digest for the planner and every coder, `readFirst` anchors
  pruned to paths that exist and opening the starting code, `acceptance`
  criteria the coder plans against and the judge scores against, findings
  carried from one task to the next, coder work per story in `llm4ts
profile`, transcripts on by default and compacted on land. llm4zio's
  stories carry no anchors or criteria and its coder starts every task cold.
  Additive.
```

Prepend to `CHANGELOG.md` after `# Changelog`:

```markdown
## 2.29.0

Why an `epic-stories` epic takes days with a CLI coder, and what now tells it
where to go (ADR 0025).

- **The planner sees the repository.** A deterministic orientation digest of
  the epic checkout's tracked files — folders with counts, small folders in
  full, package scripts, where tests live — goes to the planner and to every
  coder's system prompt, under `LLM4TS_ORIENTATION_CHARS` (default 8000, `0`
  to leave it out). No model call.
- **Stories name what to read first.** `readFirst` paths chosen by the
  planner; those not in the repository are dropped with a note; the rest open
  the coder's starting code before the shared read-only files.
- **Stories say what done looks like.** `acceptance` criteria from the
  planner: the coder sees them as "Done when", its task plan names the
  criterion each task satisfies, and the judge's `provides` dimension scores
  against them. Plans written earlier parse unchanged and keep every hash.
- **Findings travel between tasks.** Each task's reply ends with a short
  `## Findings` section, kept at `stories/<id>.notes.md` and prepended to the
  next task's prompt, so a six-task story explores once, not six times
  (`implementPlanFlow({ carry })`).
- **`llm4ts profile` shows coder work per story**: tool calls by kind, the
  tasks the coder gave itself, and the explore calls and time before its
  first edit — "16 explore calls and 8m00s before the coder's first edit".
- **Transcripts are on by default for epic-stories** (`LLM4TS_TRANSCRIPT=off`
  turns them off); `--land` compacts them to their shape instead of deleting
  them, so a slow story stays explainable without keeping customer code.
```

- [ ] **Step 3: Bump the version and run the full chain**

```bash
pnpm version:set 2.29.0
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm build && node scripts/pack-smoke.mjs
```

Expected: every command exits 0; pack smoke resolves the new `@llm4ts/flow/Orientation` and `@llm4ts/flow/CarriedNotes` subpaths (it imports every export in the map; if it has its own list, add both).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Release 2.29.0: story context — orientation, anchors, acceptance, carried findings, coder work in the profile

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Tagging and pushing (`git tag v2.29.0 && git push origin main v2.29.0`) are the user's call: publishing is tag-driven.

---

## Self-review

- **Spec coverage**: decision 1 (profile, transcripts) → Tasks 6, 7; 2 (carried findings) → Tasks 3, 4; 3 (digest) → Tasks 2, 5; 4 (anchors) → Tasks 1, 4, 5; 5 (acceptance) → Tasks 1, 4, 5; 6/7 (parked, no GEMINI.md) → ADR text in Task 8. Constraint "hash-stable" → Task 1. Constraint "executor-agnostic" → nothing Gemini-specific anywhere.
- **Types**: `pruneReadFirst` returns `{ plan, dropped }` in Tasks 1 and 5; `CarriedNotes` has `read`/`write` in Tasks 3 and 4; `orientationFor(git, files, workDir, appDir, environment)` in Task 5 matches its test; `ToolCalls` keys `explore/edit/test/other` in Task 7 tests and render.
- **Review Focus**: 1 → Task 1 tests; 2 → Task 3 `findingsIn` BLOCKED_ON test and `findingsRequest`; 3 → Task 1 folder anchor, Task 4 exemplar folder; 4 → Task 2 empty/huge; 5 → Task 7 "older trace" test.
