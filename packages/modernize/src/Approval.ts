import * as Effect from "effect/Effect"
import type { FlowError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { ApprovalRequired, MissingModernizeArtifact } from "./Model.ts"

export const ApprovedMarker = "- [x] Approved"
export const DraftApprovalMarker = "- [ ] Approved"

export const withDraftApproval = (markdown: string): string =>
  `${markdown.trimEnd()}\n\n${DraftApprovalMarker}\n`

export const requireApproval = Effect.fn("@llm4ts/modernize/Approval.requireApproval")(function* (
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
