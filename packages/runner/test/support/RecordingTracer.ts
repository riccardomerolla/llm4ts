import * as Context from "effect/Context"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

export interface RecordedSpan {
  readonly name: string
  readonly kind: Tracer.SpanKind
  readonly root: boolean
  readonly parentName: string | undefined
  readonly linkedTo: ReadonlyArray<string>
  readonly attributes: Record<string, unknown>
  readonly events: Array<{ readonly name: string; readonly attributes: Record<string, unknown> }>
  ended: boolean
  failed: boolean
}

let ids = 0

const nameOf = (span: Tracer.AnySpan): string => (span._tag === "Span" ? span.name : "(external)")

/** A tracer that keeps every span it made, for assertions; no export, no clock. */
export const recordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: () => ReadonlyArray<RecordedSpan>
} => {
  const recorded: Array<RecordedSpan> = []
  const tracer = Tracer.make({
    span(options) {
      ids += 1
      const record: RecordedSpan = {
        name: options.name,
        kind: options.kind,
        root: options.root,
        parentName: Option.isSome(options.parent) ? nameOf(options.parent.value) : undefined,
        linkedTo: options.links.map((link) => nameOf(link.span)),
        attributes: {},
        events: [],
        ended: false,
        failed: false
      }
      recorded.push(record)
      const attributes = new Map<string, unknown>()
      const span: Tracer.Span = {
        _tag: "Span",
        name: options.name,
        spanId: `span-${ids}`,
        traceId:
          Option.isSome(options.parent) && !options.root
            ? options.parent.value.traceId
            : `trace-${ids}`,
        parent: options.parent,
        annotations: Context.empty(),
        status: { _tag: "Started", startTime: options.startTime },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end(_endTime, exit) {
          record.ended = true
          record.failed = Exit.isFailure(exit)
        },
        attribute(key, value) {
          attributes.set(key, value)
          record.attributes[key] = value
        },
        event(name, _startTime, eventAttributes = {}) {
          record.events.push({ name, attributes: { ...eventAttributes } })
        },
        addLinks(_links) {}
      }
      return span
    }
  })
  return { tracer, spans: () => recorded }
}
