// The story perimeter check (ADR 0013): a story branch may only change what
// the story owns. Enforced after the fact on the branch's changed files —
// the prompt states the rule, this is what makes it true.
import * as Effect from "effect/Effect"
import { PerimeterViolation } from "./FlowError.ts"
import { pathWithin, type Story } from "./StoryPlan.ts"

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
