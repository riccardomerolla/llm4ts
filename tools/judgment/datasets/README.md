# Judgment datasets

`<decision>.jsonl` is the held-out human-labelled evaluation set;
`<decision>.pending.jsonl` contains candidates awaiting human labels. Decisions:
`review-prescreen`, `satisfied-probe`, `program-judge`.

Each UTF-8 JSON line contains `id`, `decision`, `state`, `question`, `source`,
`label`, `labelledBy`, and `labelledAt`. Seeds omit the last three fields.
`state` and `question` use the core Judgment schemas. Truth labels are booleans;
Score labels are integer level indices from zero through `criteria.length - 1`.
`source` identifies a commit and lens or an observation and its log position.
`labelledBy` is a nonblank human name; `labelledAt` is an ISO timestamp.

Aim for 30–100 items per decision. **Hold these items out from anything a scorer
trains on**, including their source observations. No automatically generated
answer counts as a human label.

See [Labelling a decision](../../../docs/judgment-datasets.md) for commands,
promotion validation, and retry semantics.
