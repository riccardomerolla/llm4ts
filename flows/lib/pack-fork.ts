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

export const conventionPassAsk = (pass: ConventionPass, grounding?: string): string =>
  [
    pass.instructions,
    `Respond with a single markdown section starting with "## ${pass.heading}".`,
    "If a topic doesn't apply to this repository, say so explicitly rather than " +
      "inventing one.",
    ...(grounding === undefined || grounding.length === 0
      ? []
      : [`Repository files for grounding:\n\n${grounding}`])
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

export const techStackGroundingFiles = (kind: TargetKind): ReadonlyArray<string> =>
  kind === "frontend"
    ? ["package.json", "tsconfig.json"]
    : ["pom.xml", "build.gradle", "build.gradle.kts"]

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
