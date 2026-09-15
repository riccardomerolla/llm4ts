import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

/**
 * The human gates of the modernization phases: a markdown document ends
 * with a draft marker the flow writes, and the next phase refuses to start
 * until a person has ticked it. (Moved from `@llm4ts/modernize` in 0.18.0.)
 */
export class ApprovalRequired extends Schema.TaggedError<ApprovalRequired>()("ApprovalRequired", {
  path: Schema.String,
  marker: Schema.String
}) {
  get message(): string {
    return `approval required in ${this.path}: set '${this.marker}'`
  }
}

export class MissingModernizeArtifact extends Schema.TaggedError<MissingModernizeArtifact>()(
  "MissingModernizeArtifact",
  {
    path: Schema.String,
    message: Schema.String
  }
) {}

export const ApprovedMarker = "- [x] Approved"
export const DraftApprovalMarker = "- [ ] Approved"

export const withDraftApproval = (markdown: string): string =>
  `${markdown.trimEnd()}\n\n${DraftApprovalMarker}\n`

export const requireApproval = Effect.fn("@llm4ts/flow/Approval.requireApproval")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<void, FlowError | ApprovalRequired | MissingModernizeArtifact> {
  const contents = yield* files.read(path)
  if (contents === undefined) {
    return yield* MissingModernizeArtifact.make({
      path,
      message: `approval document does not exist: ${path}`
    })
  }
  if (!contents.includes(ApprovedMarker)) {
    return yield* ApprovalRequired.make({ path, marker: ApprovedMarker })
  }
})
