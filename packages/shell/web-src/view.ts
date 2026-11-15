import { clock, dollars, elapsed, formatCount } from "@llm4ts/runner/Format"
import type {
  WebExecutor,
  WebFrame,
  WebStory,
  WebTimelineItem,
  WebTranscript,
  WebVerdict
} from "../src/WebFrame.ts"
import {
  epicColumns,
  initialDetail,
  progressOf,
  storyColumns,
  tailTargetOf,
  tasksIn,
  type DetailState,
  type PageView
} from "./views.ts"

/**
 * The page's drawing (ADR 0051), ported from the approved v2 design: plain
 * typed functions from a frame to the DOM. No markup carries a `style`
 * attribute, so the page runs under `default-src 'self'`; colours are
 * classes in style.css, and positions are set through `element.style`.
 */

export const reduceMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches

const issues = (n: number): string => `${n} issue${n === 1 ? "" : "s"}`
const tok = (n: number): string => formatCount(n)
const escapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;"
}
export const esc = (value: string | number): string =>
  String(value).replace(/[&<>"]/g, (c) => escapes[c] ?? c)

export const find = (root: ParentNode, selector: string): HTMLElement | undefined => {
  const found = root.querySelector(selector)
  return found instanceof HTMLElement ? found : undefined
}
export const findAll = (root: ParentNode, selector: string): ReadonlyArray<HTMLElement> =>
  [...root.querySelectorAll(selector)].filter((node) => node instanceof HTMLElement)
export const bind = (root: ParentNode, key: string, text: string | number): void => {
  for (const node of findAll(root, `[data-bind="${key}"]`)) {
    node.textContent = String(text)
  }
}

/** Sets markup only when it changed, so a redraw does not restart its animations. */
export const setHtml = (el: Element | undefined, html: string): void => {
  if (el === undefined || !(el instanceof HTMLElement || el instanceof SVGElement)) {
    return
  }
  if (el.dataset["html"] === html) {
    return
  }
  el.dataset["html"] = html
  el.innerHTML = html
}

/** Bar widths from `data-pct`, set after the markup, which cannot carry a style. */
const placeAll = (root: ParentNode): void => {
  for (const node of findAll(root, "[data-pct]")) {
    node.style.width = `${node.dataset["pct"] ?? 0}%`
  }
}

/** "epic conto-bonifico" → the orchestrator's name and what it is about. */
const titleParts = (
  frame: WebFrame
): { readonly kind: string; readonly name: string; readonly branch: string } => {
  const match = /^(epic)\s+(.+)$/u.exec(frame.title)
  const kind = match?.[1]
  const name = match?.[2]
  return kind !== undefined && name !== undefined
    ? { kind, name, branch: `epic/${name}` }
    : { kind: frame.title, name: frame.action ?? "", branch: "merge" }
}

// ── graph geometry ──
const X = { orch: 40, story: 330, judge: 720, jmt: 960, merge: 1180 } as const
const NW = 198
const ROW = 84
const geometry = (
  count: number
): { readonly height: number; readonly oy: number; readonly top: number } => {
  const height = Math.max(560, 32 + count * ROW + 24)
  return { height, oy: Math.round(height / 2) - 28, top: 32 }
}
const curve = (x0: number, y0: number, x1: number, y1: number): string => {
  const m = (x0 + x1) / 2
  return `M${x0} ${y0} C${m} ${y0} ${m} ${y1} ${x1} ${y1}`
}
const ICON = {
  star: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 1.5c.7 5.6 3.4 8.5 10.5 10.5-7.1 2-9.8 4.9-10.5 10.5C11.3 16.9 8.6 14 1.5 12 8.6 10 11.3 7.1 12 1.5z"/></svg>',
  fail: '<svg class="icon" viewBox="0 0 24 24"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8zm2.1 5L7 10.1 8.9 12 7 13.9 10.1 17 12 15.1 13.9 17 17 13.9 15.1 12 17 10.1 13.9 7 12 8.9z"/></svg>'
} as const

type NodeState = "idle" | "running" | "waiting" | "done" | "failed" | "issues"

const nodeView = (state: NodeState, result: string): string =>
  state === "done" || state === "issues"
    ? `<span class="content">${esc(result)}</span>`
    : state === "failed"
      ? `<span class="content">${ICON.fail}</span>`
      : state === "running"
        ? ""
        : `<span class="content">${ICON.star}</span>`
const nodeState = (status: WebStory["status"]): NodeState =>
  status === "planned" ? "idle" : status

/** Restarts a one-shot CSS animation on `el`. */
const restart = (el: HTMLElement, name: string): void => {
  el.classList.remove(name)
  void el.offsetWidth
  el.classList.add(name)
}

export interface FrameView {
  readonly render: (frame: WebFrame, animate: boolean) => void
  /** Shows the graph, the executors or the boards, and redraws the frame in hand. */
  readonly show: (view: PageView) => void
  /** What the detail card's body shows; redraws the frame in hand. */
  readonly detail: (state: DetailState) => void
  /** The open tail's answer, or what kept it from coming, drawn in the detail card. */
  readonly tail: (
    answer: WebTranscript | { readonly _tag: "Failed"; readonly message: string }
  ) => void
  /** Whose transcript the tail shows now: the picked executor, or the story on the card. */
  readonly tailTarget: () => ReturnType<typeof tailTargetOf>
  /** What the flow card shows now. */
  readonly shown: () => PageView
  /** The roster's executors, in order, and the one selected in the executors view. */
  readonly executors: () => { readonly names: ReadonlyArray<string>; readonly selected?: string }
  /** Selects an executor, as a click on its card does. */
  readonly pickExecutor: (name: string) => void
}

export interface ViewOptions {
  readonly mode: "live" | "replay"
  readonly reduce: boolean
  readonly frozen: boolean
  readonly view: PageView
  /** The reader picked a story or an executor. */
  readonly onSelect?: () => void
}

export const makeView = (root: HTMLElement, options: ViewOptions): FrameView => {
  const { mode, reduce, frozen } = options
  const viz = find(root, "[data-graph]")
  const executorsPane = find(root, "[data-executors]")
  const boardsPane = find(root, "[data-boards]")
  const nodes = new Map<string, HTMLElement>()
  const last = new Map<string, string>()
  let picked: string | undefined
  let pickedExecutor: string | undefined
  let detail: DetailState = initialDetail
  let shape = ""
  let svg: SVGSVGElement | undefined
  let current: WebFrame | undefined
  let view = options.view

  const redraw = (): void => {
    if (current !== undefined) {
      render(current, false)
    }
  }
  const pick = (id: string): void => {
    picked = id
    redraw()
    options.onSelect?.()
  }
  const pickExecutor = (name: string): void => {
    pickedExecutor = name
    redraw()
    executorsPane?.querySelector(".exec-card.selected")?.scrollIntoView({ block: "nearest" })
    options.onSelect?.()
  }
  executorsPane?.addEventListener("click", (event) => {
    const card = event.target instanceof Element ? event.target.closest("[data-executor]") : null
    const name = card instanceof HTMLElement ? card.dataset["executor"] : undefined
    if (name !== undefined) {
      pickExecutor(name)
    }
  })
  boardsPane?.addEventListener("click", (event) => {
    const card = event.target instanceof Element ? event.target.closest("[data-story]") : null
    const id = card instanceof HTMLElement ? card.dataset["story"] : undefined
    if (id !== undefined) {
      pick(id)
    }
  })

  const selected = (): string | undefined => {
    const ids = current?.stories.map((story) => story.id) ?? []
    return picked !== undefined && ids.includes(picked) ? picked : current?.focus
  }
  const selectedExecutor = (): string | undefined =>
    current?.roster.some((executor) => executor.name === pickedExecutor) === true
      ? pickedExecutor
      : undefined
  const tailTarget = (): ReturnType<typeof tailTargetOf> =>
    tailTargetOf(view, selected(), selectedExecutor())

  const layout = (count: number): void => {
    const key = String(count)
    if (key === shape || viz === undefined) {
      return
    }
    shape = key
    const { height } = geometry(count)
    viz.style.height = `${height}px`
    viz.innerHTML = `<svg class="edges" width="1390" height="${height}" viewBox="0 0 1390 ${height}"></svg>`
    const drawn = viz.querySelector("svg")
    svg = drawn instanceof SVGSVGElement ? drawn : undefined
    nodes.clear()
    last.clear()
    const captions: ReadonlyArray<readonly [string, number]> = [
      ["orchestrator", X.orch],
      [`stories · ${count}`, X.story],
      ["judge seat", X.judge],
      ["judgment", X.jmt],
      ["merge", X.merge]
    ]
    for (const [text, x] of captions) {
      const caption = document.createElement("span")
      caption.className = "caption"
      caption.style.left = `${x}px`
      caption.textContent = text
      viz.append(caption)
    }
  }

  const ensure = (id: string, x: number, y: number, story: boolean): HTMLElement => {
    const known = nodes.get(id)
    if (known !== undefined) {
      known.style.top = `${y}px`
      return known
    }
    const el = document.createElement("div")
    el.className = story ? "node story" : "node"
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.dataset["id"] = id
    el.innerHTML = `<div class="box"><div class="shine"></div><div class="slot"></div></div><div class="label"><span class="n"></span><span class="s"></span><span class="t"></span></div>`
    if (story) {
      el.addEventListener("click", () => pick(id))
    }
    viz?.append(el)
    nodes.set(id, el)
    return el
  }

  const setNode = (
    id: string,
    x: number,
    y: number,
    state: NodeState,
    text: { readonly name: string; readonly sub: string; readonly time: string },
    result: string,
    animate: boolean,
    story = false
  ): void => {
    const el = ensure(id, x, y, story)
    const prev = last.get(id)
    const key = `${state}|${result}`
    el.dataset["state"] = state
    const label = (selector: string, value: string): void => {
      const span = find(el, selector)
      if (span !== undefined) {
        span.textContent = value
      }
    }
    label(".n", text.name)
    label(".s", text.sub)
    label(".t", text.time)
    el.classList.toggle("selected", story && id === selected())
    if (prev !== key) {
      const slot = find(el, ".slot")
      if (slot !== undefined) {
        slot.innerHTML = nodeView(state, result)
      }
      if (animate && !reduce && prev !== undefined) {
        const box = find(el, ".box")
        if (state === "done" || state === "issues") {
          const content = slot?.firstElementChild
          content?.classList.add("pop")
        }
        if (box !== undefined && state === "failed") {
          restart(box, "shake")
        }
        if (box !== undefined && id === "merge" && state === "done") {
          restart(box, "flash")
        }
      }
    }
    last.set(id, key)
  }

  const render = (frame: WebFrame, animate: boolean): void => {
    current = frame
    const now = frame.now ?? 0
    const t0 = frame.startedAt ?? now
    const stories = frame.stories
    layout(stories.length)
    const { oy, top } = geometry(stories.length)
    const sy = (i: number): number => top + i * ROW
    const parts = titleParts(frame)
    // nodes
    const allDone = stories.length > 0 && stories.every((story) => story.status === "done")
    const orchState: NodeState =
      frame.ended === "failed"
        ? "failed"
        : allDone || frame.ended !== undefined
          ? "done"
          : "running"
    setNode(
      "orch",
      X.orch,
      oy,
      orchState,
      { name: parts.kind, sub: parts.name, time: elapsed(t0, now) },
      "done",
      animate
    )
    stories.forEach((story, i) => {
      const state = nodeState(story.status)
      const time =
        state === "running"
          ? `${elapsed(story.startedAt, now)} · ${tok(story.tokens)} tok`
          : state === "done" && story.startedAt !== undefined
            ? `${elapsed(story.startedAt, story.endedAt ?? now)} · ${tok(story.tokens)} tok`
            : state === "failed"
              ? (story.failStage ?? "")
              : ""
      setNode(
        story.id,
        X.story,
        sy(i),
        state,
        { name: story.id, sub: story.executor ?? story.status, time },
        story.merged ? "merged" : "done",
        animate,
        true
      )
    })
    const judge = frame.judge
    setNode(
      "judge",
      X.judge,
      oy,
      judge.state,
      {
        name: "judge seat",
        sub: judge.executor !== undefined ? `${judge.executor} · on call` : "[not leased yet]",
        time: `reviews ${judge.reviews} · verdicts ${judge.verdicts}`
      },
      "",
      animate
    )
    const verdict = frame.verdicts.at(-1)
    setNode(
      "jmt",
      X.jmt,
      oy,
      verdict === undefined ? "idle" : verdict.cleared ? "done" : "issues",
      {
        name: "judgment",
        sub: verdict === undefined ? "[none yet]" : `${verdict.lane} r${verdict.round}`,
        time:
          verdict === undefined
            ? ""
            : verdict.cleared
              ? "cleared → merge"
              : `${issues(verdict.issues)} → coder`
      },
      verdict === undefined ? "" : verdict.cleared ? "cleared" : issues(verdict.issues),
      animate
    )
    setNode(
      "merge",
      X.merge,
      oy,
      frame.merged > 0 ? "done" : "idle",
      {
        name: "merge",
        sub: parts.branch,
        time: `${frame.counts.done}/${frame.counts.total} done`
      },
      `${frame.merged}/${frame.counts.total}`,
      animate
    )
    // edges + token flow
    const oc = [X.orch + NW - 10, oy + 28] as const
    let html = ""
    stories.forEach((story, i) => {
      const state = nodeState(story.status)
      const y = sy(i) + 28
      html += `<path id="${mode}-e-o-${i}" class="edge ${state}" d="${curve(oc[0], oc[1], X.story - 8, y)}"/>`
      const judged = frame.verdicts.some((v) => v.lane === story.id)
      if (state === "running" || state === "done" || judged) {
        const cls = state === "done" ? "done" : "pending"
        html += `<path id="${mode}-e-j-${i}" class="edge ${cls}" d="${curve(X.story + NW + 6, y, X.judge - 8, oy + 28)}"/>`
      }
    })
    html += `<path class="edge ${verdict !== undefined ? "done" : "idle"}" d="M${X.judge + NW - 20} ${oy + 28} L${X.jmt - 8} ${oy + 28}"/>`
    html += `<path class="edge ${frame.merged > 0 ? "done" : "idle"}" d="M${X.jmt + NW - 20} ${oy + 28} L${X.merge - 8} ${oy + 28}"/>`
    // token pulses: two dots per running edge, 1.2s a pass
    stories.forEach((story, i) => {
      if (story.status !== "running") {
        return
      }
      for (const pid of [`${mode}-e-o-${i}`, `${mode}-e-j-${i}`]) {
        for (const d of [0, 0.6]) {
          html += `<circle class="token" r="3"><animateMotion dur="1.2s" begin="-${d}s" repeatCount="indefinite" calcMode="linear"><mpath href="#${pid}"/></animateMotion></circle>`
        }
      }
    })
    setHtml(svg, html)
    if (reduce || frozen) {
      svg?.pauseAnimations()
    }
    // failure bubbles
    if (viz !== undefined) {
      for (const b of findAll(viz, ".bubble")) {
        if (
          !stories.some(
            (s) => s.status === "failed" && s.failMessage !== undefined && b.dataset["id"] === s.id
          )
        ) {
          b.remove()
        }
      }
      stories.forEach((story, i) => {
        if (story.status !== "failed" || story.failMessage === undefined) {
          return
        }
        const known = find(viz, `.bubble[data-id="${CSS.escape(story.id)}"]`)
        if (known !== undefined) {
          known.style.top = `${sy(i) + 12}px`
          return
        }
        const b = document.createElement("div")
        b.className = `bubble${animate && !reduce ? " bubble-in" : ""}`
        b.dataset["id"] = story.id
        b.style.left = `${X.story + NW + 14}px`
        b.style.top = `${sy(i) + 12}px`
        b.textContent = story.failMessage
        viz.append(b)
      })
    }
    // header
    setHtml(
      find(root, "[data-bind-title]"),
      parts.name !== ""
        ? `<span class="muted">${esc(parts.kind)}</span> ${esc(parts.name)}`
        : esc(parts.kind)
    )
    document.title = `${frame.title} · llm4ts watch`
    bind(root, "elapsed", mode === "live" ? elapsed(t0, now) : clock(t0, now))
    bind(
      root,
      "stories",
      `${frame.counts.done}/${frame.counts.total} done · ${frame.counts.running} running · ${frame.counts.failed} failed`
    )
    bind(root, "tokens", tok(frame.tokens))
    bind(root, "cost", dollars(frame.costUsd))
    bind(root, "stage", frame.stage)
    bind(root, "agents", frame.agents)
    // roster
    setHtml(
      find(root, "[data-roster]"),
      frame.roster.length > 0
        ? frame.roster
            .map(
              (x) =>
                `<div class="exec"><i class="dot-${x.state}"></i><div><div class="nm">${esc(x.name)}</div><div class="ln" title="${esc(x.text)}">${esc(x.text)}</div></div></div>`
            )
            .join("")
        : `<div class="exec"><div><div class="ln">no executors yet</div></div></div>`
    )
    renderDetail(root, frame, selected(), now, detail, tailTarget())
    renderJudge(root, frame)
    // the flow card's body: the graph, or the executors, or the boards
    for (const button of findAll(root, "[data-view]")) {
      button.setAttribute("aria-pressed", String(button.dataset["view"] === view))
    }
    if (viz !== undefined) {
      viz.hidden = view !== "flow"
    }
    if (executorsPane !== undefined) {
      executorsPane.hidden = view !== "executors"
      if (view === "executors") {
        setHtml(executorsPane, executorsHtml(frame.roster, selectedExecutor()))
      }
    }
    if (boardsPane !== undefined) {
      boardsPane.hidden = view !== "boards"
      if (view === "boards") {
        setHtml(boardsPane, boardsHtml(frame, selected(), now))
        placeAll(boardsPane)
      }
    }
  }

  const show = (next: PageView): void => {
    view = next
    redraw()
  }

  const showDetail = (next: DetailState): void => {
    detail = next
    redraw()
  }

  /** Lines into the tail, kept at the bottom unless the reader scrolled up. */
  const showTail: FrameView["tail"] = (answer) => {
    const pane = find(root, "[data-tail]")
    if (pane === undefined) {
      return
    }
    const atEnd = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 24
    const fresh = pane.dataset["html"] === undefined
    setHtml(
      pane,
      answer._tag === "Lines"
        ? answer.lines.length === 0
          ? `<span class="v-dim">nothing said yet</span>`
          : answer.lines.map((line) => esc(line)).join("\n")
        : `<span class="${answer._tag === "Failed" ? "v-err" : "v-dim"}">${esc(answer.message)}</span>`
    )
    if (atEnd || fresh) {
      pane.scrollTop = pane.scrollHeight
    }
  }

  const executors = (): { readonly names: ReadonlyArray<string>; readonly selected?: string } => {
    const names = current?.roster.map((executor) => executor.name) ?? []
    const chosen = selectedExecutor()
    return chosen === undefined ? { names } : { names, selected: chosen }
  }

  return {
    render,
    show,
    detail: showDetail,
    tail: showTail,
    tailTarget,
    shown: () => view,
    executors,
    pickExecutor
  }
}

const executorState: Readonly<Record<WebExecutor["state"], string>> = {
  busy: "◐ busy",
  idle: "○ idle",
  out: "✗ out"
}

/** One card per executor, as the terminal's executor boxes: name, leases, then idle, busy or out. */
const executorsHtml = (roster: ReadonlyArray<WebExecutor>, picked: string | undefined): string =>
  roster.length === 0
    ? `<div class="empty">no executors yet</div>`
    : `<div class="exec-grid">${roster
        .map(
          (
            x
          ) => `<button type="button" class="exec-card ${x.state}${x.name === picked ? " selected" : ""}" data-executor="${esc(x.name)}" aria-pressed="${x.name === picked}">
            <span class="exec-name"><i class="dot-${x.state}"></i>${esc(x.name)}</span>
            <span class="leases">${
              x.leases.length === 0
                ? `<span class="v-dim">no lease</span>`
                : x.leases.map((lease) => `<span>${esc(lease)}</span>`).join("")
            }</span>
            <span class="exec-state">${esc(
              x.state === "out" && x.reason !== undefined
                ? `${executorState.out}: ${x.reason}`
                : executorState[x.state]
            )}</span>
          </button>`
        )
        .join("")}</div>`

const columnHtml = (title: string, count: number, cards: ReadonlyArray<string>): string =>
  `<div class="column"><div class="col-head">${esc(title)} <span class="faint">(${count})</span></div>${
    cards.length === 0 ? `<div class="col-empty">—</div>` : cards.join("")
  }</div>`

/** A running story's card carries its clone and its plan's progress, as the terminal's does. */
const storyCardHtml = (story: WebStory, selected: boolean): string => {
  const { done, total } = progressOf(story)
  const running =
    story.status === "running"
      ? `<span class="card-sub">${esc(story.clone ?? "(leasing)")}${total > 0 ? ` · ${done}/${total}` : ""}</span>${
          total > 0 ? `<span class="bar"><i data-pct="${(100 * done) / total}"></i></span>` : ""
        }`
      : ""
  return `<button type="button" class="story-card ${nodeState(story.status)}${selected ? " selected" : ""}" data-story="${esc(story.id)}"><span class="card-id">${esc(story.id)}</span>${running}</button>`
}

/** The epic board, then the selected story's task board under it (ADR 0033, decision 4). */
const boardsHtml = (frame: WebFrame, id: string | undefined, now: number): string => {
  const epic = epicColumns
    .map((status) => {
      const members = frame.stories.filter((story) => story.status === status)
      return columnHtml(
        status,
        members.length,
        members.map((story) => storyCardHtml(story, story.id === id))
      )
    })
    .join("")
  const story = frame.stories.find((candidate) => candidate.id === id)
  const board =
    story === undefined
      ? ""
      : `<div class="board-title"><span class="eyebrow">story board</span><span class="mono">${esc(
          [
            story.id,
            story.clone ?? story.status,
            ...(story.startedAt === undefined
              ? []
              : [elapsed(story.startedAt, story.endedAt ?? now)])
          ].join(" · ")
        )}</span></div><div class="columns four">${storyColumns
          .map((column) => {
            const tasks = tasksIn(story, column)
            return columnHtml(
              column,
              tasks.length,
              tasks.map(
                (task) =>
                  `<div class="task-card"><span class="faint">${task.index}</span> ${esc(task.title)}</div>`
              )
            )
          })
          .join("")}</div>`
  return `<div class="board-title"><span class="eyebrow">epic board</span><span class="mono faint">${frame.counts.total} stories</span></div><div class="columns five">${epic}</div>${board}`
}

/** A card button with its key, pressed while what it opens is open. */
const cardKey = (act: string, key: string, label: string, pressed: boolean): string =>
  `<button type="button" class="key" data-card-act="${act}" aria-pressed="${pressed}"><kbd>${key}</kbd>${label}</button>`

const detailKeysHtml = (detail: DetailState): string =>
  `${cardKey("tail", "t", "tail", detail.body._tag === "Tail")}${cardKey("expand", "enter", "expand", detail.body._tag === "Expanded")}`

/**
 * The tail in the detail card: its head names the target and role only, so
 * the card is rebuilt when they change and not on every frame, and the
 * lines' pane keeps its scroll while the transcript grows.
 */
const tailCardHtml = (
  tail: ReturnType<typeof tailTargetOf>,
  detail: DetailState,
  role: string
): string =>
  `<div class="card-head"><div class="mini running"></div><div class="head-title"><div class="card-title">${esc(
    tail === undefined ? "tail" : tail.target
  )}</div><div class="card-desc">tail · ${esc(tail === undefined ? "" : `${tail.of} · `)}${esc(role)}</div></div>${cardKey(
    "role",
    "r",
    role,
    false
  )}${detailKeysHtml(detail)}</div>
      <div class="body tail-body">${
        tail === undefined
          ? `<div class="empty">click an executor to tail its transcript</div>`
          : `<pre class="tail" data-tail></pre>`
      }</div>`

const renderDetail = (
  root: HTMLElement,
  frame: WebFrame,
  id: string | undefined,
  now: number,
  detail: DetailState,
  tail: ReturnType<typeof tailTargetOf>
): void => {
  const card = find(root, "[data-detail]")
  if (detail.body._tag === "Tail") {
    setHtml(card, tailCardHtml(tail, detail, detail.body.role ?? "all"))
    return
  }
  const story = frame.stories.find((s) => s.id === id)
  if (story === undefined) {
    setHtml(
      card,
      `<div class="card-head"><div class="mini idle"></div><div class="head-title"><div class="card-title">no stories yet</div><div class="card-desc">waiting for the run's first lane</div></div></div><div class="body"><div class="empty">no stories in flight</div></div>`
    )
    return
  }
  const expanded = detail.body._tag === "Expanded"
  const state = nodeState(story.status)
  const rows: Array<string> = []
  const kv = (k: string, v: string, tone = ""): void => {
    rows.push(
      `<div class="kv"><span>${k}</span><span${tone === "" ? "" : ` class="${tone}"`}>${esc(v)}</span></div>`
    )
  }
  const list = (k: string, items: ReadonlyArray<string>): void => {
    rows.push(
      `<div class="kv"><span>${k}</span><ol class="detail-list">${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ol></div>`
    )
  }
  if (expanded && story.stages.length > 0) {
    list("stages", story.stages)
  } else if (story.stage !== undefined && story.stage !== "") {
    kv("stage", story.stage)
  }
  if (state === "running" && story.activity !== undefined) {
    kv("now", `${elapsed(story.activity.since, now)} · ${story.activity.text}`, "v-time")
  }
  if (expanded && story.tools.length > 0) {
    kv("tools", `last ${story.tools.length}`, "v-dim")
    list("", story.tools)
  } else if (story.tools.length > 0) {
    kv("tools", story.tools.slice(-3).join(" · "))
  }
  if (story.failMessage !== undefined && story.failMessage !== "") {
    kv(
      "error",
      `${story.failStage !== undefined && story.failStage !== "" ? `${story.failStage}: ` : ""}${story.failMessage}`,
      "v-err"
    )
  }
  if (story.note !== undefined && story.note !== "" && state !== "done") {
    kv("review", story.note, "v-int")
  }
  if (story.model !== undefined && story.model !== "") {
    kv("model", story.model)
  }
  if (story.startedAt !== undefined) {
    kv(
      "tokens",
      story.prompt > 0
        ? `${tok(story.tokens)}  (${story.prompt.toLocaleString("en-US")} prompt · ${story.completion.toLocaleString("en-US")} completion)`
        : tok(story.tokens)
    )
    kv("elapsed", elapsed(story.startedAt, story.endedAt ?? now), "v-time")
  } else {
    kv("status", story.status, "v-faint")
  }
  const plan =
    state === "running"
      ? story.tasks.length > 0
        ? `<div class="kv"><span>plan</span><span>${story.tasks.length} tasks</span></div>`
        : `<div class="kv"><span>plan</span><span class="v-dim">no task plan yet</span></div><div class="indeterminate"></div>`
      : ""
  const desc = [story.executor, story.executor !== undefined ? "coder" : undefined, story.stage]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ")
  setHtml(
    card,
    `
      <div class="card-head"><div class="mini ${state}"></div><div class="head-title"><div class="card-title">${esc(story.id)}</div><div class="card-desc">${esc(desc === "" ? story.status : desc)}</div></div>${detailKeysHtml(detail)}</div>
      <div class="body">${rows.join("")}${plan}</div>`
  )
}

const roundHtml = (v: WebVerdict, i: number): string => `
      <div class="round ${i === 0 ? "latest" : "older"}">
        <div class="round-head"><span class="eyebrow">JUDGMENT · ${esc(v.lane)} r${v.round}</span>
          <span class="verdict ${v.cleared ? "cleared" : "issues"}">${v.cleared ? "cleared → merge" : `${issues(v.issues)} → coder`}</span></div>
        ${v.dimensions.map((d) => `<div class="score ${d.score < d.max ? "part" : ""}"><span>${esc(d.id)}</span><span class="bar"><i data-pct="${d.max > 0 ? (100 * d.score) / d.max : 0}"></i></span><span class="v">${d.score}/${d.max}</span></div>`).join("")}
      </div>`

const renderJudge = (root: HTMLElement, frame: WebFrame): void => {
  const judge = frame.judge
  const seat =
    judge.executor !== undefined
      ? `${esc(judge.executor)} · on call`
      : `<span class="placeholder">[judge seat not leased yet]</span>`
  const rounds = [...frame.verdicts].reverse()
  const latest = frame.verdicts.at(-1)
  const card = find(root, "[data-judge]")
  setHtml(
    card,
    `
      <div class="card-head"><div class="mini judge${judge.executor !== undefined ? "" : " unleased"}"></div><div class="head-title"><div class="card-title">JUDGE SEAT</div><div class="card-desc">${seat}</div></div>
        <div class="seat-stats"><span class="stat"><b>reviews</b>${judge.reviews}</span><span class="stat"><b>verdicts</b>${judge.verdicts}</span></div></div>
      <div class="body">
        ${latest !== undefined ? `<div class="kv"><span>verdict</span><span class="v-judge">» ${esc(latest.lane)} r${latest.round}: ${latest.cleared ? "cleared" : issues(latest.issues)}</span></div>` : ""}
        ${rounds.length > 0 ? rounds.map(roundHtml).join("") : `<div class="empty">no judgment yet</div>`}
      </div>`
  )
  if (card !== undefined) {
    placeAll(card)
  }
}

export const itemHtml = (item: WebTimelineItem, t0: number, classes: string): string =>
  `<li class="${classes}"><i class="tone-${item.tone}"></i><div><div class="meta"><span class="tm">${clock(t0, item.at)}</span><span class="src">${esc(item.who)}</span><span class="src">seq ${item.seq}</span></div><div class="txt">${esc(item.what)}</div></div></li>`
