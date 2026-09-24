// The story perimeter check (ADR 0013): a story branch may only change what
// the story owns. Enforced after the fact on the branch's changed files —
// the prompt states the rule, this is what makes it true.
import * as Effect from "effect/Effect"
import { PerimeterViolation } from "./FlowError.ts"
import type { Task } from "./Plan.ts"
import { ReviewIssue, ReviewResult } from "./Review.ts"
import {
  normalizePath,
  ownerOf,
  pathWithin,
  pathsNamedIn,
  type Story,
  type StoryPlan
} from "./StoryPlan.ts"

export interface PerimeterCheck {
  /** Changed paths under a `sharedReadOnly` prefix — the worse class, reported first. */
  readonly sharedReadOnly: ReadonlyArray<string>
  /** Changed paths under neither `owned` nor `sharedReadOnly`. */
  readonly outside: ReadonlyArray<string>
}

export const checkPerimeter = (
  changedPaths: ReadonlyArray<string>,
  story: Story
): PerimeterCheck => {
  const sharedReadOnly: Array<string> = []
  const outside: Array<string> = []
  for (const path of changedPaths) {
    if (story.owned.some((prefix) => pathWithin(path, prefix))) {
      continue
    }
    if (story.sharedReadOnly.some((prefix) => pathWithin(path, prefix))) {
      sharedReadOnly.push(path)
    } else {
      outside.push(path)
    }
  }
  return { sharedReadOnly, outside }
}

export const isWithinPerimeter = (check: PerimeterCheck): boolean =>
  check.sharedReadOnly.length === 0 && check.outside.length === 0

export const enforcePerimeter = Effect.fn("@llm4ts/flow/Perimeter.enforce")(function* (
  changedPaths: ReadonlyArray<string>,
  story: Story
): Effect.fn.Return<void, PerimeterViolation> {
  const check = checkPerimeter(changedPaths, story)
  if (!isWithinPerimeter(check)) {
    return yield* PerimeterViolation.make({
      story: story.id,
      outside: check.outside,
      sharedReadOnly: check.sharedReadOnly
    })
  }
})

/**
 * The perimeter as a gate result: a violation is one Critical issue whose
 * text names every stray path, so the task review loop hands it back to the
 * coder to revert before anything is committed.
 */
export const perimeterGate = (changedPaths: ReadonlyArray<string>, story: Story): ReviewResult => {
  const check = checkPerimeter(changedPaths, story)
  if (isWithinPerimeter(check)) {
    return ReviewResult.make({ issues: [], summary: "perimeter: clean" })
  }
  const violation = PerimeterViolation.make({
    story: story.id,
    outside: check.outside,
    sharedReadOnly: check.sharedReadOnly
  })
  return ReviewResult.make({
    issues: [
      ReviewIssue.make({
        severity: "Critical",
        title: "perimeter",
        description: [
          violation.message,
          "Revert these paths (restore a changed file from the epic branch, delete a file you",
          "created there) and keep the work inside your owned paths."
        ].join("\n")
      })
    ],
    summary: "perimeter: violated"
  })
}

/** A planned task that names paths outside its story's perimeter. */
export interface StrayTask {
  readonly task: Task
  readonly paths: ReadonlyArray<string>
  /** Some of `paths` are owned by another story — the task is that story's work. */
  readonly foreign: boolean
}

const fileLike = /\.[A-Za-z0-9]{1,5}$/

const allowed = (story: Story, path: string): boolean =>
  story.owned.some((prefix) => pathWithin(path, prefix)) ||
  story.sharedReadOnly.some((prefix) => pathWithin(path, prefix)) ||
  // A bare directory above an owned path ("inside src/features/conto") is a
  // location, not a target.
  (!fileLike.test(normalizePath(path)) && story.owned.some((prefix) => pathWithin(prefix, path)))

/**
 * The incomplete tasks of a story's plan that name paths the story may not
 * touch. Checked before any coder turn is spent on them: a task such as
 * "register the screen in src/App.tsx" is another story's job.
 */
export const strayTasks = (
  plan: StoryPlan,
  story: Story,
  tasks: ReadonlyArray<Task>
): ReadonlyArray<StrayTask> =>
  tasks.flatMap((task) => {
    if (task.completed) {
      return []
    }
    const paths = pathsNamedIn(plan, `${task.title}\n${task.description}`).filter(
      (path) => !allowed(story, path)
    )
    if (paths.length === 0) {
      return []
    }
    const foreign = paths.some((path) => {
      const owner = ownerOf(plan, path)
      return owner !== undefined && owner.id !== story.id
    })
    return [{ task, paths, foreign }]
  })
