// The epic-level plan of the parallel story executor (ADR 0013): stories
// with a declared dependency graph and declared file ownership. Dependencies
// are declared here, up front, never discovered by a running coder.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PlanParseError, StoryPlanInvalid, type PersistenceError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { stableHash } from "./Plan.ts"

export const StoryPlanVersion = 1

export class Story extends Schema.Class<Story>("Story")({
  /** Kebab-case, unique within the plan; names the branch and the worktree. */
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  /** Story ids this one waits for; they are merged before this one starts. */
  dependsOn: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  /** Repo-relative path prefixes (files or directories) the story may create or change. */
  owned: Schema.Array(Schema.String),
  /** Path prefixes fed as context and forbidden to change. */
  sharedReadOnly: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  /** What dependents may rely on: routes, exports, contracts. */
  provides: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
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
  ),
  /**
   * The story may delete, skip or rewrite tests (ADR 0027): the oracle guard
   * stays silent for it. Absent or false, a deleted test file, an added skip
   * marker or a passed-count drop is a gate failure.
   */
  testsChange: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  )
}) {}

export class StoryPlan extends Schema.Class<StoryPlan>("StoryPlan")({
  epicId: Schema.String,
  /** The epic as the operator phrased it. */
  epic: Schema.String,
  stories: Schema.Array(Story)
}) {
  story(id: string): Story | undefined {
    return this.stories.find((story) => story.id === id)
  }
}

/** A path prefix in canonical form: no `./`, no trailing slash, forward slashes. */
export const normalizePath = (path: string): string =>
  path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")

/** Whether `path` is `prefix` itself or lies under it. */
export const pathWithin = (path: string, prefix: string): boolean => {
  const target = normalizePath(path)
  const root = normalizePath(prefix)
  return root.length === 0 || target === root || target.startsWith(`${root}/`)
}

const overlapping = (left: string, right: string): boolean =>
  pathWithin(left, right) || pathWithin(right, left)

/**
 * Every violation of the plan's invariants, in one pass — an operator fixing
 * a hand-edited plan wants the whole list, not a rerun per finding.
 */
export const storyPlanViolations = (plan: StoryPlan): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const ids = new Set<string>()
  for (const story of plan.stories) {
    if (ids.has(story.id)) {
      violations.push(`duplicate story id '${story.id}'`)
    }
    ids.add(story.id)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(story.id)) {
      violations.push(`story id '${story.id}' is not kebab-case`)
    }
    if (story.owned.length === 0) {
      violations.push(`story '${story.id}' owns no paths`)
    }
    for (const dependency of story.dependsOn) {
      if (dependency === story.id) {
        violations.push(`story '${story.id}' depends on itself`)
      } else if (!plan.stories.some((candidate) => candidate.id === dependency)) {
        violations.push(`story '${story.id}' depends on unknown story '${dependency}'`)
      }
    }
    for (const owned of story.owned) {
      for (const shared of story.sharedReadOnly) {
        if (overlapping(owned, shared)) {
          violations.push(
            `story '${story.id}' both owns '${owned}' and declares '${shared}' shared read-only`
          )
        }
      }
    }
  }
  for (let index = 0; index < plan.stories.length; index += 1) {
    const left = plan.stories[index]
    if (left === undefined) {
      continue
    }
    for (const right of plan.stories.slice(index + 1)) {
      for (const leftPath of left.owned) {
        for (const rightPath of right.owned) {
          if (overlapping(leftPath, rightPath)) {
            violations.push(
              `stories '${left.id}' and '${right.id}' both own '${normalizePath(leftPath)}' / '${normalizePath(rightPath)}'`
            )
          }
        }
      }
    }
  }
  for (const cycle of cycles(plan)) {
    violations.push(`dependency cycle: ${cycle.join(" -> ")}`)
  }
  return violations
}

/**
 * An anchor the repository can answer: relative, inside the checkout, and
 * narrower than the whole tree. `../x`, `/abs/x`, `.`, `` and `a/../b` are
 * not — `git ls-files` is fatal on the first two, and the last ones would
 * name every file.
 */
export const isSafeAnchor = (anchor: string): boolean => {
  const path = normalizePath(anchor)
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/u.test(path) &&
    path !== "." &&
    !path.split("/").includes("..")
  )
}

/**
 * The plan with every `readFirst` anchor that no tracked file lies under
 * removed — unsafe anchors (`isSafeAnchor`) first, without a lookup — and
 * the list of what was dropped. A planner names paths from a layout digest
 * and sometimes guesses; a guess must not reach a coder as something to read.
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
      const exists = isSafeAnchor(anchor) && files.some((file) => pathWithin(file, anchor))
      if (!exists) {
        dropped.push({ story: story.id, path: anchor })
      }
      return exists
    })
    return kept.length === story.readFirst.length ? story : new Story({ ...story, readFirst: kept })
  })
  return { plan: dropped.length === 0 ? plan : new StoryPlan({ ...plan, stories }), dropped }
}

const cycles = (plan: StoryPlan): ReadonlyArray<ReadonlyArray<string>> => {
  const found: Array<ReadonlyArray<string>> = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (id: string, trail: ReadonlyArray<string>): void => {
    const mark = state.get(id)
    if (mark === "done") {
      return
    }
    if (mark === "visiting") {
      const start = trail.indexOf(id)
      found.push([...trail.slice(start), id])
      return
    }
    state.set(id, "visiting")
    for (const dependency of plan.story(id)?.dependsOn ?? []) {
      // A self-edge is already reported as "depends on itself".
      if (dependency !== id && plan.story(dependency) !== undefined) {
        visit(dependency, [...trail, id])
      }
    }
    state.set(id, "done")
  }
  for (const story of plan.stories) {
    visit(story.id, [])
  }
  return found
}

export const validateStoryPlan = Effect.fn("@llm4ts/flow/StoryPlan.validate")(function* (
  plan: StoryPlan
): Effect.fn.Return<StoryPlan, StoryPlanInvalid> {
  const violations = storyPlanViolations(plan)
  return violations.length === 0 ? plan : yield* StoryPlanInvalid.make({ violations })
})

/**
 * Stories grouped by the earliest wave they can run in (all dependencies in
 * earlier waves). Assumes a valid plan; a cycle leaves its members out.
 */
export const topologicalWaves = (plan: StoryPlan): ReadonlyArray<ReadonlyArray<string>> => {
  const waves: Array<ReadonlyArray<string>> = []
  const placed = new Set<string>()
  let remaining = plan.stories.map((story) => story.id)
  while (remaining.length > 0) {
    const wave = remaining.filter((id) =>
      (plan.story(id)?.dependsOn ?? []).every((dependency) => placed.has(dependency))
    )
    if (wave.length === 0) {
      break
    }
    waves.push(wave)
    for (const id of wave) {
      placed.add(id)
    }
    remaining = remaining.filter((id) => !placed.has(id))
  }
  return waves
}

export interface StoryProgress {
  readonly done: ReadonlySet<string>
  readonly failed: ReadonlySet<string>
  /** On hold behind a failed predecessor. */
  readonly waiting: ReadonlySet<string>
  readonly running: ReadonlySet<string>
}

/** Stories that may start now: not yet touched, every dependency done. Plan order. */
export const readyStories = (plan: StoryPlan, progress: StoryProgress): ReadonlyArray<Story> =>
  plan.stories.filter(
    (story) =>
      !progress.done.has(story.id) &&
      !progress.failed.has(story.id) &&
      !progress.waiting.has(story.id) &&
      !progress.running.has(story.id) &&
      story.dependsOn.every((dependency) => progress.done.has(dependency))
  )

/** Every story that transitively depends on `id`, in plan order. */
export const dependentsOf = (plan: StoryPlan, id: string): ReadonlyArray<string> => {
  const blocked = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const story of plan.stories) {
      if (!blocked.has(story.id) && story.dependsOn.some((dependency) => blocked.has(dependency))) {
        blocked.add(story.id)
        grew = true
      }
    }
  }
  return plan.stories
    .map((story) => story.id)
    .filter((candidate) => candidate !== id && blocked.has(candidate))
}

/** Every story `id` waits for, directly or through another dependency. */
export const dependenciesOf = (plan: StoryPlan, id: string): ReadonlyArray<string> => {
  const needed = new Set<string>()
  const pending = [...(plan.story(id)?.dependsOn ?? [])]
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || needed.has(next)) {
      continue
    }
    needed.add(next)
    pending.push(...(plan.story(next)?.dependsOn ?? []))
  }
  return plan.stories.map((story) => story.id).filter((candidate) => needed.has(candidate))
}

/** How `other` stands to `story` in the plan's order. */
export type StoryRelation = "self" | "dependency" | "dependent" | "parallel"

export const relationOf = (plan: StoryPlan, story: Story, other: Story): StoryRelation =>
  other.id === story.id
    ? "self"
    : dependenciesOf(plan, story.id).includes(other.id)
      ? "dependency"
      : dependentsOf(plan, story.id).includes(other.id)
        ? "dependent"
        : "parallel"

/** The story that owns `path`, if any (owned sets are disjoint). */
export const ownerOf = (plan: StoryPlan, path: string): Story | undefined =>
  plan.stories.find((story) => story.owned.some((prefix) => pathWithin(path, prefix)))

const fileLike = /\.[A-Za-z0-9]{1,5}$/

const basename = (path: string): string => normalizePath(path).split("/").at(-1) ?? ""

/**
 * The repository paths a piece of prose names: tokens that start under one
 * of the plan's top-level directories (`src/App.tsx`), plus a bare file name
 * that is exactly the file name of an owned path (`App.tsx`), which resolves
 * to that path. Prose paths are guesses, never proofs — callers use them to
 * ask again or to explain, not to fail.
 */
export const pathsNamedIn = (plan: StoryPlan, text: string): ReadonlyArray<string> => {
  const known = plan.stories.flatMap((story) => [...story.owned, ...story.sharedReadOnly])
  const roots = new Set(
    known.map((path) => normalizePath(path).split("/")[0] ?? "").filter((root) => root.length > 0)
  )
  const ownedFiles = plan.stories.flatMap((story) =>
    story.owned.filter((path) => fileLike.test(normalizePath(path)))
  )
  const found: Array<string> = []
  for (const raw of text.match(/[A-Za-z0-9_.@/\\-]+/g) ?? []) {
    const token = normalizePath(raw.replace(/[.,:;]+$/, ""))
    if (token.length === 0 || token.includes("://")) {
      continue
    }
    if (token.includes("/")) {
      if (roots.has(token.split("/")[0] ?? "")) {
        found.push(token)
      }
      continue
    }
    if (fileLike.test(token)) {
      for (const path of ownedFiles) {
        if (basename(path) === token) {
          found.push(normalizePath(path))
        }
      }
    }
  }
  return [...new Set(found)]
}

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
      ...(story.acceptance.length === 0 ? {} : { acceptance: [...story.acceptance] }),
      ...(story.testsChange ? { testsChange: true } : {})
    })
  )

export const storyPlanFenceInfo = "json storyplan"

const fencePattern = /```json[ \t]+storyplan[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/

/** The raw JSON of the first ```json storyplan fenced block, if any. */
export const storyPlanBlock = (markdown: string): string | undefined =>
  fencePattern.exec(markdown)?.[1]

/**
 * Decodes the story plan embedded in its markdown file. Decoding only —
 * `validateStoryPlan` checks the graph invariants separately, so a parse
 * failure and an invalid plan are told apart.
 */
export const parseStoryPlan = Effect.fn("@llm4ts/flow/StoryPlan.parse")(function* (
  markdown: string
): Effect.fn.Return<StoryPlan, PlanParseError> {
  const block = storyPlanBlock(markdown)
  if (block === undefined) {
    return yield* PlanParseError.make({
      message: "no ```json storyplan fenced block in the story plan markdown"
    })
  }
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoryPlan))(block).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({ message: `invalid story plan block: ${String(error)}` })
    )
  )
})

const list = (items: ReadonlyArray<string>): string =>
  items.length === 0 ? "none" : items.join(", ")

/**
 * The operator-facing markdown: a readable summary per story plus the
 * fenced block that is the source of truth. Editing the block and rerunning
 * is the approval and the re-plan path.
 */
export const renderStoryPlan = Effect.fn("@llm4ts/flow/StoryPlan.render")(function* (
  plan: StoryPlan
): Effect.fn.Return<string, PlanParseError> {
  const encoded = yield* Schema.encodeEffect(StoryPlan)(plan).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({ message: `story plan not encodable: ${String(error)}` })
    )
  )
  const waves = topologicalWaves(plan)
  const lines: Array<string> = [
    `# Epic: ${plan.epicId}`,
    "",
    plan.epic.trim(),
    "",
    "## Waves",
    "",
    ...waves.map((wave, index) => `${index + 1}. ${wave.join(", ")}`),
    "",
    "## Stories",
    ""
  ]
  for (const story of plan.stories) {
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
  }
  lines.push(
    "## Plan block",
    "",
    "Edit this block to change the plan; the prose above is regenerated from it.",
    "",
    "```" + storyPlanFenceInfo,
    JSON.stringify(encoded, null, 2),
    "```",
    ""
  )
  return lines.join("\n")
})

export interface StoryPlanStoreShape {
  readonly save: (
    path: string,
    plan: StoryPlan
  ) => Effect.Effect<void, PersistenceError | PlanParseError>
  readonly load: (
    path: string
  ) => Effect.Effect<StoryPlan | undefined, PersistenceError | PlanParseError>
  /** An existing file wins over `create`: the operator's edits are the plan. */
  readonly recoverOrCreate: <E, R>(
    path: string,
    create: Effect.Effect<StoryPlan, E, R>
  ) => Effect.Effect<StoryPlan, E | PersistenceError | PlanParseError, R>
}

export const makeStoryPlanStore = (files: PlainFileStoreShape): StoryPlanStoreShape => {
  const save = (
    path: string,
    plan: StoryPlan
  ): Effect.Effect<void, PersistenceError | PlanParseError> =>
    Effect.flatMap(renderStoryPlan(plan), (markdown) => files.writeAtomic(path, markdown))
  const load = (
    path: string
  ): Effect.Effect<StoryPlan | undefined, PersistenceError | PlanParseError> =>
    Effect.flatMap(files.read(path), (contents) =>
      contents === undefined ? Effect.succeed(undefined) : parseStoryPlan(contents)
    )
  return {
    save,
    load,
    recoverOrCreate: (path, create) =>
      Effect.flatMap(load(path), (stored) =>
        stored === undefined
          ? Effect.tap(create, (plan) => save(path, plan))
          : Effect.succeed(stored)
      )
  }
}
