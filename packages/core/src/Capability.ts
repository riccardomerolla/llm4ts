import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class GitRead extends Schema.TaggedClass<GitRead>()("GitRead", {}) {}
export class GitWrite extends Schema.TaggedClass<GitWrite>()("GitWrite", {}) {}
export class GitPush extends Schema.TaggedClass<GitPush>()("GitPush", {}) {}
export class GhRead extends Schema.TaggedClass<GhRead>()("GhRead", {}) {}
export class GhWrite extends Schema.TaggedClass<GhWrite>()("GhWrite", {}) {}
export class AdoRead extends Schema.TaggedClass<AdoRead>()("AdoRead", {}) {}
export class AdoWrite extends Schema.TaggedClass<AdoWrite>()("AdoWrite", {}) {}
export class Exec extends Schema.TaggedClass<Exec>()("Exec", {
  command: Schema.String
}) {}
export class UseCoder extends Schema.TaggedClass<UseCoder>()("UseCoder", {}) {}
export class UseReasoning extends Schema.TaggedClass<UseReasoning>()("UseReasoning", {}) {}
export class Declassify extends Schema.TaggedClass<Declassify>()("Declassify", {}) {}

export const Capability = Schema.Union([
  GitRead,
  GitWrite,
  GitPush,
  GhRead,
  GhWrite,
  AdoRead,
  AdoWrite,
  Exec,
  UseCoder,
  UseReasoning,
  Declassify
])
export type Capability = typeof Capability.Type

export const Capabilities = Object.freeze({
  Schema: Capability,
  GitRead: new GitRead(),
  GitWrite: new GitWrite(),
  GitPush: new GitPush(),
  GhRead: new GhRead(),
  GhWrite: new GhWrite(),
  AdoRead: new AdoRead(),
  AdoWrite: new AdoWrite(),
  Exec: (command: string): Exec => new Exec({ command }),
  UseCoder: new UseCoder(),
  UseReasoning: new UseReasoning(),
  Declassify: new Declassify()
})

export const GrantLevel = Schema.Literals(["None", "Read", "Write", "Push"])
export type GrantLevel = typeof GrantLevel.Type

const levelRank = (level: GrantLevel): number => {
  switch (level) {
    case "None":
      return 0
    case "Read":
      return 1
    case "Write":
      return 2
    case "Push":
      return 3
  }
}

const minLevel = (first: GrantLevel, second: GrantLevel): GrantLevel =>
  levelRank(first) <= levelRank(second) ? first : second

const maxLevel = (first: GrantLevel, second: GrantLevel): GrantLevel =>
  levelRank(first) >= levelRank(second) ? first : second

export class ExecDenied extends Schema.TaggedClass<ExecDenied>()("Denied", {}) {}
export class ExecAllow extends Schema.TaggedClass<ExecAllow>()("Allow", {
  commands: Schema.ReadonlySet(Schema.String)
}) {}
export class ExecAll extends Schema.TaggedClass<ExecAll>()("All", {}) {}

export const ExecGrant = Schema.Union([ExecDenied, ExecAllow, ExecAll])
export type ExecGrant = typeof ExecGrant.Type

export const ExecGrants = Object.freeze({
  Denied: new ExecDenied(),
  All: new ExecAll()
})

export const allowExec = (commands: Iterable<string>): ExecAllow =>
  new ExecAllow({ commands: new Set(commands) })

const intersectExec = (first: ExecGrant, second: ExecGrant): ExecGrant => {
  if (first._tag === "Denied" || second._tag === "Denied") {
    return ExecGrants.Denied
  }
  if (first._tag === "All") {
    return second
  }
  if (second._tag === "All") {
    return first
  }
  return allowExec([...first.commands].filter((command) => second.commands.has(command)))
}

const unionExec = (first: ExecGrant, second: ExecGrant): ExecGrant => {
  if (first._tag === "All" || second._tag === "All") {
    return ExecGrants.All
  }
  if (first._tag === "Denied") {
    return second
  }
  if (second._tag === "Denied") {
    return first
  }
  return allowExec(new Set([...first.commands, ...second.commands]))
}

export class Grants extends Schema.Class<Grants>("Grants")({
  git: GrantLevel,
  gh: GrantLevel,
  ado: GrantLevel,
  exec: ExecGrant,
  coder: Schema.Boolean,
  reasoning: Schema.Boolean,
  declassify: Schema.Boolean
}) {}

export const allGrants = new Grants({
  git: "Push",
  gh: "Write",
  ado: "Write",
  exec: ExecGrants.All,
  coder: true,
  reasoning: true,
  declassify: true
})

export const noneGrants = new Grants({
  git: "None",
  gh: "None",
  ado: "None",
  exec: ExecGrants.Denied,
  coder: false,
  reasoning: false,
  declassify: false
})

export const intersectGrants = (first: Grants, second: Grants): Grants =>
  new Grants({
    git: minLevel(first.git, second.git),
    gh: minLevel(first.gh, second.gh),
    ado: minLevel(first.ado, second.ado),
    exec: intersectExec(first.exec, second.exec),
    coder: first.coder && second.coder,
    reasoning: first.reasoning && second.reasoning,
    declassify: first.declassify && second.declassify
  })

export const unionGrants = (first: Grants, second: Grants): Grants =>
  new Grants({
    git: maxLevel(first.git, second.git),
    gh: maxLevel(first.gh, second.gh),
    ado: maxLevel(first.ado, second.ado),
    exec: unionExec(first.exec, second.exec),
    coder: first.coder || second.coder,
    reasoning: first.reasoning || second.reasoning,
    declassify: first.declassify || second.declassify
  })

const execAllows = (grant: ExecGrant, command: string): boolean => {
  switch (grant._tag) {
    case "Denied":
      return false
    case "Allow":
      return grant.commands.has(command)
    case "All":
      return true
  }
}

export const allows = (grants: Grants, capability: Capability): boolean => {
  switch (capability._tag) {
    case "GitRead":
      return levelRank(grants.git) >= levelRank("Read")
    case "GitWrite":
      return levelRank(grants.git) >= levelRank("Write")
    case "GitPush":
      return levelRank(grants.git) >= levelRank("Push")
    case "GhRead":
      return levelRank(grants.gh) >= levelRank("Read")
    case "GhWrite":
      return levelRank(grants.gh) >= levelRank("Write")
    case "AdoRead":
      return levelRank(grants.ado) >= levelRank("Read")
    case "AdoWrite":
      return levelRank(grants.ado) >= levelRank("Write")
    case "Exec":
      return execAllows(grants.exec, capability.command)
    case "UseCoder":
      return grants.coder
    case "UseReasoning":
      return grants.reasoning
    case "Declassify":
      return grants.declassify
  }
}

const CurrentGrants = Context.Reference<Grants>("@llm4ts/core/CurrentGrants", {
  defaultValue: () => allGrants
})

export const currentGrants: Effect.Effect<Grants> = Effect.map(CurrentGrants, (grants) => grants)

export const restricted =
  (grants: Grants) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(CurrentGrants, (current) =>
      Effect.provideService(effect, CurrentGrants, intersectGrants(current, grants))
    )

export class CapabilityDenied extends Schema.TaggedErrorClass<CapabilityDenied>()(
  "CapabilityDenied",
  {
    required: Schema.Array(Capability),
    granted: Grants
  }
) {
  get message(): string {
    const names = this.required.map((capability) =>
      capability._tag === "Exec" ? `Exec(${capability.command})` : capability._tag
    )
    return `missing required capabilities: ${names.join(", ")}`
  }
}

export const requireCapabilities =
  (required: ReadonlyArray<Capability>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | CapabilityDenied, R> =>
    Effect.flatMap(CurrentGrants, (granted): Effect.Effect<A, E | CapabilityDenied, R> => {
      const missing = required.filter((capability) => !allows(granted, capability))
      return missing.length === 0
        ? effect
        : Effect.fail(new CapabilityDenied({ required: missing, granted }))
    })
