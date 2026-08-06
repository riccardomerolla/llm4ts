# CLI connectors: honor `turnLimit` in argv

`CliConnectorConfig.turnLimit` is decorative today: no CLI connector maps
it to its harness's turn cap (`claude --max-turns`, and equivalents where
they exist). A consumer setting `turnLimit: 40` gets an unbounded run —
Dunder Mifflin's ghostwriter spent 90+ minutes and 116 tool calls on one
draft with the "cap" set, because the field reaches no argv. The consumer
now works around it via the `flags` passthrough (`"max-turns": "40"`).

Task: `claudeCliExtraArgs` (and each CLI connector with a native cap)
emits the turn-limit flag from `config.turnLimit`; explicit `flags` win
on conflict. Deterministic argv tests per connector; parity note
(llm4zio comparison of turn-limit semantics). Connectors with no native
cap document that in the capability matrix rather than silently ignoring
the field.
