// Fakes shared by the flow tests that need a whole story context. The
// epic-stories suite keeps its own copies on purpose (it is the guard that the
// program move preserved behaviour, so it does not change).
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk } from "@llm4ts/core/Models"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import type { FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"

const unused = InvalidRequestError.make({ message: "unused in test" })
const unusedFlow: Effect.Effect<never, FlowError> = Effect.fail(
  FlowAborted.make({ message: "unused in test" })
)

/** A seat that replies with one string to every prompt. */
export const replying = (reply: string): LlmServiceShape => ({
  executeStream: () => Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })),
  executeStreamWithHistory: () =>
    Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })),
  executeWithTools: () => Effect.fail(unused),
  executeStructured: () => Effect.fail(unused),
  executeStructuredWithUsage: () => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})

export const idleHosting: GitHubToolShape = {
  createPr: () => unusedFlow,
  readIssue: () => unusedFlow,
  readIssueComments: () => unusedFlow,
  writeIssueComment: () => unusedFlow,
  editIssueComment: () => unusedFlow,
  writePrComment: () => unusedFlow,
  updatePr: () => unusedFlow,
  prChecks: () => unusedFlow,
  viewOpenPr: unusedFlow,
  mergePr: () => unusedFlow,
  listIssues: () => unusedFlow,
  createIssue: () => unusedFlow,
  editIssueLabels: () => unusedFlow,
  assignIssue: () => unusedFlow,
  closeIssue: () => unusedFlow
}

export const idleGit: GitToolShape = {
  init: Effect.void,
  initBare: Effect.void,
  config: () => Effect.void,
  status: Effect.succeed(""),
  uncommittedFiles: Effect.succeed([]),
  currentBranch: Effect.succeed("main"),
  diff: Effect.succeed(""),
  diffAll: Effect.succeed(""),
  defaultBase: Effect.succeed("main"),
  diffVsBase: () => Effect.succeed(""),
  diffVsBaseScoped: () => Effect.succeed(""),
  changedFilesVsBase: () => Effect.succeed([]),
  addRemote: () => Effect.void,
  checkout: () => Effect.void,
  checkoutOrCreate: () => Effect.void,
  createBranch: () => unusedFlow,
  commitAll: () => Effect.succeed(Committed.make({})),
  commitPaths: () => Effect.succeed(Committed.make({})),
  push: () => Effect.void,
  checkpoint: Effect.succeed("head"),
  rollback: () => Effect.void,
  addWorktree: () => Effect.void,
  addWorktreeNewBranch: () => Effect.void,
  removeWorktree: () => Effect.void,
  moveWorktree: () => Effect.void,
  restorePaths: () => Effect.void,
  mergeNoCommit: () => Effect.succeed([]),
  branchExists: () => Effect.succeed(false),
  deleteBranch: () => Effect.void,
  isAncestor: () => Effect.succeed(false),
  merge: () => Effect.void
}

/** A story context whose seats never speak; enough for a judge seam call. */
export const idleContext = (events: FlowEventsShape): FlowContextShape => ({
  reasoning: replying(""),
  coder: replying(""),
  git: idleGit,
  hosting: idleHosting,
  events,
  reviewers: [],
  coderCapabilities: ConnectorCapabilities.make({}),
  userPrompt: "",
  workDir: "/repo",
  workspace: "/repo"
})
