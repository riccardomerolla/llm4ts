# BasecampTool: message-board and todolist read/write ops

Extend `@llm4ts/flow/BasecampTool` with the minimum operations for a
consumer to use a Basecamp project as agent memory and policy surface:
message-board posts as distilled lessons (write + list), and todolists as
read-only policy checklists injected into prompts. Driver: Dunder
Mifflin's memory/policy design (grilling 2026-08-05): the Editor seat
distills lessons into messages titled with the card-kind grammar; the
daemon injects kind-matched lessons and `Policy: <stage> [kind]` todolist
rubrics into maker and QA prompts.

Additive extension beyond llm4zio v4.2.0 under ADR 0009's umbrella; a
`docs/parity.md` note suffices (no new ADR — same module, same protocol,
same capability guards).

## Decisions

| Decision | Choice                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ops      | `listMessages`, `createMessage(title, body)` (`BasecampWrite`), `listTodolists`, `listTodos(todolistId)` — nothing else (no search op: consumers filter titles locally; no todo mutation: policy is read-only to agents). |
| Schemas  | `Message` (id, title, contentHtml, createdAt), `Todolist` (id, title), `TodoItem` (id, title, completed). HTML verbatim as everywhere in the module.                                                                      |
| Flags    | Messages/todolists commands take `--project` only — never `--card-table` (that flag belongs to the cards subcommands alone).                                                                                              |
| Writes   | `createMessage` passes `--no-subscribe` (agent memory must not notify humans per lesson).                                                                                                                                 |
| Nulls    | All list decoders tolerate the CLI's `null`-for-empty (the 0.8.1 rule).                                                                                                                                                   |

## Tasks

- [ ] `Message`, `Todolist`, `TodoItem` schema classes; `parseMessage`,
      `parseMessages`, `parseTodolists`, `parseTodos` (null-tolerant).
- [ ] Args builders: `messageListArgs`, `messageCreateArgs`,
      `todolistListArgs`, `todoListArgs` — project flag only.
- [ ] Wire four ops into `makeBasecampTool` with the existing
      `read`/`write` guards and FlowEvents op names.
- [ ] Deterministic tests from live-captured fixtures (riccardo.log
      message 10171714810, todolist 10171715260) including null payloads.
- [ ] `docs/parity.md` note; verification chain; release 0.9.0.
