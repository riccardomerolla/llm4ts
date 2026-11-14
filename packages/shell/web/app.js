/* llm4ts watch --web (ADR 0051), ported from the approved v2 design.
   The server folds the trace with the agent tree's own reducer and sends frames
   (packages/shell/src/WebWatchView.ts); this page only lays them out.
   ?freeze   one frame, no stream, loops paused
   ?seq=N    (replay) open at the last step at or before trace seq N
   ?speed=N  (replay) start at this speed */
;(() => {
  const params = new URLSearchParams(location.search)
  const frozen = params.has("freeze")
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches
  if (frozen) document.body.classList.add("frozen")

  // ── formatting (AgentTree.ts elapsed / clock / tokens) ──
  const elapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
  }
  const clock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000))
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((p) => String(p).padStart(2, "0"))
      .join(":")
  }
  const tok = (n) => (n === 0 ? "0" : `${(n / 1000).toFixed(1)}k`)
  const dollars = (usd) => `~$${usd.toFixed(2)}`
  const issues = (n) => `${n} issue${n === 1 ? "" : "s"}`
  const esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
    )
  const tone = {
    orchestrator: "var(--t-orch)",
    judgment: "var(--t-judgment)",
    judge: "var(--t-judge)",
    running: "var(--run)",
    log: "var(--t-log)",
    tool: "var(--node-time)",
    done: "var(--ok-fg)",
    failed: "var(--err)",
    issue: "var(--int)"
  }

  /** "epic conto-bonifico" → the orchestrator's name and what it is about. */
  const titleParts = (frame) => {
    const match = /^(epic)\s+(.+)$/u.exec(frame.title)
    return match
      ? { kind: match[1], name: match[2], branch: `epic/${match[2]}` }
      : { kind: frame.title, name: frame.action ?? "", branch: "merge" }
  }

  // ── graph geometry ──
  const X = { orch: 40, story: 330, judge: 720, jmt: 960, merge: 1180 }
  const NW = 198
  const ROW = 84
  const geometry = (count) => {
    const height = Math.max(560, 32 + count * ROW + 24)
    return { height, oy: Math.round(height / 2) - 28, top: 32 }
  }
  const curve = (x0, y0, x1, y1) => {
    const m = (x0 + x1) / 2
    return `M${x0} ${y0} C${m} ${y0} ${m} ${y1} ${x1} ${y1}`
  }
  const ICON = {
    star: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 1.5c.7 5.6 3.4 8.5 10.5 10.5-7.1 2-9.8 4.9-10.5 10.5C11.3 16.9 8.6 14 1.5 12 8.6 10 11.3 7.1 12 1.5z"/></svg>',
    fail: '<svg class="icon" viewBox="0 0 24 24"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8zm2.1 5L7 10.1 8.9 12 7 13.9 10.1 17 12 15.1 13.9 17 17 13.9 15.1 12 17 10.1 13.9 7 12 8.9z"/></svg>'
  }
  const nodeView = (state, result) =>
    state === "done" || state === "issues"
      ? `<span class="content">${esc(result)}</span>`
      : state === "failed"
        ? `<span class="content">${ICON.fail}</span>`
        : state === "running"
          ? ""
          : `<span class="content">${ICON.star}</span>`
  /** Sets markup only when it changed, so a redraw does not restart its animations. */
  const setHtml = (el, html) => {
    if (el.dataset.html === html) return
    el.dataset.html = html
    el.innerHTML = html
  }
  const nodeState = (status) => (status === "planned" ? "idle" : status)

  function makeView(root, mode) {
    const viz = root.querySelector("[data-graph]")
    const nodes = {}
    const last = {}
    let picked
    let shape = ""
    let svg
    const layout = (count) => {
      const key = String(count)
      if (key === shape) return
      shape = key
      const { height } = geometry(count)
      viz.style.height = `${height}px`
      viz.innerHTML = `<svg class="edges" width="1390" height="${height}" viewBox="0 0 1390 ${height}"></svg>`
      svg = viz.querySelector("svg")
      Object.keys(nodes).forEach((id) => delete nodes[id])
      Object.keys(last).forEach((id) => delete last[id])
      ;[
        ["orchestrator", X.orch],
        [`stories · ${count}`, X.story],
        ["judge seat", X.judge],
        ["judgment", X.jmt],
        ["merge", X.merge]
      ].forEach(([text, x]) => {
        const caption = document.createElement("span")
        caption.className = "caption"
        caption.style.left = `${x}px`
        caption.textContent = text
        viz.append(caption)
      })
    }
    const ensure = (id, x, y, story) => {
      const known = nodes[id]
      if (known) {
        known.style.top = `${y}px`
        return known
      }
      const el = document.createElement("div")
      el.className = story ? "node story" : "node"
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.dataset.id = id
      el.innerHTML = `<div class="box"><div class="shine"></div><div class="slot"></div></div><div class="label"><span class="n"></span><span class="s"></span><span class="t"></span></div>`
      if (story)
        el.addEventListener("click", () => {
          picked = id
          if (api.frame) api.render(api.frame, false)
        })
      viz.append(el)
      return (nodes[id] = el)
    }
    const setNode = (id, x, y, state, name, sub, time, result, animate, story = false) => {
      const el = ensure(id, x, y, story)
      const prev = last[id]
      const key = `${state}|${result}`
      el.dataset.state = state
      el.querySelector(".n").textContent = name
      el.querySelector(".s").textContent = sub
      el.querySelector(".t").textContent = time
      el.classList.toggle("selected", story && id === api.selected)
      if (prev !== key) {
        const slot = el.querySelector(".slot")
        slot.innerHTML = nodeView(state, result)
        if (animate && !reduce && prev !== undefined) {
          const box = el.querySelector(".box")
          if (state === "done" || state === "issues") slot.firstChild?.classList.add("pop")
          if (state === "failed") {
            box.classList.remove("shake")
            void box.offsetWidth
            box.classList.add("shake")
          }
          if (id === "merge" && state === "done") {
            box.classList.remove("flash")
            void box.offsetWidth
            box.classList.add("flash")
          }
        }
      }
      last[id] = key
    }
    const api = {
      frame: undefined,
      get selected() {
        const ids = api.frame?.stories.map((story) => story.id) ?? []
        return ids.includes(picked) ? picked : api.frame?.focus
      },
      render(frame, animate) {
        api.frame = frame
        const now = frame.now ?? 0
        const t0 = frame.startedAt ?? now
        const stories = frame.stories
        layout(stories.length)
        const { oy, top } = geometry(stories.length)
        const sy = (i) => top + i * ROW
        const parts = titleParts(frame)
        // nodes
        const allDone = stories.length > 0 && stories.every((story) => story.status === "done")
        const orchState =
          frame.ended === "failed" ? "failed" : allDone || frame.ended ? "done" : "running"
        setNode(
          "orch",
          X.orch,
          oy,
          orchState,
          parts.kind,
          parts.name,
          elapsed(now - t0),
          "done",
          animate
        )
        stories.forEach((story, i) => {
          const state = nodeState(story.status)
          const sub = story.executor ?? story.status
          const time =
            state === "running"
              ? `${elapsed(now - story.startedAt)} · ${tok(story.tokens)} tok`
              : state === "done" && story.startedAt !== undefined
                ? `${elapsed((story.endedAt ?? now) - story.startedAt)} · ${tok(story.tokens)} tok`
                : state === "failed"
                  ? (story.failStage ?? "")
                  : ""
          setNode(
            story.id,
            X.story,
            sy(i),
            state,
            story.id,
            sub,
            time,
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
          "judge seat",
          judge.executor ? `${judge.executor} · on call` : "[not leased yet]",
          `reviews ${judge.reviews} · verdicts ${judge.verdicts}`,
          "",
          animate
        )
        const verdict = frame.verdicts.at(-1)
        setNode(
          "jmt",
          X.jmt,
          oy,
          verdict ? (verdict.cleared ? "done" : "issues") : "idle",
          "judgment",
          verdict ? `${verdict.lane} r${verdict.round}` : "[none yet]",
          verdict
            ? verdict.cleared
              ? "cleared → merge"
              : `${issues(verdict.issues)} → coder`
            : "",
          verdict ? (verdict.cleared ? "cleared" : issues(verdict.issues)) : "",
          animate
        )
        setNode(
          "merge",
          X.merge,
          oy,
          frame.merged > 0 ? "done" : "idle",
          "merge",
          parts.branch,
          `${frame.counts.done}/${frame.counts.total} done`,
          `${frame.merged}/${frame.counts.total}`,
          animate
        )
        // edges + token flow
        const oc = [X.orch + NW - 10, oy + 28]
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
        html += `<path class="edge ${verdict ? "done" : "idle"}" d="M${X.judge + NW - 20} ${oy + 28} L${X.jmt - 8} ${oy + 28}"/>`
        html += `<path class="edge ${frame.merged ? "done" : "idle"}" d="M${X.jmt + NW - 20} ${oy + 28} L${X.merge - 8} ${oy + 28}"/>`
        // token pulses: two dots per running edge, 1.2s a pass
        stories.forEach((story, i) => {
          if (story.status !== "running") return
          ;[`${mode}-e-o-${i}`, `${mode}-e-j-${i}`].forEach((pid) => {
            ;[0, 0.6].forEach((d) => {
              html += `<circle class="token" r="3"><animateMotion dur="1.2s" begin="-${d}s" repeatCount="indefinite" calcMode="linear"><mpath href="#${pid}"/></animateMotion></circle>`
            })
          })
        })
        setHtml(svg, html)
        if (reduce || frozen) svg.pauseAnimations?.()
        // failure bubbles
        viz.querySelectorAll(".bubble").forEach((b) => {
          if (!stories.some((s) => s.status === "failed" && s.failMessage && b.dataset.id === s.id))
            b.remove()
        })
        stories.forEach((story, i) => {
          if (story.status !== "failed" || !story.failMessage) return
          const known = viz.querySelector(`.bubble[data-id="${CSS.escape(story.id)}"]`)
          if (known) {
            known.style.top = `${sy(i) + 12}px`
            return
          }
          const b = document.createElement("div")
          b.className = `bubble${animate && !reduce ? " bubble-in" : ""}`
          b.dataset.id = story.id
          b.style.left = `${X.story + NW + 14}px`
          b.style.top = `${sy(i) + 12}px`
          b.textContent = story.failMessage
          viz.append(b)
        })
        // header
        const bind = (k, v) =>
          root.querySelectorAll(`[data-bind="${k}"]`).forEach((n) => (n.textContent = v))
        setHtml(
          root.querySelector("[data-bind-title]"),
          parts.name
            ? `<span class="muted">${esc(parts.kind)}</span> ${esc(parts.name)}`
            : esc(parts.kind)
        )
        document.title = `${frame.title} · llm4ts watch`
        bind("elapsed", mode === "live" ? elapsed(now - t0) : clock(now - t0))
        bind(
          "stories",
          `${frame.counts.done}/${frame.counts.total} done · ${frame.counts.running} running · ${frame.counts.failed} failed`
        )
        bind("tokens", tok(frame.tokens))
        bind("cost", dollars(frame.costUsd))
        bind("stage", frame.stage)
        bind("agents", frame.agents)
        // roster
        setHtml(
          root.querySelector("[data-roster]"),
          frame.roster.length
            ? frame.roster
                .map((x) => {
                  const dot =
                    x.state === "out"
                      ? "var(--err)"
                      : x.state === "busy"
                        ? "var(--run)"
                        : "var(--idle)"
                  return `<div class="exec"><i style="background:${dot}"></i><div><div class="nm">${esc(x.name)}</div><div class="ln" title="${esc(x.text)}">${esc(x.text)}</div></div></div>`
                })
                .join("")
            : `<div class="exec"><div><div class="ln">no executors yet</div></div></div>`
        )
        renderDetail(root, frame, api.selected, now)
        renderJudge(root, frame)
      }
    }
    return api
  }

  function renderDetail(root, frame, id, now) {
    const story = frame.stories.find((s) => s.id === id)
    const card = root.querySelector("[data-detail]")
    if (!story) {
      setHtml(
        card,
        `<div class="card-head"><div class="mini idle"></div><div class="head-title"><div class="card-title">no stories yet</div><div class="card-desc">waiting for the run's first lane</div></div></div><div class="body"><div class="empty">no stories in flight</div></div>`
      )
      return
    }
    const state = nodeState(story.status)
    const rows = []
    const kv = (k, v, style = "") =>
      rows.push(`<div class="kv"><span>${k}</span><span style="${style}">${esc(v)}</span></div>`)
    if (story.stage) kv("stage", story.stage)
    if (state === "running" && story.activity)
      kv(
        "now",
        `${elapsed(now - story.activity.since)} · ${story.activity.text}`,
        "color:var(--node-time)"
      )
    if (story.tools.length) kv("tools", story.tools.join(" · "))
    if (story.failMessage)
      kv(
        "error",
        `${story.failStage ? `${story.failStage}: ` : ""}${story.failMessage}`,
        "color:var(--err)"
      )
    if (story.note && state !== "done") kv("review", story.note, "color:var(--int)")
    if (story.model) kv("model", story.model)
    if (story.startedAt !== undefined)
      kv(
        "tokens",
        story.prompt
          ? `${tok(story.tokens)}  (${story.prompt.toLocaleString("en-US")} prompt · ${story.completion.toLocaleString("en-US")} completion)`
          : tok(story.tokens)
      )
    if (story.startedAt !== undefined)
      kv("elapsed", elapsed((story.endedAt ?? now) - story.startedAt), "color:var(--node-time)")
    if (story.startedAt === undefined) kv("status", story.status, "color:var(--faint)")
    const plan =
      state === "running"
        ? story.tasks > 0
          ? `<div class="kv"><span>plan</span><span>${story.tasks} tasks</span></div>`
          : `<div class="kv"><span>plan</span><span style="color:var(--t-dim)">no task plan yet</span></div><div class="indeterminate"></div>`
        : ""
    const desc = [story.executor, story.executor ? "coder" : undefined, story.stage]
      .filter(Boolean)
      .join(" · ")
    setHtml(
      card,
      `
      <div class="card-head"><div class="mini ${state}"></div><div class="head-title"><div class="card-title">${esc(story.id)}</div><div class="card-desc">${esc(desc || story.status)}</div></div><span class="key"><kbd>t</kbd>tail</span><span class="key"><kbd>enter</kbd>expand</span></div>
      <div class="body">${rows.join("")}${plan}</div>`
    )
  }

  function renderJudge(root, frame) {
    const judge = frame.judge
    const seat = judge.executor
      ? `${esc(judge.executor)} · on call`
      : `<span class="placeholder">[judge seat not leased yet]</span>`
    const rounds = [...frame.verdicts].reverse()
    const roundHtml = (v, i) => `
      <div class="round ${i === 0 ? "latest" : "older"}">
        <div class="round-head"><span class="eyebrow" style="color:${i === 0 ? "var(--t-judgment)" : "var(--muted)"}">JUDGMENT · ${esc(v.lane)} r${v.round}</span>
          <span class="verdict ${v.cleared ? "cleared" : "issues"}">${v.cleared ? "cleared → merge" : `${issues(v.issues)} → coder`}</span></div>
        ${v.dimensions.map((d) => `<div class="score ${d.score < d.max ? "part" : ""}"><span>${esc(d.id)}</span><span class="bar"><i style="width:${d.max ? (100 * d.score) / d.max : 0}%"></i></span><span class="v">${d.score}/${d.max}</span></div>`).join("")}
      </div>`
    const latest = frame.verdicts.at(-1)
    setHtml(
      root.querySelector("[data-judge]"),
      `
      <div class="card-head"><div class="mini judge" style="opacity:${judge.executor ? 1 : 0.5}"></div><div class="head-title"><div class="card-title">JUDGE SEAT</div><div class="card-desc">${seat}</div></div>
        <div class="seat-stats"><span class="stat"><b>reviews</b>${judge.reviews}</span><span class="stat"><b>verdicts</b>${judge.verdicts}</span></div></div>
      <div class="body">
        ${latest ? `<div class="kv"><span>verdict</span><span style="color:var(--t-judge)">» ${esc(latest.lane)} r${latest.round}: ${latest.cleared ? "cleared" : issues(latest.issues)}</span></div>` : ""}
        ${rounds.length ? rounds.map(roundHtml).join("") : `<div class="empty">no judgment yet</div>`}
      </div>`
    )
  }

  const itemHtml = (item, t0, classes) =>
    `<li class="${classes}"><i style="background:${tone[item.tone] ?? "var(--t-log)"}"></i><div><div class="meta"><span class="tm">${clock(item.at - t0)}</span><span class="src">${esc(item.who)}</span><span class="src">seq ${item.seq}</span></div><div class="txt">${esc(item.what)}</div></div></li>`

  const boot = document.querySelector("[data-boot]")
  const failed = (message) => {
    boot.hidden = false
    boot.classList.add("error")
    boot.textContent = message
  }
  const show = (mode) => {
    boot.hidden = true
    document
      .querySelectorAll(".screen")
      .forEach((s) => s.classList.toggle("on", s.dataset.screen === mode))
  }
  const getJson = (path) =>
    fetch(path).then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))

  // ── LIVE: a frame every poll (Watch.ts pollInterval, 500ms), the clock moving between events ──
  function startLive(run) {
    const root = document.getElementById("screen-live")
    const view = makeView(root, "live")
    let seen = -1
    const draw = (frame) => {
      const fresh = frame.count !== seen && seen >= 0
      seen = frame.count
      view.render(frame, fresh)
      root.querySelectorAll('[data-bind="runId"]').forEach((n) => (n.textContent = run.runId ?? ""))
      const pill = root.querySelector("[data-live-pill]")
      pill.classList.toggle("paused", frame.ended !== undefined)
      root.querySelector('[data-bind="runState"]').textContent = frame.ended ?? "live"
      const shown = frame.timeline.slice(-12)
      const t0 = frame.startedAt ?? 0
      setHtml(
        root.querySelector("[data-timeline]"),
        shown
          .map((item, i) =>
            itemHtml(
              item,
              t0,
              `${i === shown.length - 1 ? "current" : ""} ${fresh && i === shown.length - 1 && !reduce ? "fresh" : ""}`
            )
          )
          .join("")
      )
      root.querySelector('[data-bind="timelineDesc"]').textContent =
        `last ${shown.length} of ${frame.timelineCount} · trace seq ${run.steps[0]?.seq ?? 0}–${frame.lastSeq ?? 0}`
    }
    show("live")
    if (frozen) {
      getJson("/api/frame").then(draw, (e) => failed(e.message))
      return
    }
    const source = new EventSource("/api/stream")
    source.addEventListener("frame", (e) => draw(JSON.parse(e.data)))
    source.addEventListener("end", () => source.close())
  }

  // ── REPLAY: steps on the trace's own timestamps, min(Δt, 2s) ÷ speed (Watch.ts replayGap) ──
  function startReplay(run) {
    const root = document.getElementById("screen-replay")
    const view = makeView(root, "replay")
    const steps = run.steps
    const items = run.timeline
    const t0 = steps[0]?.at ?? 0
    const total = Math.max(1, (steps.at(-1)?.at ?? t0) - t0)
    const pct = (at) => (100 * (at - t0)) / total
    const countAt = (seq) => {
      let k = 1
      steps.forEach((s, i) => {
        if (s.seq <= seq) k = i + 1
      })
      return k
    }
    let count = params.has("seq") ? countAt(Number(params.get("seq"))) : 1
    let speed = Number(params.get("speed") ?? run.speed) || run.speed
    let source
    const track = root.querySelector("[data-track]")
    const playing = () => source !== undefined
    root.querySelector("[data-markers]").innerHTML = items
      .map(
        (i) =>
          `<i data-seq="${i.seq}" style="left:${pct(i.at)}%;background:${tone[i.tone] ?? "var(--t-log)"}" title="${esc(`${clock(i.at - t0)} ${i.who} ${i.what}`)}"></i>`
      )
      .join("")
    root.querySelectorAll('[data-bind="total"]').forEach((n) => (n.textContent = clock(total)))
    root.querySelector('[data-bind="mid"]').textContent = clock(total / 2)
    root.querySelector('[data-bind="lastSeq"]').textContent = run.lastSeq ?? 0
    root.querySelector('[data-bind="trace"]').textContent = run.trace
    root.querySelectorAll('[data-bind="runId"]').forEach((n) => (n.textContent = run.runId ?? ""))

    const chrome = () => {
      root.querySelector('[data-bind="replayLabel"]').textContent =
        `${playing() ? "replay" : "paused"} ×${speed}`
      root.querySelector(".status-pill").classList.toggle("paused", !playing())
      root.querySelector('[data-act="play"]').textContent = playing() ? "❚❚ pause" : "▶ play"
      root.querySelector('[data-act="back"]').disabled = count <= 1
      root.querySelector('[data-act="fwd"]').disabled = count >= steps.length
      root
        .querySelectorAll("[data-speed] button")
        .forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === speed)))
      track.classList.toggle("playing", playing())
    }
    const draw = (frame, animate) => {
      count = frame.count
      const step = steps[count - 1] ?? steps[0]
      view.render(frame, animate)
      const seq = step?.seq ?? 0
      // timeline: the window around the playhead, later events dimmed
      const idx = items.findIndex((i) => i.seq > seq)
      const cur = idx < 0 ? items.length : idx
      const from = Math.max(0, cur - 7)
      const shown = items.slice(from, from + 12)
      const current = [...items].reverse().find((i) => i.seq <= seq)
      setHtml(
        root.querySelector("[data-timeline]"),
        shown
          .map((i) => {
            const isCurrent = current !== undefined && i === current
            return itemHtml(
              i,
              t0,
              `${i.seq > seq ? "future" : ""} ${isCurrent ? "current" : ""} ${animate && isCurrent && !reduce ? "fresh" : ""}`
            )
          })
          .join("")
      )
      root.querySelector('[data-bind="timelineDesc"]').textContent =
        `at seq ${seq} · later events dimmed`
      root.querySelector('[data-bind="clock"]').textContent = clock((step?.at ?? t0) - t0)
      root.querySelector('[data-bind="seq"]').textContent = seq
      const p = pct(step?.at ?? t0)
      const played = root.querySelector("[data-played]")
      const head = root.querySelector("[data-playhead]")
      played.style.transitionDuration = head.style.transitionDuration = `${frame.gapMs}ms`
      played.style.width = `${p}%`
      head.style.left = `${p}%`
      root.querySelector("[data-tip]").textContent =
        `${clock((step?.at ?? t0) - t0)}${current ? ` · ${current.who} ${current.what}` : ""}`.slice(
          0,
          96
        )
      root
        .querySelectorAll("[data-markers] i")
        .forEach((m) => m.classList.toggle("future", Number(m.dataset.seq) > seq))
      chrome()
    }
    const pause = () => {
      source?.close()
      source = undefined
      chrome()
    }
    const play = () => {
      pause()
      if (count >= steps.length) count = 1
      source = new EventSource(`/api/stream?count=${count}&speed=${speed}`)
      const mine = source
      let first = true
      mine.addEventListener("frame", (e) => {
        if (source !== mine) return
        draw(JSON.parse(e.data), !first)
        first = false
      })
      const stop = () => {
        if (source === mine) pause()
        mine.close()
      }
      mine.addEventListener("end", stop)
      mine.addEventListener("error", stop)
      chrome()
    }
    const seek = (k, animate) => {
      pause()
      count = Math.min(steps.length, Math.max(1, k))
      return getJson(`/api/frame?count=${count}`).then(
        (frame) => draw(frame, animate),
        (e) => failed(e.message)
      )
    }
    root.querySelector('[data-act="play"]').onclick = () => (playing() ? pause() : play())
    root.querySelector('[data-act="back"]').onclick = () => seek(count - 1, true)
    root.querySelector('[data-act="fwd"]').onclick = () => seek(count + 1, true)
    root.querySelectorAll("[data-speed] button").forEach(
      (b) =>
        (b.onclick = () => {
          speed = Number(b.dataset.speed)
          if (playing()) play()
          else chrome()
        })
    )
    track.addEventListener("click", (ev) => {
      const r = track.getBoundingClientRect()
      const at = t0 + ((ev.clientX - r.left) / r.width) * total
      let k = 1
      steps.forEach((s, i) => {
        if (s.at <= at) k = i + 1
      })
      seek(k, true)
    })
    addEventListener("keydown", (ev) => {
      if (ev.key === " ") {
        ev.preventDefault()
        root.querySelector('[data-act="play"]').click()
      }
      if (ev.key === "ArrowRight") root.querySelector('[data-act="fwd"]').click()
      if (ev.key === "ArrowLeft") root.querySelector('[data-act="back"]').click()
    })
    show("replay")
    seek(count, false).then(() => {
      // Like `watch --replay`: it plays from the start unless asked to open at a seq.
      if (!frozen && !params.has("seq")) play()
    })
  }

  getJson("/api/run").then(
    (run) => (run.mode === "replay" ? startReplay(run) : startLive(run)),
    (e) => failed(`llm4ts watch --web: ${e.message}`)
  )
})()
