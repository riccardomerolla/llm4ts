// PROTOTYPE — throwaway, not production. Answers "what should the new watch
// dashboard look like?" (ADR 0033). Three structurally different layouts over
// one fake run state, no imports, no persistence.
//
//   node tools/prototype/watch-tui.ts --variant A            (list + detail box)
//   node tools/prototype/watch-tui.ts --variant A --mode boards
//   node tools/prototype/watch-tui.ts --variant B            (split pane)
//   node tools/prototype/watch-tui.ts --variant C            (boards first)
//   node tools/prototype/watch-tui.ts --all [--cols 110]

type Task = {
  readonly n: number
  readonly title: string
  readonly state: "done" | "doing" | "review" | "todo"
  readonly satisfies: number
  readonly owns?: string
  readonly depends?: string
  readonly by?: string
}
type Child = {
  readonly kind: "task" | "sub-agent"
  readonly who: string
  readonly what: string
  readonly stage: string
  readonly elapsed: string
  readonly tokens: string
}
type Lane = {
  readonly id: string
  readonly title: string
  readonly clone: string
  readonly task: number
  readonly tasks: ReadonlyArray<Task>
  readonly criteria: ReadonlyArray<string>
  readonly stage: string
  readonly elapsed: string
  readonly tokens: string
  readonly cost: string
  readonly mark: string
  readonly note: string
  readonly children: ReadonlyArray<Child>
  readonly tools: string
  readonly log: ReadonlyArray<string>
  readonly turns: string
}
type Story = { readonly id: string; readonly title: string; readonly status: string }

const lanes: ReadonlyArray<Lane> = [
  {
    id: "S01",
    title: "login-form",
    clone: "codex#1",
    task: 3,
    tasks: [
      { n: 1, title: "add login route", state: "done", satisfies: 1 },
      { n: 2, title: "validate credentials against user store", state: "done", satisfies: 1 },
      { n: 3, title: "wire session cookie", state: "review", satisfies: 2, owns: "src/session/*" },
      {
        n: 4,
        title: "add e2e login test",
        state: "doing",
        satisfies: 3,
        depends: "1",
        by: "claude#2"
      },
      { n: 5, title: "update docs", state: "todo", satisfies: 3, depends: "3,4" }
    ],
    criteria: [
      "the login page posts to /api/login",
      "a valid login sets an httpOnly session cookie",
      "an e2e test covers happy path and bad password"
    ],
    stage: "review",
    elapsed: "12m04s",
    tokens: "48k",
    cost: "~$0.41",
    mark: "◐",
    note: "",
    children: [
      {
        kind: "task",
        who: "claude#2",
        what: "task 4/5 add e2e login test",
        stage: "coder call",
        elapsed: "2m31s",
        tokens: "6k"
      },
      {
        kind: "sub-agent",
        who: "Explore",
        what: "find session middleware",
        stage: "read",
        elapsed: "0m40s",
        tokens: "2k"
      }
    ],
    tools: "Read src/session/cookie.ts · Edit src/session/cookie.ts · Bash pnpm test -- session",
    log: [
      "11:42 review-fix round 1 of 3",
      "11:40 lint green 0m18s",
      "11:38 coder turn 4m02s",
      "11:33 task 3 started"
    ],
    turns: "turns 4 · avg 2m50s · gates 1m20s"
  },
  {
    id: "S02",
    title: "password-reset",
    clone: "codex#2",
    task: 1,
    tasks: [
      { n: 1, title: "scaffold reset route", state: "doing", satisfies: 1 },
      { n: 2, title: "token store", state: "todo", satisfies: 1 },
      { n: 3, title: "email sender", state: "todo", satisfies: 2, depends: "2" },
      { n: 4, title: "tests", state: "todo", satisfies: 3, depends: "1,3" }
    ],
    criteria: [
      "reset link expires in 15 minutes",
      "mail is sent through the outbox",
      "tests cover expiry"
    ],
    stage: "coder call",
    elapsed: "3m12s",
    tokens: "9k",
    cost: "~$0.08",
    mark: "◐",
    note: "",
    children: [],
    tools: "Read src/routes/*.ts",
    log: ["11:50 task 1 started"],
    turns: "turns 1"
  },
  {
    id: "S03",
    title: "otp-step",
    clone: "claude#1",
    task: 2,
    tasks: [
      { n: 1, title: "otp generator", state: "done", satisfies: 1 },
      { n: 2, title: "verify otp in service", state: "doing", satisfies: 1 },
      { n: 3, title: "ui step", state: "todo", satisfies: 2, depends: "2" }
    ],
    criteria: ["otp verified server-side", "ui shows the step after password"],
    stage: "gates",
    elapsed: "9m50s",
    tokens: "31k",
    cost: "~$0.35",
    mark: "◐",
    note: "compacting",
    children: [],
    tools: "Bash pnpm test",
    log: ["11:48 compaction started", "11:47 lint green"],
    turns: "turns 3 · avg 2m10s"
  },
  {
    id: "S04",
    title: "session-store",
    clone: "codex#3",
    task: 5,
    tasks: [
      { n: 1, title: "store interface", state: "done", satisfies: 1 },
      { n: 2, title: "redis impl", state: "done", satisfies: 1 },
      { n: 3, title: "memory impl", state: "done", satisfies: 1 },
      { n: 4, title: "wire layer", state: "done", satisfies: 2 },
      { n: 5, title: "tests", state: "done", satisfies: 2 }
    ],
    criteria: ["one SessionStore service", "layers for redis and memory"],
    stage: "judge 1",
    elapsed: "21m02s",
    tokens: "92k",
    cost: "~$0.80",
    mark: "◐",
    note: "judge gemini",
    children: [],
    tools: "—",
    log: ["11:51 judge round 1", "11:49 story gates green"],
    turns: "turns 6 · avg 2m40s · gates 3m05s"
  },
  {
    id: "S05",
    title: "audit-log",
    clone: "—",
    task: 0,
    tasks: [],
    criteria: [],
    stage: "roster coder",
    elapsed: "1m10s",
    tokens: "0",
    cost: "",
    mark: "⏸",
    note: "waiting",
    children: [],
    tools: "",
    log: ["11:52 waiting for an executor to take coder"],
    turns: ""
  }
]

const stories: ReadonlyArray<Story> = [
  { id: "S00", title: "scaffold", status: "done" },
  ...lanes.map((lane) => ({
    id: lane.id,
    title: lane.title,
    status: lane.note === "waiting" ? "waiting" : "active"
  })),
  { id: "S06", title: "remember-me", status: "planned" },
  { id: "S07", title: "lockout", status: "planned" }
]

const roster = "codex 3/3 · claude 2/2 · gemini 0/1 (judge)"
const header = {
  title: "bank-login",
  action: "round 1 · implement",
  stage: "implement stories",
  elapsed: "24m10s"
}
const verdict =
  "S04 · round 1 · 2 issues   correctness ████████░░ 8/10   tests ██████░░░░ 6/10   style █████████░ 9/10"
const keys = "↑↓ select · e expand · m stories/executors · b boards · l log · q quit"
const footer = [
  "judge gemini · reviews 7 · verdicts 1 · borrowed 0        time [model 62% · tools 5% · gates 24% · wait 9%] · 186k tok · ~$1.64",
  "11:52 S05 waiting for an executor to take coder · 11:51 S04 judge round 1 · 11:50 S02 started · 11:48 S03 compacting"
]

// ---- text helpers ----------------------------------------------------------
const len = (s: string): number => [...s].length
const cut = (s: string, w: number): string =>
  len(s) <= w ? s : [...s].slice(0, Math.max(0, w - 1)).join("") + "…"
const pad = (s: string, w: number): string =>
  cut(s, w) + " ".repeat(Math.max(0, w - len(cut(s, w))))
const box = (w: number, title: string, lines: ReadonlyArray<string>): Array<string> => {
  const inner = w - 4
  const top = `┌─ ${title} ` + "─".repeat(Math.max(0, w - len(title) - 5)) + "┐"
  return [cut(top, w), ...lines.map((l) => `│ ${pad(l, inner)} │`), "└" + "─".repeat(w - 2) + "┘"]
}
const columns = (blocks: ReadonlyArray<ReadonlyArray<string>>, gap = 1): Array<string> => {
  const height = Math.max(...blocks.map((b) => b.length))
  const widths = blocks.map((b) => Math.max(...b.map(len)))
  return Array.from({ length: height }, (_, i) =>
    blocks.map((b, j) => pad(b[i] ?? "", widths[j])).join(" ".repeat(gap))
  )
}
const centre = (s: string, w: number): string =>
  " ".repeat(Math.max(0, Math.floor((w - len(s)) / 2))) + s
const bar = (done: number, total: number, w = 5): string =>
  "█".repeat(Math.round((done / Math.max(1, total)) * w)) +
  "░".repeat(w - Math.round((done / Math.max(1, total)) * w))
const doneOf = (lane: Lane): number => lane.tasks.filter((t) => t.state === "done").length
const chip = (s: Story): string =>
  `${s.id} ${s.status === "done" ? "✔" : s.status === "active" ? "◐" : s.status === "waiting" ? "⏸" : s.status === "failed" ? "✖" : "·"}`
const tick = (t: Task): string => (t.state === "done" ? "[x]" : t.state === "todo" ? "[ ]" : "[▶]")

// ---- shared pieces ---------------------------------------------------------
const headerBoxes = (w: number): Array<string> => {
  const ow = Math.min(46, w)
  const orchestrator = box(ow, "orchestrator", [
    centre(header.action, ow - 4),
    `stage  ${header.stage}`,
    `now    0m42s · story S04: judge 1`,
    `stories ${stories.length}  elapsed ${header.elapsed}`
  ]).map((l) => centre(l, w))
  const judgment = box(w, "judgment", [verdict])
  return [...orchestrator, centre("•", w), ...judgment]
}

const taskList = (lane: Lane, w: number): Array<string> =>
  lane.tasks.map((t) => {
    const right = [
      `satisfies ${t.satisfies}`,
      ...(t.owns ? [`owns ${t.owns}`] : []),
      ...(t.depends ? [`depends ${t.depends}`] : [])
    ].join(" · ")
    const left = `${tick(t)} ${t.n} ${t.title}${t.by ? `   ← ${t.by} running` : ""}`
    return pad(left, w - len(right) - 1) + " " + right
  })

const detailBox = (lane: Lane, w: number): Array<string> => {
  const inner = w - 4
  const current = lane.tasks.find((t) => t.n === lane.task)
  return box(
    w,
    `${lane.id} ${lane.title} · ${lane.clone} · task ${lane.task}/${lane.tasks.length}`,
    [
      ...taskList(lane, inner),
      ...(current
        ? [`satisfies ${current.satisfies}: ${lane.criteria[current.satisfies - 1] ?? ""}`]
        : []),
      `stage  story ${lane.id}: ${lane.stage}${lane.note ? ` · ${lane.note}` : ""} · 1m12s`,
      `tools  ${lane.tools}`,
      `log    ${lane.log.join(" · ")}`,
      `${lane.elapsed} · ${lane.tokens} tok · ${lane.cost} · ${lane.turns}`
    ]
  )
}

// ---- variant A: list + one detail box -------------------------------------
const agentLine = (lane: Lane, selected: boolean, w: number): Array<string> => {
  const taskText =
    lane.task === 0
      ? "—"
      : `task ${lane.task}/${lane.tasks.length} ${lane.tasks[lane.task - 1]?.title ?? ""}`
  const main = columns([
    [`${selected ? "▸" : " "} ${lane.id} ${pad(lane.title, 15)}`],
    [pad(lane.clone, 9)],
    [pad(taskText, 36)],
    [pad(lane.stage, 13)],
    [pad(lane.elapsed, 7)],
    [pad(`${lane.tokens} tok`, 8)],
    [`${lane.mark} ${lane.note}`]
  ])
  const children = lane.children.map(
    (c) =>
      columns([
        [`    └ ${pad(`${c.kind === "task" ? "task coder" : "sub-agent"} ${c.who}`, 20)}`],
        [pad("", 0)],
        [pad(c.what, 36)],
        [pad(c.stage, 13)],
        [pad(c.elapsed, 7)],
        [pad(`${c.tokens} tok`, 8)],
        ["◐"]
      ])[0]
  )
  return [...main, ...children].map((l) => pad(l, w))
}

const variantA = (w: number, mode: "agents" | "boards"): Array<string> => {
  const running = lanes.filter((l) => l.note !== "waiting").length
  const head = [...headerBoxes(w), ...headed(`agents · ${running} running · ${roster}`, w)]
  if (mode === "boards")
    return [...head, ...boardsOf(w), "", chips(w), ...footer.map((l) => pad(l, w))]
  return [
    ...head,
    ...lanes.flatMap((lane) => agentLine(lane, lane.id === "S01", w)),
    ...detailBox(lanes[0], w),
    chips(w),
    ...footer.map((l) => pad(l, w))
  ]
}

const chips = (w: number): string => pad(stories.map(chip).join("   "), w)
/** Left text with the key hints right-aligned, on two lines when they do not fit. */
const headed = (left: string, w: number): Array<string> =>
  len(left) + len(keys) + 2 <= w
    ? [pad(left, w - len(keys)) + keys]
    : [pad(left, w), " ".repeat(Math.max(0, w - len(keys))) + keys]

// ---- boards (variant A's third mode, and the primary view of C) ------------
const epicBoard = (w: number, cards: (s: Story) => Array<string>): Array<string> => {
  const cols = ["planned", "active", "waiting", "done", "failed"]
  const each = Math.floor((w - (cols.length - 1)) / cols.length)
  return columns(
    cols.map((status) => {
      const members = stories.filter((s) => s.status === status)
      return box(
        each,
        `${status} (${members.length})`,
        members.length === 0 ? ["—"] : members.flatMap(cards)
      )
    })
  )
}
const storyBoard = (lane: Lane, w: number): Array<string> => {
  const cols: ReadonlyArray<Task["state"]> = ["todo", "doing", "review", "done"]
  const each = Math.floor((w - (cols.length - 1)) / cols.length)
  return columns(
    cols.map((state) => {
      const members = lane.tasks.filter((t) => t.state === state)
      return box(
        each,
        `${state} (${members.length})`,
        members.length === 0
          ? ["—"]
          : members.map(
              (t) =>
                `${t.n} ${t.title}${t.by ? ` · ${t.by}` : state === "doing" || state === "review" ? ` · ${lane.clone}` : ""}`
            )
      )
    })
  )
}
const boardsOf = (w: number): Array<string> => {
  const card = (s: Story): Array<string> => {
    const lane = lanes.find((l) => l.id === s.id)
    return lane && lane.task > 0
      ? [
          `${s.id} ${s.title}`,
          `  ${lane.clone} · ${doneOf(lane)}/${lane.tasks.length} ${bar(doneOf(lane), lane.tasks.length)} · ${lane.stage}`
        ]
      : [`${s.id} ${s.title}`]
  }
  return [
    pad(`epic board · ${header.title} · ${header.action}`, w),
    ...epicBoard(w, card),
    pad(
      `story board · S01 login-form · codex#1 (+ claude#2 on task 4) · satisfies 2: ${lanes[0].criteria[1]}`,
      w
    ),
    ...storyBoard(lanes[0], w)
  ]
}

// ---- variant B: split pane -------------------------------------------------
const variantB = (w: number): Array<string> => {
  const leftW = 38
  const rightW = w - leftW - 1
  const group = (label: string, ids: ReadonlyArray<string>): Array<string> => [label, ...ids]
  const left = [
    ...group(
      "RUNNING 4",
      lanes
        .filter((l) => l.note !== "waiting")
        .flatMap((l) => [
          `${l.id === "S01" ? "▸" : " "} ${l.id} ${pad(l.title, 14)} ${l.clone} ${doneOf(l)}/${l.tasks.length}`,
          `    ${l.stage}${l.note ? ` · ${l.note}` : ""} · ${l.elapsed}`,
          ...l.children.map(
            (c) => `    └ ${c.kind === "task" ? "task" : "sub"} ${c.who} · ${c.stage}`
          )
        ])
    ),
    "",
    ...group("WAITING 1", ["  S05 audit-log      roster coder 1m10s"]),
    "",
    ...group("PLANNED 2", ["  S06 remember-me", "  S07 lockout"]),
    "",
    ...group("DONE 1", ["  S00 scaffold ✔"])
  ].map((l) => pad(l, leftW))
  const lane = lanes[0]
  const right = [
    `${lane.id} ${lane.title} · ${lane.clone} · task ${lane.task}/${lane.tasks.length} · ${lane.stage} · ${lane.elapsed} · ${lane.tokens} tok`,
    "",
    ...taskList(lane, rightW),
    "",
    `satisfies 2: ${lane.criteria[1]}`,
    "",
    "stage  story S01: review (round 1 of 3) · 1m12s",
    `tools  ${lane.tools}`,
    "",
    "judgment  " + verdict,
    "",
    "log",
    ...lane.log.map((l) => `  ${l}`)
  ].map((l) => pad(l, rightW))
  const top = headed(
    `${header.title} · ${header.action} · ${header.stage} · ${header.elapsed} · 4 running · ${roster}`,
    w
  )
  return [
    ...top,
    "─".repeat(w),
    ...columns(
      [left, ["│", ...Array(Math.max(left.length, right.length) - 1).fill("│")], right],
      0
    ),
    "─".repeat(w),
    ...footer.map((l) => pad(l, w))
  ]
}

// ---- variant C: boards first ----------------------------------------------
const variantC = (w: number): Array<string> => {
  const card = (s: Story): Array<string> => {
    const lane = lanes.find((l) => l.id === s.id)
    if (!lane) return [`${s.id} ${s.title}`, ""]
    if (lane.task === 0) return [`${s.id} ${s.title}`, `  ⏸ ${lane.stage} ${lane.elapsed}`, ""]
    return [
      `${s.id === "S01" ? "▸" : " "}${s.id} ${s.title}`,
      `  ${lane.clone} ${bar(doneOf(lane), lane.tasks.length)} ${doneOf(lane)}/${lane.tasks.length}`,
      `  ${lane.stage}${lane.note ? ` · ${lane.note}` : ""} · ${lane.elapsed}`,
      ...lane.children.map((c) => `  └ ${c.who} ${c.stage}`),
      ""
    ]
  }
  const top = headed(
    `${header.title} · ${header.action} · ${header.elapsed} · 4 running · ${roster}`,
    w
  )
  const lane = lanes[0]
  return [
    ...top,
    ...epicBoard(w, card),
    pad(`▸ S01 login-form · task 3/5 · satisfies 2: ${lane.criteria[1]}`, w),
    ...storyBoard(lane, w),
    pad(`stage review 1m12s · tools ${lane.tools}`, w),
    pad(`judgment ${verdict}`, w),
    ...footer.map((l) => pad(l, w))
  ]
}

// ---- main -------------------------------------------------------------------
const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const cols = Number(flag("cols", String(process.stdout.columns ?? 110)))
const variant = flag("variant", "A").toUpperCase()
const mode = flag("mode", "agents") === "boards" ? "boards" : "agents"
const render = (v: string, m: "agents" | "boards"): Array<string> =>
  v === "B" ? variantB(cols) : v === "C" ? variantC(cols) : variantA(cols, m)
const frames: ReadonlyArray<readonly [string, "agents" | "boards"]> = args.includes("--all")
  ? [
      ["A", "agents"],
      ["A", "boards"],
      ["B", "agents"],
      ["C", "agents"]
    ]
  : [[variant, mode]]
for (const [v, m] of frames) {
  const title = `variant ${v}${v === "A" ? ` · ${m}` : ""}`
  console.log(`═══ ${title} ${"═".repeat(Math.max(0, cols - len(title) - 5))}`)
  console.log(render(v, m).join("\n"))
  console.log()
}
