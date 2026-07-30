// Legacy modernization phase 2: seed the target repository from the APPROVED spec pack.
//
// Runs rooted at the TARGET repository (`--repo <target>`), reading the spec
// pack out of the legacy repository (`LLM4TS_LEGACY_REPO`). Deliberately
// deterministic — no LLM calls:
//
//   1. Refuses to run until a human has flipped `- [x] Approved` in the legacy
//      repo's docs/modernization/README.md (extract writes it unchecked).
//   2. An empty target gets the pack's scaffold; a non-empty one is used as-is.
//   3. Specs, traceability, mapping, and rules.txt land in the pack's
//      specs-dir; .feature files land in its features-dir. Legacy SOURCE never
//      crosses — that is the clean-room wall the later phases enforce.
//   4. The proposed plan is re-parsed (a hard validation) and materialized at
//      docs/modernization/plan.md for modernize-implement to resume.
//   5. The provenance manifest (docs/modernization/provenance.json) records the
//      clean-room receipt: spec file hashes, gate verdict digests, the pack,
//      the llm4ts version, the extraction seats, and LLM4TS_APPROVER when set.
//
// Run: LLM4TS_LEGACY_REPO=~/estates/meridian-legacy \
//      modernize-seed --repo ~/services/meridian-transfers
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { FlowAborted, PersistenceError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import { packageVersion } from "@llm4ts/flow/Package"
import { loadPack } from "@llm4ts/flow/Pack"
import { parsePlan } from "@llm4ts/flow/Plan"
import { stage } from "@llm4ts/flow/PlanExecution"
import { Provenance, makeProvenanceStore } from "@llm4ts/flow/Provenance"
import { matchingFiles } from "@llm4ts/flow/SpecChecks"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { requireApproval } from "@llm4ts/modernize/Approval"
import { coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"

const ModDir = "docs/modernization"
const skipped = new Set([".git", "target", "node_modules", "dist"])

const Seats = Schema.Record(Schema.String, Schema.String)

const isLitter = (path: string): boolean => path.split("/").some((segment) => skipped.has(segment))

/** Copies every text file under `from` into `into`, skipping build and VCS litter. */
const copyTree = Effect.fn("modernize-seed.copyTree")(function* (
  source: WorkspaceShape,
  target: WorkspaceShape,
  from: string,
  into: string
) {
  const paths = yield* source.discover(`${from}/**`).pipe(Effect.orElseSucceed(() => []))
  let copied = 0
  for (const path of paths) {
    if (isLitter(path)) {
      continue
    }
    const contents = yield* source.read(path).pipe(Effect.orElseSucceed(() => undefined))
    if (contents === undefined) {
      continue
    }
    yield* target.write(join(into, path.slice(from.length + 1)), contents)
    copied += 1
  }
  return copied
})

/** Copies one file when it exists; false when the source is absent. */
const copyFile = Effect.fn("modernize-seed.copyFile")(function* (
  source: WorkspaceShape,
  target: WorkspaceShape,
  from: string,
  into: string
) {
  const contents = yield* source.read(from).pipe(Effect.orElseSucceed(() => undefined))
  if (contents === undefined) {
    return false
  }
  yield* target.write(into, contents)
  return true
})

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Seed the target repository from the approved spec pack")
  const packDir = process.env.LLM4TS_PACK ?? "packs/cobol-springboot"
  const legacyRepo = process.env.LLM4TS_LEGACY_REPO?.trim()
  const files = nodePlainFileStore

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      // This phase makes no model call; the seat is wired only because the
      // runner composes one context shape for every flow.
      coder: coderFromEnv(process.env),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        if (legacyRepo === undefined || legacyRepo.length === 0) {
          return yield* FlowAborted.make({
            message:
              "set LLM4TS_LEGACY_REPO to the legacy repository holding the approved spec pack"
          })
        }
        const launchWorkspace = yield* makeNodeWorkspace(input.workspace)
        const legacy = yield* makeNodeWorkspace(legacyRepo)
        const target = yield* makeNodeWorkspace(input.workDir)
        const pack = yield* stage(context.events, "pack", loadPack(launchWorkspace, packDir))
        const specPackRoot = join(legacyRepo, ModDir)

        yield* stage(
          context.events,
          "approval",
          requireApproval(files, join(specPackRoot, "README.md"))
        )

        yield* stage(
          context.events,
          "scaffold",
          Effect.gen(function* () {
            const existing = (yield* target.discover().pipe(Effect.orElseSucceed(() => []))).filter(
              (path) => !path.startsWith(".git/")
            )
            if (existing.length > 0) {
              yield* context.events.publish(
                Info.make({ message: "target repo is not empty — using it as-is" })
              )
              return
            }
            if (pack.scaffold === undefined) {
              return yield* FlowAborted.make({
                message: `target repo is empty and pack '${pack.name}' has no scaffold`
              })
            }
            // The scaffold path is relative to the pack directory.
            const scaffoldRoot = join(pack.dir, pack.scaffold)
            const scaffold = yield* makeNodeWorkspace(join(input.workspace, scaffoldRoot))
            const paths = (yield* scaffold.discover()).filter((path) => !isLitter(path))
            for (const path of paths) {
              yield* target.write(path, yield* scaffold.read(path))
            }
            yield* context.events.publish(
              Info.make({ message: `scaffolded ${paths.length} file(s) from ${scaffoldRoot}` })
            )
          })
        )

        const seeded = yield* stage(
          context.events,
          "seed",
          Effect.gen(function* () {
            const specs = yield* copyTree(legacy, target, `${ModDir}/specs`, pack.specsDir)
            // A spec pack that contributes no specs means the wrong legacy repo,
            // or an extraction that never wrote any. Seeding an empty target and
            // reporting success would push that discovery minutes downstream.
            if (specs === 0) {
              return yield* FlowAborted.make({
                message:
                  `no specs found under ${legacyRepo}/${ModDir}/specs — ` +
                  "check LLM4TS_LEGACY_REPO and that extraction wrote its spec pack"
              })
            }
            const features = yield* copyTree(legacy, target, `${ModDir}/features`, pack.featuresDir)
            for (const index of ["traceability.md", "mapping.md", "rules.txt"]) {
              yield* copyFile(legacy, target, `${ModDir}/${index}`, join(pack.specsDir, index))
            }
            return specs + features
          })
        )

        const plan = yield* stage(
          context.events,
          "plan",
          Effect.gen(function* () {
            const text = yield* files.read(join(specPackRoot, "plan.md"))
            if (text === undefined) {
              return yield* PersistenceError.make({
                message: "spec pack has no plan.md — did extraction clear its gate?"
              })
            }
            // Re-parsing is the hard validation: a malformed plan fails here,
            // not minutes into the implementation phase.
            const parsed = yield* parsePlan(text)
            yield* target.write(`${ModDir}/plan.md`, parsed.render)
            return parsed
          })
        )

        yield* stage(
          context.events,
          "provenance",
          Effect.gen(function* () {
            const provenance = makeProvenanceStore(files)
            const specFiles = yield* matchingFiles(target, `^${pack.specsDir}/.*\\.md$`)
            const specs = yield* provenance.hashFiles(input.workDir, specFiles)
            const gateFiles = yield* matchingFiles(legacy, `^${ModDir}/gate/.*\\.json$`).pipe(
              Effect.orElseSucceed(() => [])
            )
            const verdicts = yield* provenance.hashFiles(legacyRepo, gateFiles)
            const seatsText = yield* files
              .read(join(specPackRoot, "seats.json"))
              .pipe(Effect.orElseSucceed(() => undefined))
            // A pre-seats spec pack, or a malformed sidecar, degrades to no
            // recorded seats rather than failing the seed.
            const seats =
              seatsText === undefined
                ? {}
                : yield* Effect.try({
                    try: () => Schema.decodeUnknownSync(Schema.fromJsonString(Seats))(seatsText),
                    catch: () => undefined
                  }).pipe(Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})))
            const approver = process.env.LLM4TS_APPROVER?.trim()
            yield* provenance.write(
              join(input.workDir, ModDir, "provenance.json"),
              Provenance.make({
                schema: 1,
                pack: pack.name,
                llm4tsVersion: packageVersion,
                createdAt: new Date().toISOString(),
                ...(approver === undefined || approver.length === 0
                  ? {}
                  : { approvedBy: approver }),
                seats,
                specs,
                gateVerdicts: Object.fromEntries(
                  Object.entries(verdicts).map(([path, hash]) => [
                    (path.split("/").at(-1) ?? path).replace(/\.json$/, ""),
                    hash
                  ])
                ),
                fixSpecs: []
              })
            )
          })
        )

        yield* stage(
          context.events,
          "commit",
          context.git
            .commitAll(
              `modernize(${pack.name}): seed specs, features, plan, and provenance (${seeded} file(s))`
            )
            .pipe(Effect.asVoid)
        )
        yield* context.events.publish(
          Info.make({
            message: `target seeded (plan ${plan.epicId}) — run modernize-implement with the same --repo`
          })
        )
      })
  )
})

runFlowMain(program)
