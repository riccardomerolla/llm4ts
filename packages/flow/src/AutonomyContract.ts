// The autonomy contract (ADR 0027, decision 5): the one paragraph every
// unattended coder's system prompt carries, in three profiles. Flows stop
// writing their own version; an executor's roster entry picks a profile.
import * as Schema from "effect/Schema"

export const ContractProfile = Schema.Literals(["full", "minimal", "off"])
export type ContractProfile = typeof ContractProfile.Type

const scope = [
  "The task you are given is the whole scope of your work: deliver all of it and nothing beyond",
  "it, never narrowing it quietly, widening it, or swapping it for a neighbouring task."
]

const workspace = [
  "Your working directory is the whole of your world. The tool that runs you is not part of the",
  "task: do not look for its installation, source code, processes or environment, and read its",
  "files only where your instructions name them. What it expects of you is in your instructions."
]

const noGaming = [
  "Never edit, skip, delete or weaken a test to make a gate pass. A test you believe is wrong is a",
  "finding to report, not a line to change; a pre-existing bug outside your task is a finding, not",
  "a fix. Scratch checks you write to convince yourself do not become permanent test files."
]

const unattended = [
  "Nobody is watching this run and nobody answers questions mid-task. Decide and act; do not",
  "announce what you are about to do or ask whether to proceed. Local, reversible changes are",
  "yours to make. Stop only for a destructive step or a change of scope, and say why."
]

const minimalChange = [
  "Make the smallest change that completes the task in the repository's own style. Do not add",
  "features, abstractions, options or comments that nobody asked for."
]

const evidence = [
  "Finish with evidence, not a claim: name the commands you ran to check your work and how they",
  "ended. A statement that something works, with no command behind it, is not a result."
]

/**
 * The contract for a profile. `full` is the default; `minimal` keeps scope,
 * the workspace rule and the no-gaming rule for a model that over-verifies
 * under the full text;
 * `off` is the empty string, for a flow that writes its own rules.
 */
export const autonomyContract = (profile: ContractProfile = "full"): string => {
  switch (profile) {
    case "off":
      return ""
    case "minimal":
      return [...scope, ...workspace, ...noGaming].join("\n")
    case "full":
      return [
        ...unattended,
        ...scope,
        ...workspace,
        ...minimalChange,
        ...noGaming,
        ...evidence
      ].join("\n")
  }
}

/** The system prompt with the contract in front; unchanged when the profile is `off`. */
export const withContract = (
  system: string | undefined,
  profile: ContractProfile = "full"
): string => {
  const contract = autonomyContract(profile)
  const rest = system === undefined ? "" : system.trim()
  if (contract.length === 0) return rest
  return rest.length === 0 ? contract : `${contract}\n\n${rest}`
}
