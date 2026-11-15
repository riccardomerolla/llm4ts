import { clock, dollars, elapsed, formatCount } from "@llm4ts/runner/Format"
import type { WebFrame, WebStory, WebTimelineItem, WebVerdict } from "../src/WebFrame.ts"

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
}

export interface ViewOptions {
  readonly mode: "live" | "replay"
  readonly reduce: boolean
  readonly frozen: boolean
}

export const makeView = (root: HTMLElement, options: ViewOptions): FrameView => {
  const { mode, reduce, frozen } = options
  const viz = find(root, "[data-graph]")
  const nodes = new Map<string, HTMLElement>()
  const last = new Map<string, string>()
  let picked: string | undefined
  let shape = ""
  let svg: SVGSVGElement | undefined
  let current: WebFrame | undefined

  const selected = (): string | undefined => {
    const ids = current?.stories.map((story) => story.id) ?? []
    return picked !== undefined && ids.includes(picked) ? picked : current?.focus
  }

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
      el.addEventListener("click", () => {
        picked = id
        if (current !== undefined) {
          render(current, false)
        }
      })
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
    renderDetail(root, frame, selected(), now)
    renderJudge(root, frame)
  }

  return { render }
}

const renderDetail = (
  root: HTMLElement,
  frame: WebFrame,
  id: string | undefined,
  now: number
): void => {
  const story = frame.stories.find((s) => s.id === id)
  const card = find(root, "[data-detail]")
  if (story === undefined) {
    setHtml(
      card,
      `<div class="card-head"><div class="mini idle"></div><div class="head-title"><div class="card-title">no stories yet</div><div class="card-desc">waiting for the run's first lane</div></div></div><div class="body"><div class="empty">no stories in flight</div></div>`
    )
    return
  }
  const state = nodeState(story.status)
  const rows: Array<string> = []
  const kv = (k: string, v: string, tone = ""): void => {
    rows.push(
      `<div class="kv"><span>${k}</span><span${tone === "" ? "" : ` class="${tone}"`}>${esc(v)}</span></div>`
    )
  }
  if (story.stage !== undefined && story.stage !== "") {
    kv("stage", story.stage)
  }
  if (state === "running" && story.activity !== undefined) {
    kv("now", `${elapsed(story.activity.since, now)} · ${story.activity.text}`, "v-time")
  }
  if (story.tools.length > 0) {
    kv("tools", story.tools.join(" · "))
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
      ? story.tasks > 0
        ? `<div class="kv"><span>plan</span><span>${story.tasks} tasks</span></div>`
        : `<div class="kv"><span>plan</span><span class="v-dim">no task plan yet</span></div><div class="indeterminate"></div>`
      : ""
  const desc = [story.executor, story.executor !== undefined ? "coder" : undefined, story.stage]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ")
  setHtml(
    card,
    `
      <div class="card-head"><div class="mini ${state}"></div><div class="head-title"><div class="card-title">${esc(story.id)}</div><div class="card-desc">${esc(desc === "" ? story.status : desc)}</div></div><span class="key"><kbd>t</kbd>tail</span><span class="key"><kbd>enter</kbd>expand</span></div>
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
