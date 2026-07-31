// Legacy modernization phase 4: prove the implementation equivalent to its spec pack.
//
// Runs rooted at the TARGET repository (`--repo <target>`) behind the enforced
// clean-room wall: equivalence is proven against specs and vectors, never
// against the original code.
//
//   1. Per spec'd program, generate equivalence test vectors from the spec and
//      its BDD scenarios — resumable, one .jsonl per program (delete a file to
//      regenerate just that program).
//   2. Replay every vector through the pack's `replay:` command (a vector JSON
//      on stdin, the resulting observations as a JSON array on stdout) and diff
//      the observations under the pack's comparison policy.
//   3. Report rule-by-rule coverage against the frozen rules.txt — the rule
//      universe extraction wrote; the target side never re-enumerates it.
//   4. Triage the failures into fix specs plus plan tasks appended for
//      modernize-implement, extend the provenance manifest with the report
//      hash, commit, and fail while any vector is red.
//
// Run: modernize-verify --repo ~/services/meridian-transfers
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import {
  CurrentEquivSchema,
  EquivVector,
  Observations,
  readEquivVectors,
  replayEquivVector,
  diffObservations,
  writeEquivVectors,
  type EquivObservation
} from "@llm4ts/flow/Equiv"
import { renderEquivReport, VectorVerdict } from "@llm4ts/flow/EquivReport"
import { FlowAborted, FlowLlmError, PlanParseError } from "@llm4ts/flow/FlowError"
import { Info } from "@llm4ts/flow/FlowEvents"
import type { Pack } from "@llm4ts/flow/Pack"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { stage } from "@llm4ts/flow/PlanExecution"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { Provenance, makeProvenanceStore } from "@llm4ts/flow/Provenance"
import { matchingFiles } from "@llm4ts/flow/SpecChecks"
import { checkWall, wallBreachMessage } from "@llm4ts/flow/Wall"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { generateVectorsResumably } from "@llm4ts/modernize/Artifacts"
import { asReadOnly, coderFromEnv } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"
import { makeNodeWorkspace } from "@llm4ts/runner/NodeWorkspace"
import { openPack } from "@llm4ts/runner/Packs"

const ModDir = "docs/modernization"

/**
 * The model-facing vector shape: flat maps only, so structured output stays
 * schema-simple. `kind` is "record" (an emitted record) or "db" (a mutation).
 */
class GeneratedObservation extends Schema.Class<GeneratedObservation>("GeneratedObservation")({
  kind: Schema.String,
  channel: Schema.String,
  op: Schema.String,
  key: Schema.Record(Schema.String, Schema.String),
  fields: Schema.Record(Schema.String, Schema.String)
}) {}

class GeneratedVector extends Schema.Class<GeneratedVector>("GeneratedVector")({
  id: Schema.String,
  rules: Schema.Array(Schema.String),
  inputs: Schema.Record(Schema.String, Schema.String),
  observations: Schema.Array(GeneratedObservation)
}) {}

class GeneratedVectors extends Schema.Class<GeneratedVectors>("GeneratedVectors")({
  vectors: Schema.Array(GeneratedVector)
}) {}

const generatedVectorsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    vectors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          rules: { type: "array", items: { type: "string" } },
          inputs: { type: "object", additionalProperties: { type: "string" } },
          observations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["record", "db"] },
                channel: { type: "string" },
                op: { type: "string" },
                key: { type: "object", additionalProperties: { type: "string" } },
                fields: { type: "object", additionalProperties: { type: "string" } }
              },
              required: ["kind", "channel", "op", "key", "fields"]
            }
          }
        },
        required: ["id", "rules", "inputs", "observations"]
      }
    }
  },
  required: ["vectors"]
}

class FixSpec extends Schema.Class<FixSpec>("FixSpec")({
  title: Schema.String,
  spec: Schema.String,
  taskTitle: Schema.String,
  taskDescription: Schema.String
}) {}

class VerifyOutcome extends Schema.Class<VerifyOutcome>("VerifyOutcome")({
  fixes: Schema.Array(FixSpec)
}) {}

const verifyOutcomeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          spec: { type: "string" },
          taskTitle: { type: "string" },
          taskDescription: { type: "string" }
        },
        required: ["title", "spec", "taskTitle", "taskDescription"]
      }
    }
  },
  required: ["fixes"]
}

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)

const toObservation = (
  vectorId: string,
  generated: GeneratedObservation
): Effect.Effect<EquivObservation, PlanParseError> => {
  switch (generated.kind.toLowerCase()) {
    case "record":
      return Effect.succeed(Observations.record(generated.channel, generated.fields))
    case "db":
      return Effect.succeed(
        Observations.dbMutation(generated.channel, generated.op, generated.key, generated.fields)
      )
    default:
      return Effect.fail(
        PlanParseError.make({
          message: `vector ${vectorId}: unknown observation kind '${generated.kind}' (expected record|db)`
        })
      )
  }
}

const toVector = Effect.fn("modernize-verify.toVector")(function* (
  program: string,
  generated: GeneratedVector
) {
  const observations: Array<EquivObservation> = []
  for (const observation of generated.observations) {
    observations.push(yield* toObservation(generated.id, observation))
  }
  return EquivVector.make({
    schemaVersion: CurrentEquivSchema,
    program,
    id: generated.id,
    tier: "generated",
    rules: generated.rules,
    inputs: generated.inputs,
    observations
  })
})

const generatePrompt = (
  pack: Pack,
  program: string,
  spec: string,
  feature: string,
  rules: ReadonlyArray<string>
): string =>
  [
    pack.prompt("vectors") ?? "",
    "",
    `Generate equivalence test vectors for the program ${program} from its behavioural spec and`,
    "BDD scenarios below. Vectors are the generated tier: they prove spec conformance, so cover",
    "every rule the spec states — normal paths, boundary values (thresholds exactly at/over/under),",
    "and error paths (rejects, insufficient funds, validation order).",
    "",
    "For each vector:",
    '- "id": short kebab-case name describing the case.',
    '- "rules": the source units it exercises, chosen ONLY from this list (use the exact names).',
    rules.join("\n"),
    '- "inputs": a flat string map — the fields the replay harness needs to drive one execution',
    "  (amounts as plain decimal strings, dates ISO, codes verbatim from the spec).",
    '- "observations": the EXACT outcomes the spec promises, in order. kind "record" for emitted',
    '  records ("channel" names the output, "fields" carries values, "op" and "key" empty); kind',
    '  "db" for database mutations ("channel" = table, "op" = insert/update/delete, "key" addresses',
    '  the row, "fields" = the values written). Every amount, status, and reason code must come',
    "  from the spec — never invent values.",
    "",
    "Aim for 5–8 vectors: the happy path, each boundary, each reject.",
    "",
    "Spec:",
    spec,
    "",
    "Scenarios:",
    feature
  ].join("\n")

const triagePrompt = (
  pack: Pack,
  failing: ReadonlyArray<VectorVerdict>,
  specText: string
): string => {
  const details = failing
    .map((verdict) => {
      const mismatches = verdict.mismatches
        .map((mismatch) => {
          switch (mismatch._tag) {
            case "FieldDiff":
              return `  - ${mismatch.at}: ${mismatch.field} expected ${mismatch.expected}, actual ${mismatch.actual}`
            case "Missing":
              return `  - missing: ${JSON.stringify(mismatch.expected)}`
            case "Unexpected":
              return `  - unexpected: ${JSON.stringify(mismatch.actual)}`
          }
        })
        .join("\n")
      return `- ${verdict.vector.program} ${verdict.vector.id} (rules: ${verdict.vector.rules.join(", ")})\n${mismatches}`
    })
    .join("\n")
  return [
    pack.prompt("review") ?? "",
    "",
    "The equivalence harness replayed test vectors against the implementation and found the",
    "mismatches below. For each DISTINCT root cause produce one fix: a short spec document",
    "(Markdown: the rule violated, expected vs actual behaviour, the failing vector ids) and a",
    "plan task (title + description naming the spec rules). Group mismatches sharing a cause.",
    "If a mismatch reveals a wrong or ambiguous SPEC rather than wrong code, say so explicitly",
    "in that fix document — spec gaps go back to extraction, not to the coder.",
    "",
    "Mismatches:",
    details,
    "",
    "Specs under test:",
    specText
  ].join("\n")
}

/** The spec'd programs: top-level `<NAME>.md` files under the specs dir, indexes aside. */
const specPrograms = Effect.fn("modernize-verify.specPrograms")(function* (
  target: WorkspaceShape,
  specsDir: string
) {
  const paths = yield* matchingFiles(target, `^${specsDir}/[^/]+\\.md$`).pipe(
    Effect.orElseSucceed(() => [])
  )
  const excluded = new Set(["traceability", "mapping", "README"])
  return paths
    .map((path) => (path.split("/").at(-1) ?? path).replace(/\.md$/, ""))
    .filter((name) => !excluded.has(name))
    .sort()
})

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Prove the implementation equivalent to its spec pack")
  const coder = coderFromEnv(process.env)
  const files = nodePlainFileStore
  const planPath = join(input.workDir, ModDir, "plan.md")
  const vectorsDir = join(input.workDir, ModDir, "vectors")

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(coder),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        const target = yield* makeNodeWorkspace(input.workDir)
        const { pack } = yield* stage(
          context.events,
          "pack",
          openPack({
            environment: process.env,
            launchDir: input.workspace,
            flowDir: import.meta.dirname
          })
        )

        yield* stage(
          context.events,
          "wall",
          Effect.gen(function* () {
            if (pack.sources === undefined) {
              return yield* context.events.publish(
                Info.make({ message: "pack has no sources regex — wall check skipped" })
              )
            }
            const result = yield* checkWall(target, pack.sources)
            if (result._tag === "Breached") {
              return yield* FlowAborted.make({
                message: wallBreachMessage(
                  result,
                  "Equivalence is proven against specs and vectors, never against the original code."
                )
              })
            }
            yield* context.events.publish(
              Info.make({ message: "clean-room wall: no legacy source in the target workspace" })
            )
          })
        )

        const rulesText = (yield* files.read(join(input.workDir, pack.specsDir, "rules.txt"))) ?? ""
        const universe = rulesText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        if (universe.length === 0) {
          yield* context.events.publish(
            Info.make({
              message:
                "no rules.txt in the seeded spec pack — the report will use the vectors' own " +
                "rules and cannot flag unexercised ones"
            })
          )
        }

        const programs = yield* stage(
          context.events,
          "programs",
          specPrograms(target, pack.specsDir)
        )
        if (programs.length === 0) {
          return yield* FlowAborted.make({
            message: `no specs under ${pack.specsDir} — run modernize-seed first`
          })
        }

        // Generated-first and resumable per program: an existing .jsonl is kept.
        yield* stage(
          context.events,
          "vectors",
          Effect.gen(function* () {
            const summary = yield* generateVectorsResumably(
              files,
              programs,
              (name) =>
                Effect.gen(function* () {
                  const spec =
                    (yield* files.read(join(input.workDir, pack.specsDir, `${name}.md`))) ?? ""
                  const featurePaths = yield* matchingFiles(
                    target,
                    `^${pack.featuresDir}/.*\\.feature$`
                  ).pipe(Effect.orElseSucceed(() => []))
                  const featurePath = featurePaths.find(
                    (path) =>
                      (path.split("/").at(-1) ?? "").replace(/\.feature$/, "").toLowerCase() ===
                      name.toLowerCase()
                  )
                  const feature =
                    featurePath === undefined
                      ? ""
                      : yield* target.read(featurePath).pipe(Effect.orElseSucceed(() => ""))
                  const generated = yield* context.reasoning
                    .executeStructured(
                      generatePrompt(pack, name, spec, feature, universe),
                      GeneratedVectors,
                      generatedVectorsJsonSchema
                    )
                    .pipe(Effect.mapError(FlowLlmError.from))
                  if (generated.vectors.length === 0) {
                    return yield* FlowAborted.make({
                      message: `generator produced no vectors for ${name}`
                    })
                  }
                  const vectors: Array<EquivVector> = []
                  for (const candidate of generated.vectors) {
                    vectors.push(yield* toVector(name, candidate))
                  }
                  // generateVectorsResumably persists the returned text, so the
                  // encoder writes into a scratch path and hands back its body.
                  const scratch = join(vectorsDir, `.${name}.tmp`)
                  yield* writeEquivVectors(files, scratch, vectors)
                  const encoded = (yield* files.read(scratch)) ?? ""
                  yield* files.remove(scratch)
                  yield* context.events.publish(
                    Info.make({ message: `${vectors.length} vector(s) generated for ${name}` })
                  )
                  return encoded
                }),
              vectorsDir
            )
            if (summary.skipped.length > 0) {
              yield* context.events.publish(
                Info.make({
                  message: `vectors exist for ${summary.skipped.join(", ")} — skipping`
                })
              )
            }
          })
        )

        if (pack.replay === undefined) {
          return yield* FlowAborted.make({
            message:
              `pack '${pack.name}' has no replay: command — add one (reads a vector JSON on ` +
              "stdin, prints the resulting observations as a JSON array on stdout)"
          })
        }
        const replayCommand = pack.replay

        const verdicts = yield* stage(
          context.events,
          "replay",
          Effect.gen(function* () {
            const vectorFiles = yield* matchingFiles(target, `^${ModDir}/vectors/.*\\.jsonl$`).pipe(
              Effect.orElseSucceed(() => [])
            )
            const vectors: Array<EquivVector> = []
            for (const path of [...vectorFiles].sort()) {
              vectors.push(...(yield* readEquivVectors(files, join(input.workDir, path))))
            }
            if (vectors.length === 0) {
              return yield* FlowAborted.make({
                message: `no vectors under ${vectorsDir} — nothing to replay`
              })
            }
            const results: Array<VectorVerdict> = []
            for (const vector of vectors) {
              const replayed = yield* replayEquivVector(
                nodeProcessExecutor,
                context.events,
                replayCommand,
                input.workDir,
                vector
              )
              if (replayed._tag === "Crashed") {
                yield* context.events.publish(
                  Info.make({
                    message:
                      `replay failed for ${vector.program}/${vector.id} ` +
                      `(exit ${replayed.exitCode}): ${replayed.problem.slice(0, 300)}`
                  })
                )
                results.push(
                  VectorVerdict.make({
                    vector,
                    mismatches: vector.observations.map((expected) => ({
                      _tag: "Missing" as const,
                      expected
                    }))
                  })
                )
              } else {
                results.push(
                  VectorVerdict.make({
                    vector,
                    mismatches: diffObservations(
                      vector.observations,
                      replayed.actual,
                      pack.equivalence
                    )
                  })
                )
              }
            }
            return results
          })
        )

        const allRules =
          universe.length > 0
            ? universe
            : [...new Set(verdicts.flatMap((verdict) => verdict.vector.rules))].sort()
        const failing = verdicts.filter((verdict) => !verdict.passed)

        yield* stage(
          context.events,
          "report",
          files.writeAtomic(
            join(input.workDir, ModDir, "equivalence.md"),
            renderEquivReport(verdicts, allRules)
          )
        )

        if (failing.length > 0) {
          yield* stage(
            context.events,
            "triage",
            Effect.gen(function* () {
              const specTexts: Array<string> = [
                (yield* files.read(join(input.workDir, pack.specsDir, "traceability.md"))) ?? ""
              ]
              for (const name of programs) {
                specTexts.push(
                  (yield* files.read(join(input.workDir, pack.specsDir, `${name}.md`))) ?? ""
                )
              }
              const outcome = yield* context.reasoning
                .executeStructured(
                  triagePrompt(pack, failing, specTexts.join("\n\n")),
                  VerifyOutcome,
                  verifyOutcomeJsonSchema
                )
                .pipe(Effect.mapError(FlowLlmError.from))
              for (const fix of outcome.fixes) {
                yield* files.writeAtomic(
                  join(input.workDir, pack.specsDir, "fixes", `fix-${slug(fix.title)}.md`),
                  `# ${fix.title}\n\n${fix.spec}\n`
                )
              }
              if (outcome.fixes.length > 0) {
                const store = makePlanStore(files)
                const plan = yield* store.load(planPath)
                if (plan === undefined) {
                  return yield* FlowAborted.make({
                    message: `no plan at ${planPath} — run modernize-seed first`
                  })
                }
                yield* store.save(
                  planPath,
                  Plan.make({
                    ...plan,
                    tasks: [
                      ...plan.tasks,
                      ...outcome.fixes.map((fix) =>
                        Task.make({
                          title: fix.taskTitle,
                          description: fix.taskDescription,
                          completed: false
                        })
                      )
                    ]
                  })
                )
                yield* context.events.publish(
                  Info.make({
                    message: `${outcome.fixes.length} fix task(s) appended — rerun modernize-implement`
                  })
                )
              }
            })
          )
        }

        yield* stage(
          context.events,
          "provenance",
          Effect.gen(function* () {
            const manifest = join(input.workDir, ModDir, "provenance.json")
            if ((yield* files.read(manifest)) === undefined) {
              return yield* context.events.publish(
                Info.make({ message: "no provenance.json — seeded by an older run; skipping" })
              )
            }
            const provenance = makeProvenanceStore(files)
            const hashes = yield* provenance.hashFiles(input.workDir, [`${ModDir}/equivalence.md`])
            const report = Object.values(hashes)[0]
            // Spreading into a plain object would not satisfy the schema's
            // encoder — the manifest must stay a Provenance instance.
            yield* provenance.extend(manifest, (current) =>
              report === undefined
                ? current
                : Provenance.make({ ...current, equivalenceReport: report })
            )
          })
        )

        const generated = verdicts.filter((verdict) => verdict.vector.tier === "generated").length
        const captured = verdicts.filter((verdict) => verdict.vector.tier === "captured").length
        const summary =
          `${verdicts.filter((verdict) => verdict.passed).length}/${verdicts.length} vectors green ` +
          `(${generated} generated, ${captured} captured)`

        yield* stage(
          context.events,
          "commit",
          context.git
            .commitAll(
              `modernize(${pack.name}): verify — ${summary}` +
                (failing.length > 0 ? `; ${failing.length} failing triaged` : "")
            )
            .pipe(Effect.asVoid)
        )

        if (failing.length > 0) {
          return yield* FlowAborted.make({
            message:
              `equivalence not proven: ${failing.length} failing vector(s) — see ` +
              `${ModDir}/equivalence.md; fix specs filed, rerun modernize-implement`
          })
        }
        yield* context.events.publish(Info.make({ message: summary }))
      })
  )
})

runFlowMain(program)
