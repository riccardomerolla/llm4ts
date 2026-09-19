// Forks an existing pack into a new, project-tier pack whose conventions.md
// and reviewers/target-conventions.md describe a REAL, already-in-production
// target repository — so a later modernize-implement run (LLM4TS_PACK
// pointed at the fork) writes new code that reuses this repo's own
// architecture, shared components, and conventions instead of guessing.
// See docs/adr/0018-pack-fork.md.
//
// Runs rooted at the TARGET repository (`--repo <target>`) — there is no
// legacy repository in this flow at all. Requires:
//   LLM4TS_PACK=<source pack>       resolved as for any flow (default cobol-springboot)
//   LLM4TS_TARGET_KIND=frontend|backend
//   LLM4TS_FORK_AS=<new pack name>  lowercase kebab-case
//
// The forked pack lands at
// `<repo>/.llm4ts/kits/forked/packs/<LLM4TS_FORK_AS>/` — a dedicated
// project-tier kit named "forked", never the source pack's own kit name
// (Kits.ts dedupes kits by name across tiers; reusing the source kit's name
// would hide its other packs from this project). `scaffold:` is dropped:
// the whole point is that the target repository already exists.
//
// One-shot, not resumable: re-running overwrites the previous fork under
// the same LLM4TS_FORK_AS name.
import { basename, join, relative as relativePath, resolve as resolvePath } from "node:path"
import { rmSync } from "node:fs"
import * as Effect from "effect/Effect"
import { structuredAndPublish } from "@llm4ts/flow/Flow"
import { FlowEvents, Info } from "@llm4ts/flow/FlowEvents"
import { capped, withShrink } from "@llm4ts/flow/Context"
import { withDraftApproval } from "@llm4ts/flow/Approval"
import { legacySourceWorkspaceLimits, workspaceLimitsFromEnv } from "@llm4ts/flow/Workspace"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { OpenedPack } from "@llm4ts/runner/Packs"
import {
  asReadOnly,
  coderFromEnv,
  makeNodeWorkspace,
  nodePlainFileStore,
  openPack,
  resolveFlowInput,
  runFlowMain,
  runNode,
  ScriptUsage,
  stage
} from "@llm4ts/runner"
import {
  ConventionSection,
  conventionPassAsk,
  conventionSectionJsonSchema,
  forkPackMarkdown,
  forkedReadme,
  parseForkAs,
  parseTargetKind,
  passesForTargetKind,
  readGroundingFiles,
  targetConventionsReviewer,
  techStackGroundingFiles
} from "./lib/pack-fork.ts"

const forkPackFiles = Effect.fn("flows/pack-fork.forkPackFiles")(function* (
  source: OpenedPack,
  destinationAbs: string,
  files: PlainFileStoreShape
) {
  // `source.dir` is "." for an absolute-path pack reference (Packs.ts's
  // `locatePack`), "packs/<name>" for a relative-directory or kit pack
  // reference — never assume it's non-empty. `join`/`relative` from
  // node:path normalize the "." case correctly where manual string
  // concatenation or `.slice()` would not.
  const packMdPath = join(source.dir, "pack.md")
  const entries = yield* source.workspace.discover(join(source.dir, "**"))
  for (const relative_ of entries) {
    if (relative_ === packMdPath) {
      continue
    }
    const content = yield* source.workspace
      .read(relative_)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content === undefined) {
      continue
    }
    const suffix = relativePath(source.dir, relative_)
    yield* files.writeAtomic(join(destinationAbs, suffix), content)
  }
})

const forkKitPatterns = Effect.fn("flows/pack-fork.forkKitPatterns")(function* (
  source: OpenedPack,
  destinationAbs: string,
  files: PlainFileStoreShape
) {
  if (source.kit === undefined) {
    return
  }
  const entries = yield* source.workspace
    .discover(join("patterns", "**"))
    .pipe(Effect.catch(() => Effect.succeed([])))
  for (const relative_ of entries) {
    const content = yield* source.workspace
      .read(relative_)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (content === undefined) {
      continue
    }
    yield* files.writeAtomic(join(destinationAbs, relative_), content)
  }
})

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
    "Analyze the target repository and fork the pack with its conventions."
  )
  const targetKind = yield* parseTargetKind(process.env)
  const forkAs = yield* parseForkAs(process.env)
  const coder = asReadOnly(coderFromEnv(process.env))
  const files = nodePlainFileStore

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: coder,
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const repo = yield* makeNodeWorkspace(
          input.workDir,
          workspaceLimitsFromEnv(process.env, legacySourceWorkspaceLimits)
        )
        const opened = yield* stage(
          context.events,
          "pack",
          openPack({
            environment: process.env,
            launchDir: input.workspace,
            flowDir: import.meta.dirname
          })
        )

        const destinationRel = join(".llm4ts", "kits", "forked", "packs", forkAs)
        const destinationAbs = join(input.workDir, destinationRel)

        // Guard BEFORE any read of the source pack or the "clean" rmSync
        // below: if LLM4TS_PACK and LLM4TS_FORK_AS resolve to the same
        // directory — reachable by cd-ing into the target repo and setting
        // LLM4TS_PACK=forked/<name> for a re-fork, exactly as this flow's
        // own closing message instructs — the clean stage would delete the
        // pack this run is about to read, including any uncommitted human
        // edits such as the approval-marker flip.
        const sourceDirAbs = resolvePath(join(opened.workspace.root, opened.dir))
        if (sourceDirAbs === resolvePath(destinationAbs)) {
          return yield* ScriptUsage.make({
            message:
              `LLM4TS_PACK resolves to '${sourceDirAbs}', the same directory ` +
              `LLM4TS_FORK_AS='${forkAs}' would fork into — forking a pack into itself ` +
              "would delete it before it's read. Point LLM4TS_PACK at a different source " +
              "pack, or choose a different LLM4TS_FORK_AS."
          })
        }

        const grounding = yield* stage(
          context.events,
          "grounding",
          readGroundingFiles(repo, techStackGroundingFiles(targetKind))
        )

        const passes = passesForTargetKind(targetKind)
        const sections: Array<string> = []
        for (const [index, pass] of passes.entries()) {
          const askText = conventionPassAsk(pass, index === 0 ? grounding : undefined)
          // Tech Stack & Dependencies (index 0) is the only pass carrying
          // grounding file content — a real package.json/tsconfig.json can
          // make it substantially larger than the other three, ungrounded
          // passes. `capped` bounds every attempt's prompt size (guarding
          // against a truncated, unparseable structured response); `withShrink`
          // retries at a smaller budget on an actual provider overflow —
          // the same pairing every other modernize-* flow already uses
          // ahead of a structuredAndPublish call.
          const result = yield* stage(
            context.events,
            pass.heading,
            withShrink(pass.heading, (cap) =>
              Effect.gen(function* () {
                const prompt = yield* capped(pass.heading, askText, cap)
                return yield* structuredAndPublish(
                  context.reasoning,
                  context.events,
                  prompt,
                  ConventionSection,
                  conventionSectionJsonSchema
                )
              })
            ).pipe(Effect.provideService(FlowEvents, context.events))
          )
          sections.push(result.markdown)
        }
        const conventionsMd = sections.join("\n\n")

        yield* stage(
          context.events,
          "clean",
          Effect.sync(() => rmSync(destinationAbs, { recursive: true, force: true }))
        )

        yield* stage(context.events, "fork", forkPackFiles(opened, destinationAbs, files))
        yield* stage(
          context.events,
          "fork patterns",
          forkKitPatterns(opened, destinationAbs, files)
        )

        const sourcePackMd = yield* opened.workspace.read(`${opened.dir}/pack.md`)
        yield* files.writeAtomic(
          join(destinationAbs, "pack.md"),
          forkPackMarkdown(sourcePackMd, forkAs)
        )
        yield* files.writeAtomic(join(destinationAbs, "conventions.md"), conventionsMd)
        yield* files.writeAtomic(
          join(destinationAbs, "reviewers", "target-conventions.md"),
          targetConventionsReviewer
        )
        yield* files.writeAtomic(
          join(destinationAbs, "README.md"),
          withDraftApproval(
            forkedReadme(opened.pack.name, forkAs, targetKind, basename(input.workDir))
          )
        )

        yield* stage(
          context.events,
          "commit",
          context.git
            .commitPaths(`pack-fork: fork '${opened.pack.name}' as '${forkAs}'`, [destinationRel])
            .pipe(Effect.asVoid)
        )

        yield* context.events.publish(
          Info.make({
            message:
              `forked pack ready — review ${destinationRel}/README.md and ` +
              `${destinationRel}/conventions.md, set '- [x] Approved', then from ` +
              `inside ${input.workDir} run modernize-implement with ` +
              `LLM4TS_PACK=forked/${forkAs}`
          })
        )
      })
  )
})

runFlowMain(program)
