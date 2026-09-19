import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { WorkspaceShape } from "@llm4ts/flow/Workspace"
import { ScriptUsage } from "@llm4ts/runner"

export type TargetKind = "frontend" | "backend"

export const parseTargetKind = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<TargetKind, ScriptUsage> => {
  const raw = environment.LLM4TS_TARGET_KIND?.trim().toLowerCase()
  if (raw === "frontend" || raw === "backend") {
    return Effect.succeed(raw)
  }
  return Effect.fail(
    ScriptUsage.make({
      message:
        "LLM4TS_TARGET_KIND must be 'frontend' or 'backend' " +
        `(got ${raw === undefined || raw.length === 0 ? "unset" : `'${raw}'`})`
    })
  )
}

const forkAsPattern = /^[a-z][a-z0-9-]*$/

export const parseForkAs = (
  environment: Readonly<Record<string, string | undefined>>
): Effect.Effect<string, ScriptUsage> => {
  const raw = environment.LLM4TS_FORK_AS?.trim()
  if (raw !== undefined && forkAsPattern.test(raw)) {
    return Effect.succeed(raw)
  }
  return Effect.fail(
    ScriptUsage.make({
      message:
        "LLM4TS_FORK_AS must be a lowercase kebab-case name, e.g. 'acmecorp-nextjs' " +
        `(got ${raw === undefined || raw.length === 0 ? "unset" : `'${raw}'`})`
    })
  )
}

export interface ConventionPass {
  readonly heading: string
  readonly instructions: string
}

export const frontendPasses: ReadonlyArray<ConventionPass> = [
  {
    heading: "Tech Stack & Dependencies",
    instructions:
      "Identify the exact frontend framework and version (e.g. Next.js App Router vs " +
      "Pages Router), the language (TypeScript/JavaScript), the package manager, and " +
      "the state/data libraries already in use. List every direct dependency from the " +
      "grounding files below that a coding agent adding a new feature is likely to " +
      "need (forms, HTTP/data fetching, dates, validation) and name which package " +
      "already covers it, so no duplicate gets added."
  },
  {
    heading: "Naming, Routing & Architecture",
    instructions:
      "Explore the repository's folder structure, then describe: file and folder " +
      "naming conventions (casing, suffixes), how new pages/routes are added and " +
      "where they live, component naming conventions, and where shared " +
      "utilities/constants/hooks live. Use real example paths from this repository, " +
      "not generic advice."
  },
  {
    heading: "Shared Components, Design System & Style",
    instructions:
      "Explore the repository for a shared component library or design system (its " +
      "location, how components are composed and exported, whether there's theming " +
      "or design tokens), and the CSS/styling approach in use (Tailwind, CSS " +
      "Modules, styled-components, or other). Describe how an existing shared " +
      "component should be found and reused rather than rebuilt. If there is no " +
      "design system, say so explicitly rather than inventing one."
  },
  {
    heading: "Auth, Permissions & Data Fetching",
    instructions:
      "Explore how authentication and authorization are implemented (the " +
      "library/provider, where session/user state lives, how a route or component " +
      "checks permissions), and how data is fetched/mutated (React Query, SWR, " +
      "server actions, or plain fetch — and where that logic conventionally lives). " +
      "Describe the pattern precisely enough that a new feature can follow it " +
      "without inventing a new one."
  }
]

export const backendPasses: ReadonlyArray<ConventionPass> = [
  {
    heading: "Tech Stack & Dependencies",
    instructions:
      "Identify the exact backend framework and version (e.g. Spring Boot), the JVM " +
      "language, the build tool, and the database/persistence technology in use. " +
      "List every direct dependency from the grounding files below that a coding " +
      "agent adding a new feature is likely to need (HTTP client, JSON mapping, " +
      "validation, testing) and name which dependency already covers it, so no " +
      "duplicate gets added."
  },
  {
    heading: "Naming & Architecture",
    instructions:
      "Explore the repository's package structure, then describe: package and class " +
      "naming conventions (controllers, services, repositories, DTOs, entities), and " +
      "the layering/module boundaries already established (e.g. controller → " +
      "service → repository, or a domain-driven module split). Use real example " +
      "package/class names from this repository."
  },
  {
    heading: "Data, Persistence & Shared Resources",
    instructions:
      "Explore how entities/persistence are modeled (JPA conventions, migration " +
      "tool such as Flyway/Liquibase, transaction handling), and where " +
      "shared/common resources live (shared utility classes, common exception " +
      "handling, cross-cutting concerns). Describe the pattern precisely enough " +
      "that a new feature reuses what's there instead of rebuilding it."
  },
  {
    heading: "Auth, API & Testing Conventions",
    instructions:
      "Explore how security/auth is configured (the security framework, JWT/OAuth " +
      "setup, role-based or method-level access control), the REST API conventions " +
      "in use (URL/versioning scheme, error response shape, OpenAPI usage), and the " +
      "testing conventions (unit vs integration test structure, fixtures/mocking " +
      "approach). Describe each precisely enough to follow without inventing a new " +
      "one."
  }
]

export const passesForTargetKind = (kind: TargetKind): ReadonlyArray<ConventionPass> =>
  kind === "frontend" ? frontendPasses : backendPasses

/** A prior run's findings plus human feedback on them, for a --feedback re-run. */
export interface Refinement {
  readonly priorConventions: string
  readonly feedback: string
}

export const conventionPassAsk = (
  pass: ConventionPass,
  grounding?: string,
  refinement?: Refinement
): string =>
  [
    pass.instructions,
    `Respond with a single markdown section starting with "## ${pass.heading}".`,
    "If a topic doesn't apply to this repository, say so explicitly rather than " +
      "inventing one.",
    ...(grounding === undefined || grounding.length === 0
      ? []
      : [`Repository files for grounding:\n\n${grounding}`]),
    ...(refinement === undefined
      ? []
      : [
          "A previous run of this analysis produced the findings below, and a human " +
            "reviewed them. Revise — do not simply repeat what you had before:\n\n" +
            `Previous findings (all categories):\n\n${refinement.priorConventions}\n\n` +
            `Human feedback on that previous run:\n\n${refinement.feedback}`
        ])
  ].join("\n\n")

export class ConventionSection extends Schema.Class<ConventionSection>("ConventionSection")({
  markdown: Schema.String
}) {}

export const conventionSectionJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    markdown: {
      type: "string",
      description:
        "A markdown section (starting with a ## heading) describing the findings " +
        "for this category."
    }
  },
  required: ["markdown"]
}

export interface GroundingCandidate {
  readonly category: string
  readonly path: string
  readonly reason: string
}

export class GroundingSelection extends Schema.Class<GroundingSelection>("GroundingSelection")({
  selections: Schema.Array(
    Schema.Struct({
      category: Schema.String,
      path: Schema.String,
      reason: Schema.String
    })
  )
}) {}

export const groundingSelectionJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Must exactly match one of the category headings given."
          },
          path: {
            type: "string",
            description:
              "Must be copied EXACTLY from the candidate file paths given — never " +
              "invented or guessed."
          },
          reason: {
            type: "string",
            description: "One line explaining why this file is relevant to the category."
          }
        },
        required: ["category", "path", "reason"]
      }
    }
  },
  required: ["selections"]
}

/** At most this many selected files get read (and fed as grounding) per category. */
export const maxSelectedFilesPerCategory = 6

export const groundingSelectionAsk = (
  passes: ReadonlyArray<ConventionPass>,
  candidatePaths: ReadonlyArray<string>,
  refinement?: Refinement
): string =>
  [
    "A coding agent needs to analyze this repository's real conventions across the " +
      "categories below. From the list of real file paths given, select the files " +
      "most likely to reveal each category's conventions — representative source " +
      "and configuration files, not every file of a kind.",
    ...passes.map((pass) => `## ${pass.heading}\n\n${pass.instructions}`),
    `Select at most ${maxSelectedFilesPerCategory} files per category — quality over ` +
      "quantity. Every path you return must be copied EXACTLY from the candidate " +
      "list below; never invent or guess a path. A category with nothing relevant " +
      "in this repository can have zero selections — say so via an empty selection " +
      "list for it rather than forcing an irrelevant file in.",
    `Candidate file paths (${candidatePaths.length}):\n\n${candidatePaths.join("\n")}`,
    ...(refinement === undefined
      ? []
      : [
          "A previous run selected files and produced the findings below; a human " +
            "reviewed them and gave feedback. Reconsider the selection in light of " +
            "it — the feedback may point at files that were missed entirely:\n\n" +
            `Previous findings (all categories):\n\n${refinement.priorConventions}\n\n` +
            `Human feedback on that previous run:\n\n${refinement.feedback}`
        ])
  ].join("\n\n")

/**
 * Drops any selection whose path wasn't in the real candidate list (never trust
 * an LLM-fabricated path into a file read) and caps each category at
 * `maxSelectedFilesPerCategory`, keeping the model's own priority order.
 */
export const validSelections = (
  selection: GroundingSelection,
  candidatePaths: ReadonlyArray<string>
): ReadonlyArray<GroundingCandidate> => {
  const candidates = new Set(candidatePaths)
  const perCategoryCount = new Map<string, number>()
  const kept: Array<GroundingCandidate> = []
  for (const item of selection.selections) {
    if (!candidates.has(item.path)) {
      continue
    }
    const count = perCategoryCount.get(item.category) ?? 0
    if (count >= maxSelectedFilesPerCategory) {
      continue
    }
    perCategoryCount.set(item.category, count + 1)
    kept.push(item)
  }
  return kept
}

export const selectionsForCategory = (
  selections: ReadonlyArray<GroundingCandidate>,
  category: string
): ReadonlyArray<string> =>
  selections
    .filter((selection) => selection.category === category)
    .map((selection) => selection.path)

export const provenanceMarkdown = (
  kind: TargetKind,
  selections: ReadonlyArray<GroundingCandidate>,
  feedback?: string
): string => {
  const lines: Array<string> = [
    "# Provenance",
    "",
    "Which real files this pack's conventions.md was grounded on, and why — trace a " +
      "rule back to the file that justified it.",
    ""
  ]
  if (feedback !== undefined && feedback.length > 0) {
    lines.push("## Feedback applied this run", "", feedback, "")
  }
  for (const pass of passesForTargetKind(kind)) {
    lines.push(`## ${pass.heading}`, "")
    const forCategory = selections.filter((selection) => selection.category === pass.heading)
    if (forCategory.length === 0) {
      lines.push(
        "No files selected for grounding — this category's findings rely on the " +
          "model's general knowledge only, not a specific file in this repository.",
        ""
      )
    } else {
      for (const selection of forCategory) {
        lines.push(`- \`${selection.path}\` — ${selection.reason}`)
      }
      lines.push("")
    }
  }
  return lines.join("\n")
}

export const parseFeedback = (
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const raw = environment.LLM4TS_FEEDBACK?.trim()
  return raw === undefined || raw.length === 0 ? undefined : raw
}

export const readGroundingFiles = (
  workspace: WorkspaceShape,
  paths: ReadonlyArray<string>
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const sections: Array<string> = []
    for (const path of paths) {
      const content = yield* workspace
        .read(path)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content !== undefined) {
        sections.push(`### ${path}\n\n\`\`\`\n${content}\n\`\`\``)
      }
    }
    return sections.join("\n\n")
  })

export const forkPackMarkdown = (sourcePackMd: string, forkedName: string): string => {
  const [, ...rest] = sourcePackMd.split("\n")
  const withoutScaffold = rest.filter((line) => !/^scaffold:\s*/.test(line))
  return [`# Pack: ${forkedName}`, ...withoutScaffold].join("\n")
}

export const forkedReadme = (
  sourcePackName: string,
  forkedName: string,
  kind: TargetKind,
  sourceRepo: string
): string =>
  [
    `# Forked pack — ${forkedName}`,
    "",
    `Forked by the pack-fork flow from '${sourcePackName}', analyzing '${sourceRepo}' ` +
      `as a ${kind} target repository.`,
    "",
    "- pack.md — the source pack, copied verbatim except for the dropped `scaffold:` " +
      "line (this pack targets a repository that already exists).",
    "- conventions.md — this repository's own architecture, dependencies, naming, " +
      "and design conventions, captured by analyzing the real target repository. " +
      "Read directly by modernize-implement's generation prompt.",
    "- reviewers/target-conventions.md — a post-hoc review lens checking new code " +
      "against conventions.md.",
    "",
    "Review conventions.md against what you know of the target repository, then flip " +
      "the marker below and point LLM4TS_PACK at this fork."
  ].join("\n")

export const targetConventionsReviewer = [
  "Verify the diff stays inside this repository's established conventions — see " +
    "conventions.md in this pack for the specifics captured when this pack was " +
    "forked from the target repository.",
  "",
  "Flag, and only flag:",
  "- A new dependency added when an existing one in this repo already covers the " + "same need.",
  "- A new shared component, utility, or auth/permission pattern introduced instead " +
    "of reusing the one this repo already has.",
  "- Naming, folder, or style conventions that diverge from what conventions.md " + "describes.",
  "",
  "Do not flag anything conventions.md doesn't mention — silence there means this " +
    "pack's fork never captured an opinion on it."
].join("\n")
