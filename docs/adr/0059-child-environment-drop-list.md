# ADR 0059: A Drop List For Child Environments

Status: Accepted · Date: 2026-11-25 · Extends ADR 0058

## Context

Every process a run starts (a coding agent, a gate, a setup command)
inherits the run's environment without its `LLM4TS_*` variables. Anything
else in the launching shell reaches it. The review that led to ADR 0058
showed a worker's `TEMPORAL_API_KEY` in the coding agent's environment, and
ADR 0058 left that open.

llm4ts cannot tell a credential from any other variable. A coding agent
needs its provider's key, a gate may need a registry token or `JAVA_HOME`,
and an agent that calls `gh` needs `GITHUB_TOKEN`. The operator who launches
the run is the one who knows what the shell holds that a child has no use
for.

## Decision

1. **`LLM4TS_CHILD_ENV_DROP` names what children do not inherit.** It is a
   comma-separated list of variable names; `*` in a name stands for any run
   of characters (`TEMPORAL_*,AWS_*,GITHUB_TOKEN`). Every other character is
   literal, and names are case-sensitive.
2. **It applies at the one spawn seam** (`childEnvironment` in the runner's
   process executor), so it covers coding agents, gates and setup commands
   alike.
3. **Unset, nothing changes.** There is no default list: any default would
   break a run that needs the variable.
4. **What the run sets for a child stays.** A variable a connector or the
   flow passes to a child on purpose is not inherited, so the list does not
   remove it.
5. **The flow process itself keeps its environment.** The list narrows what
   the run hands on, not what llm4ts reads.

## Alternatives

- **An allow list.** Stronger, but a gate or an agent that needs an unlisted
  variable fails until someone adds it, on every machine.
- **Strip the credential variables of connectors other than the running
  one.** Automatic, but it knows only provider keys; it would not have
  removed `TEMPORAL_API_KEY`.

## Consequences

- An operator who runs llm4ts from a process that holds credentials (a
  worker, a CI job) can keep them from the coding agent with one setting.
- A name on the list that a child needs makes that child fail the way a
  missing variable does; nothing warns about it.
- The list is not a sandbox. A child can still read files the user can read.
