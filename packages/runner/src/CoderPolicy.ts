import * as Schema from "effect/Schema"
import { Capabilities, type Capability, allows } from "@llm4ts/core/Capability"
import type { Grants } from "@llm4ts/core/Capability"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"

export class AppliedCoderPolicy extends Schema.Class<AppliedCoderPolicy>("AppliedCoderPolicy")({
  config: CliConnectorConfig,
  unenforceable: Schema.Array(Schema.String)
}) {}

interface DeniedPattern {
  readonly capability: Capability
  readonly pattern: string
}

const patterns: ReadonlyArray<DeniedPattern> = [
  {
    capability: Capabilities.GitPush,
    pattern: "Bash(git push:*)"
  },
  {
    capability: Capabilities.GitWrite,
    pattern: "Bash(git commit:*),Bash(git add:*),Bash(git checkout:*)"
  },
  {
    capability: Capabilities.GhWrite,
    pattern: "Bash(gh pr:*),Bash(gh issue:*),Bash(gh api:*)"
  },
  {
    capability: Capabilities.AdoWrite,
    pattern: "Bash(az repos:*),Bash(az boards:*)"
  }
]

const capabilityName = (capability: Capability): string =>
  capability._tag === "Exec" ? `Exec(${capability.command})` : capability._tag

const withDisallowed = (
  config: CliConnectorConfig,
  denied: ReadonlyArray<DeniedPattern>
): CliConnectorConfig => {
  const existing = config.flags["disallowed-tools"]
  const values = [
    ...(existing === undefined || existing.length === 0 ? [] : [existing]),
    ...denied.map(({ pattern }) => pattern)
  ]

  return new CliConnectorConfig({
    ...config,
    flags: {
      ...config.flags,
      "disallowed-tools": values.join(",")
    }
  })
}

export const applyCoderPolicy = (
  config: CliConnectorConfig,
  grants: Grants
): AppliedCoderPolicy => {
  const denied = patterns.filter(({ capability }) => !allows(grants, capability))

  if (denied.length === 0) {
    return new AppliedCoderPolicy({ config, unenforceable: [] })
  }

  if (config.connectorId.value === ConnectorIds.ClaudeCli.value) {
    return new AppliedCoderPolicy({
      config: withDisallowed(config, denied),
      unenforceable: []
    })
  }

  return new AppliedCoderPolicy({
    config,
    unenforceable: denied.map(
      ({ capability }) =>
        `${config.connectorId.value} cannot enforce the missing ${capabilityName(capability)} restriction on the coder`
    )
  })
}
