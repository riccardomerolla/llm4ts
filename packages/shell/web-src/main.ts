/* `llm4ts watch --web` (ADR 0051): the page. The server folds the trace with
   the agent tree's own reducer and sends frames; this page decodes them
   through the shared schema and lays them out.
   ?freeze   one frame, no stream, loops paused
   ?seq=N    (replay) open at the last step at or before trace seq N
   ?speed=N  (replay) start at this speed
   ?view=executors|boards  what the flow card shows; `e` and `b` toggle it */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { clock } from "@llm4ts/runner/Format"
import { WebRunJson, type WebFrame, type WebRun } from "../src/WebFrame.ts"
import { decodeFrame, PageError, sseFrames, type FrameSource } from "./frames.ts"
import { countAtSeq, countAtTime, makeReplayController, type ReplayState } from "./replay.ts"
import {
  bind,
  esc,
  find,
  findAll,
  itemHtml,
  makeView,
  reduceMotion,
  setHtml,
  type FrameView
} from "./view.ts"
import { searchWithView, viewNamed, viewOfSearch, viewOnKey, type PageView } from "./views.ts"

const params = new URLSearchParams(location.search)
const frozen = params.has("freeze")
const reduce = reduceMotion()
if (frozen) {
  document.body.classList.add("frozen")
}

// ── the browser's frame source: fetch and EventSource, every body through the schema ──

const requestFailed = (path: string) => (cause: unknown) =>
  new PageError({ message: `${path}: ${cause instanceof Error ? cause.message : String(cause)}` })

const fetchText = (path: string): Effect.Effect<string, PageError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(path, { signal }),
      catch: requestFailed(path)
    })
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: requestFailed(path)
    })
    return response.ok ? body : yield* new PageError({ message: body })
  })

const decodeRun = Schema.decodeUnknownEffect(WebRunJson)

const browserSource: FrameSource = {
  run: Effect.flatMap(fetchText("/api/run"), (body) =>
    Effect.mapError(
      decodeRun(body),
      (error) => new PageError({ message: `the run did not decode: ${error.message}` })
    )
  ),
  frame: (count) =>
    Effect.flatMap(
      fetchText(count === undefined ? "/api/frame" : `/api/frame?count=${count}`),
      (body) => Effect.fromResult(decodeFrame(body))
    ),
  stream: (replay) =>
    sseFrames(
      () =>
        new EventSource(
          replay === undefined
            ? "/api/stream"
            : `/api/stream?count=${replay.count}&speed=${replay.speed}`
        ),
      { endOnError: replay !== undefined }
    )
}

// ── the page ──

/** The view toggles and their keys; the choice lives in the URL so a reload keeps it. */
const wireViews = (root: HTMLElement, view: FrameView, initial: PageView): void => {
  let shown = initial
  const choose = (next: PageView): void => {
    shown = next
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${searchWithView(location.search, next)}${location.hash}`
    )
    view.show(next)
  }
  for (const button of findAll(root, "[data-view]")) {
    button.addEventListener("click", () => {
      const asked = viewNamed(button.dataset["view"])
      if (asked !== shown) {
        choose(asked)
      }
    })
  }
  addEventListener("keydown", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const next = viewOnKey(shown, {
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      target
    })
    if (next !== undefined) {
      event.preventDefault()
      choose(next)
    }
  })
}
const initialView = viewOfSearch(location.search)

const boot = find(document, "[data-boot]")
const failed = (message: string): void => {
  if (boot === undefined) {
    return
  }
  boot.hidden = false
  boot.classList.add("error")
  boot.textContent = message
}
const show = (mode: WebRun["mode"]): void => {
  if (boot !== undefined) {
    boot.hidden = true
  }
  for (const screen of findAll(document, ".screen")) {
    screen.classList.toggle("on", screen.dataset["screen"] === mode)
  }
}
const reported = <A>(effect: Effect.Effect<A, PageError>): Effect.Effect<void> =>
  Effect.matchEffect(effect, {
    onSuccess: () => Effect.void,
    onFailure: (error) => Effect.sync(() => failed(`llm4ts watch --web: ${error.message}`))
  })

// LIVE: the server sends a frame every poll (Watch.ts pollInterval, 500ms), the clock moved to now.
const startLive = (run: WebRun): Effect.Effect<void, PageError> => {
  const root = document.getElementById("screen-live")
  if (root === null) {
    return Effect.void
  }
  const view = makeView(root, { mode: "live", reduce, frozen, view: initialView })
  wireViews(root, view, initialView)
  let seen = -1
  const draw = (frame: WebFrame): void => {
    const fresh = frame.count !== seen && seen >= 0
    seen = frame.count
    view.render(frame, fresh)
    bind(root, "runId", run.runId ?? "")
    find(root, "[data-live-pill]")?.classList.toggle("paused", frame.ended !== undefined)
    bind(root, "runState", frame.ended ?? "live")
    const shown = frame.timeline.slice(-12)
    const t0 = frame.startedAt ?? 0
    setHtml(
      find(root, "[data-timeline]"),
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
    bind(
      root,
      "timelineDesc",
      `last ${shown.length} of ${frame.timelineCount} · trace seq ${run.steps[0]?.seq ?? 0}–${frame.lastSeq ?? 0}`
    )
  }
  show("live")
  return frozen
    ? Effect.map(browserSource.frame(), draw)
    : Stream.runForEach(browserSource.stream(undefined), (frame) => Effect.sync(() => draw(frame)))
}

// REPLAY: steps on the trace's own timestamps, min(Δt, 2s) ÷ speed (Watch.ts replayGap).
const startReplay = (run: WebRun) =>
  Effect.gen(function* () {
    const root = document.getElementById("screen-replay")
    if (root === null) {
      return
    }
    const view = makeView(root, { mode: "replay", reduce, frozen, view: initialView })
    wireViews(root, view, initialView)
    const steps = run.steps
    const items = run.timeline
    const t0 = steps[0]?.at ?? 0
    const total = Math.max(1, (steps.at(-1)?.at ?? t0) - t0)
    const pct = (at: number): number => (100 * (at - t0)) / total
    const seqParam = params.get("seq")
    const asked = Number(params.get("speed") ?? run.speed)
    const track = find(root, "[data-track]")
    const markers = find(root, "[data-markers]")
    if (markers !== undefined) {
      markers.innerHTML = items
        .map(
          (i) =>
            `<i class="tone-${i.tone}" data-seq="${i.seq}" title="${esc(`${clock(t0, i.at)} ${i.who} ${i.what}`)}"></i>`
        )
        .join("")
      findAll(markers, "i").forEach((marker, index) => {
        marker.style.left = `${pct(items[index]?.at ?? t0)}%`
      })
    }
    bind(root, "total", clock(0, total))
    bind(root, "mid", clock(0, total / 2))
    bind(root, "lastSeq", run.lastSeq ?? 0)
    bind(root, "trace", run.trace)
    bind(root, "runId", run.runId ?? "")
    const play = find(root, '[data-act="play"]')
    const back = find(root, '[data-act="back"]')
    const fwd = find(root, '[data-act="fwd"]')
    const speeds = findAll(root, "[data-speed] button")

    const chrome = (state: ReplayState): void => {
      bind(root, "replayLabel", `${state.playing ? "replay" : "paused"} ×${state.speed}`)
      find(root, ".status-pill")?.classList.toggle("paused", !state.playing)
      if (play !== undefined) {
        play.textContent = state.playing ? "❚❚ pause" : "▶ play"
      }
      if (back instanceof HTMLButtonElement) {
        back.disabled = state.count <= 1
      }
      if (fwd instanceof HTMLButtonElement) {
        fwd.disabled = state.count >= state.steps
      }
      for (const button of speeds) {
        button.setAttribute("aria-pressed", String(Number(button.dataset["speed"]) === state.speed))
      }
      track?.classList.toggle("playing", state.playing)
    }
    const draw = (frame: WebFrame, animate: boolean): void => {
      const step = steps[frame.count - 1] ?? steps[0]
      view.render(frame, animate)
      const seq = step?.seq ?? 0
      // timeline: the window around the playhead, later events dimmed
      const idx = items.findIndex((i) => i.seq > seq)
      const cur = idx < 0 ? items.length : idx
      const from = Math.max(0, cur - 7)
      const shown = items.slice(from, from + 12)
      const current = [...items].reverse().find((i) => i.seq <= seq)
      setHtml(
        find(root, "[data-timeline]"),
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
      bind(root, "timelineDesc", `at seq ${seq} · later events dimmed`)
      const at = step?.at ?? t0
      bind(root, "clock", clock(t0, at))
      bind(root, "seq", seq)
      const p = pct(at)
      const played = find(root, "[data-played]")
      const head = find(root, "[data-playhead]")
      if (played !== undefined && head !== undefined) {
        played.style.transitionDuration = `${frame.gapMs}ms`
        head.style.transitionDuration = `${frame.gapMs}ms`
        played.style.width = `${p}%`
        head.style.left = `${p}%`
      }
      const tip = find(root, "[data-tip]")
      if (tip !== undefined) {
        tip.textContent =
          `${clock(t0, at)}${current !== undefined ? ` · ${current.who} ${current.what}` : ""}`.slice(
            0,
            96
          )
      }
      for (const marker of findAll(root, "[data-markers] i")) {
        marker.classList.toggle("future", Number(marker.dataset["seq"]) > seq)
      }
    }

    const controller = yield* makeReplayController(
      browserSource,
      {
        steps: steps.length,
        count: seqParam === null ? 1 : countAtSeq(steps, Number(seqParam)),
        speed: Number.isFinite(asked) && asked > 0 ? asked : run.speed
      },
      { draw, chrome, failed: (error) => failed(error.message) }
    )
    const act = (effect: Effect.Effect<void>) => (): void => {
      Effect.runFork(effect)
    }
    play?.addEventListener("click", act(controller.toggle))
    back?.addEventListener("click", act(controller.step(-1)))
    fwd?.addEventListener("click", act(controller.step(1)))
    for (const button of speeds) {
      button.addEventListener("click", act(controller.setSpeed(Number(button.dataset["speed"]))))
    }
    track?.addEventListener("click", (event) => {
      const box = track.getBoundingClientRect()
      const at = t0 + ((event.clientX - box.left) / box.width) * total
      Effect.runFork(controller.seek(countAtTime(steps, at), true))
    })
    addEventListener("keydown", (event) => {
      if (event.key === " ") {
        event.preventDefault()
        play?.click()
      }
      if (event.key === "ArrowRight") {
        fwd?.click()
      }
      if (event.key === "ArrowLeft") {
        back?.click()
      }
    })
    show("replay")
    yield* controller.seek((yield* controller.state).count, false)
    // Like `watch --replay`: it plays from the start unless asked to open at a seq.
    if (!frozen && seqParam === null) {
      yield* controller.play
    }
    // The controller's fibers live as long as the page.
    return yield* Effect.never
  })

const page = Effect.gen(function* () {
  const run = yield* browserSource.run
  yield* run.mode === "replay" ? startReplay(run) : startLive(run)
})

Effect.runFork(reported(Effect.scoped(page)))
