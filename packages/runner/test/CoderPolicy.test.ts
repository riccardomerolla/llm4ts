import { assert, describe, it } from "@effect/vitest"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { Grants, allGrants } from "@llm4ts/core/Capability"
import { ConnectorIds } from "@llm4ts/core/Models"
import { applyCoderPolicy } from "@llm4ts/runner/CoderPolicy"

const claude = new CliConnectorConfig({ connectorId: ConnectorIds.ClaudeCli })
const codex = new CliConnectorConfig({ connectorId: ConnectorIds.Codex })

const disallowed = (config: CliConnectorConfig): string => config.flags["disallowed-tools"] ?? ""

describe("CoderPolicy", () => {
  it("leaves full grants untouched", () => {
    const applied = applyCoderPolicy(claude, allGrants)

    assert.deepStrictEqual(applied.config, claude)
    assert.deepStrictEqual(applied.unenforceable, [])
  })

  it("translates missing git push into a Claude deny pattern", () => {
    const applied = applyCoderPolicy(claude, new Grants({ ...allGrants, git: "Write" }))

    assert.match(disallowed(applied.config), /Bash\(git push:\*\)/)
    assert.deepStrictEqual(applied.unenforceable, [])
  })

  it("translates missing GitHub write operations", () => {
    const applied = applyCoderPolicy(claude, new Grants({ ...allGrants, gh: "Read" }))
    const denied = disallowed(applied.config)

    assert.match(denied, /Bash\(gh pr:\*\)/)
    assert.match(denied, /Bash\(gh issue:\*\)/)
    assert.match(denied, /Bash\(gh api:\*\)/)
  })

  it("preserves existing Claude deny patterns", () => {
    const configured = new CliConnectorConfig({
      connectorId: ConnectorIds.ClaudeCli,
      flags: { "disallowed-tools": "WebSearch" }
    })
    const applied = applyCoderPolicy(configured, new Grants({ ...allGrants, git: "Write" }))

    assert.match(disallowed(applied.config), /WebSearch/)
    assert.match(disallowed(applied.config), /Bash\(git push:\*\)/)
  })

  it("reports restrictions unsupported by other connectors", () => {
    const applied = applyCoderPolicy(codex, new Grants({ ...allGrants, git: "Write" }))

    assert.deepStrictEqual(applied.config, codex)
    assert.isTrue(applied.unenforceable.some((detail) => detail.toLowerCase().includes("push")))
  })
})
