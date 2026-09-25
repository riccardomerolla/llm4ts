import { readFile } from "node:fs/promises"
import { posix } from "node:path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  CatalogVersion,
  Endpoint,
  FaultRef,
  OpenQuestion,
  type OpenQuestionCode,
  Operation,
  qname,
  type QName,
  type SoapVersion,
  splitClark,
  WsdlCatalog,
  XsdNamespace
} from "./Catalog.ts"
import {
  attribute,
  childrenNamed,
  firstChild,
  is,
  parseXmlBytes,
  resolveQName,
  textOf,
  type XmlElement,
  type XmlError
} from "./Xml.ts"
import { collectSchema, finishSchemas, makeSchemaCollector, type SchemaCollector } from "./Xsd.ts"

// WSDL discovery: load the root document, follow `wsdl:import`,
// `xsd:import`, and `xsd:include` through the `DocumentLoader`, and build the
// typed `WsdlCatalog`. Only document/literal SOAP bindings become operations
// (v1 scope). A WSDL whose every SOAP binding is RPC or encoded fails with
// `WsdlError` naming the bindings; one that also offers a document/literal
// binding keeps the usable one and records the others as open questions.

export const Wsdl11Namespace = "http://schemas.xmlsoap.org/wsdl/"
export const Wsdl20Namespace = "http://www.w3.org/ns/wsdl"
const Soap11BindingNamespace = "http://schemas.xmlsoap.org/wsdl/soap/"
const Soap12BindingNamespace = "http://schemas.xmlsoap.org/wsdl/soap12/"
const Wsdl20SoapNamespace = "http://www.w3.org/ns/wsdl/soap"

export class DocumentLoadError extends Schema.TaggedError<DocumentLoadError>()(
  "DocumentLoadError",
  {
    location: Schema.String,
    detail: Schema.String
  }
) {
  get message(): string {
    return `cannot load ${this.location}: ${this.detail}`
  }
}

export class WsdlError extends Schema.TaggedError<WsdlError>()("WsdlError", {
  reason: Schema.Literals(["not-wsdl", "unsupported-binding", "no-operations"]),
  detail: Schema.String,
  location: Schema.String
}) {
  get message(): string {
    return `${this.location}: ${this.reason}: ${this.detail}`
  }
}

export interface DocumentLoaderShape {
  /** Raw bytes of a document; `location` is a path or an http(s) URL. */
  readonly load: (location: string) => Effect.Effect<Uint8Array, DocumentLoadError>
}

export class DocumentLoader extends Context.Service<DocumentLoader, DocumentLoaderShape>()(
  "@llm4ts/kits/soap-ace/DocumentLoader"
) {}

/** A loader over an in-memory map of location → text, for tests and fixtures. */
export const makeMemoryDocumentLoader = (
  documents: Readonly<Record<string, string | Uint8Array>>
): DocumentLoaderShape => ({
  load: (location) => {
    const found = documents[location]
    if (found === undefined) {
      return Effect.fail(new DocumentLoadError({ location, detail: "not found" }))
    }
    return Effect.succeed(typeof found === "string" ? new TextEncoder().encode(found) : found)
  }
})

/** A loader over local files; URLs are refused (they need a `SoapTransport`). */
export const makeFileDocumentLoader = (): DocumentLoaderShape => ({
  load: (location) =>
    isUrl(location)
      ? Effect.fail(
          new DocumentLoadError({ location, detail: "URLs need the HTTP document loader" })
        )
      : Effect.tryPromise({
          try: async () => new Uint8Array(await readFile(location)),
          catch: (cause) =>
            new DocumentLoadError({
              location,
              detail:
                typeof cause === "object" && cause !== null && "code" in cause
                  ? String(cause.code)
                  : "unreadable"
            })
        })
})

const isUrl = (location: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(location)

/** Resolve a relative `location`/`schemaLocation` against the referring document. */
export const resolveLocation = (base: string, relative: string): string => {
  if (isUrl(relative)) return relative
  if (isUrl(base)) return new URL(relative, base).toString()
  if (relative.startsWith("/")) return posix.normalize(relative)
  return posix.normalize(posix.join(posix.dirname(base), relative))
}

// ---------------------------------------------------------------------------
// WSDL 1.1 model, merged across imported documents

interface Part {
  readonly name: string
  readonly element: QName | undefined
  readonly type: QName | undefined
}

interface PortTypeOperation {
  readonly name: string
  readonly input: QName | undefined
  readonly output: QName | undefined
  readonly faults: ReadonlyArray<{ readonly name: string; readonly message: QName | undefined }>
  readonly documentation: string | undefined
}

interface BindingOperation {
  readonly name: string
  readonly soapAction: string
  readonly style: string
  readonly use: string
  readonly bodyParts: string | undefined
}

interface Binding {
  readonly name: string
  readonly portType: QName | undefined
  readonly soapVersion: SoapVersion | undefined
  readonly style: string
  readonly operations: ReadonlyArray<BindingOperation>
  readonly location: string
}

interface Port {
  readonly service: string
  readonly name: string
  readonly binding: QName | undefined
  readonly address: string | undefined
  readonly location: string
}

interface Wsdl11 {
  readonly messages: Map<QName, ReadonlyArray<Part>>
  readonly portTypes: Map<QName, ReadonlyArray<PortTypeOperation>>
  readonly bindings: Map<QName, Binding>
  readonly ports: Array<Port>
}

// ---------------------------------------------------------------------------
// WSDL 2.0 model

interface Interface20 {
  readonly faults: Map<string, QName | undefined>
  readonly operations: ReadonlyArray<{
    readonly name: string
    readonly input: QName | undefined
    readonly output: QName | undefined
    readonly faults: ReadonlyArray<string>
    readonly documentation: string | undefined
  }>
}

interface Binding20 {
  readonly name: string
  readonly interfaceName: QName | undefined
  readonly soap: boolean
  readonly soapVersion: SoapVersion
  readonly actions: Map<string, string>
}

interface Wsdl20 {
  readonly interfaces: Map<QName, Interface20>
  readonly bindings: Map<QName, Binding20>
  readonly endpoints: Array<Port>
}

const refOf = (element: XmlElement, name: string): QName | undefined => {
  const value = attribute(element, name)
  if (value === undefined) return undefined
  const resolved = resolveQName(element, value)
  return resolved === undefined ? `{?}${value}` : qname(resolved.namespace, resolved.local)
}

const wsdlDocumentation = (element: XmlElement, namespace: string): string | undefined => {
  const documentation = firstChild(element, namespace, "documentation")
  const text = documentation === undefined ? "" : textOf(documentation).trim().replace(/\s+/g, " ")
  return text === "" ? undefined : text
}

class Discovery {
  readonly documents: Array<string> = []
  readonly schemas: SchemaCollector = makeSchemaCollector()
  readonly questions: Array<OpenQuestion> = []
  readonly wsdl11: Wsdl11 = {
    messages: new Map(),
    portTypes: new Map(),
    bindings: new Map(),
    ports: []
  }
  readonly wsdl20: Wsdl20 = { interfaces: new Map(), bindings: new Map(), endpoints: [] }
  private readonly visited = new Set<string>()

  constructor(private readonly loader: DocumentLoaderShape) {}

  question(code: OpenQuestionCode, location: string, subject: string, detail: string): void {
    this.questions.push(new OpenQuestion({ code, location, subject, detail }))
  }

  load(location: string): Effect.Effect<XmlElement, DocumentLoadError | XmlError> {
    this.documents.push(location)
    return Effect.flatMap(this.loader.load(location), (bytes) =>
      parseXmlBytes(bytes, { source: location })
    )
  }

  /** Read a WSDL document (root or imported) and everything it pulls in. */
  wsdl(
    location: string
  ): Effect.Effect<
    { readonly version: "1.1" | "2.0"; readonly targetNamespace: string },
    DocumentLoadError | XmlError | WsdlError
  > {
    this.visited.add(location)
    return Effect.flatMap(this.load(location), (root) => this.wsdlFrom(root, location))
  }

  private wsdlFrom(
    root: XmlElement,
    location: string
  ): Effect.Effect<
    { readonly version: "1.1" | "2.0"; readonly targetNamespace: string },
    DocumentLoadError | XmlError | WsdlError
  > {
    return Effect.gen({ self: this }, function* () {
      const version = is(root, Wsdl11Namespace, "definitions")
        ? "1.1"
        : is(root, Wsdl20Namespace, "description")
          ? "2.0"
          : undefined
      if (version === undefined) {
        return yield* new WsdlError({
          reason: "not-wsdl",
          detail: `root element {${root.name.namespace}}${root.name.local} is not a WSDL 1.1 definitions or WSDL 2.0 description`,
          location
        })
      }
      const namespace = version === "1.1" ? Wsdl11Namespace : Wsdl20Namespace
      const targetNamespace = attribute(root, "targetNamespace") ?? ""

      for (const imported of [
        ...childrenNamed(root, namespace, "import"),
        ...childrenNamed(root, namespace, "include")
      ]) {
        const target = attribute(imported, "location")
        if (target === undefined) continue
        const resolved = resolveLocation(location, target)
        if (this.visited.has(resolved)) continue
        this.visited.add(resolved)
        const next = yield* this.load(resolved)
        if (is(next, XsdNamespace, "schema")) {
          yield* this.schema(next, resolved, undefined)
        } else {
          yield* this.wsdlFrom(next, resolved)
        }
      }

      const types = firstChild(root, namespace, "types")
      if (types !== undefined) {
        for (const schema of childrenNamed(types, XsdNamespace, "schema")) {
          yield* this.schema(schema, location, undefined)
        }
      }

      if (version === "1.1") this.read11(root, location, targetNamespace)
      else this.read20(root, location, targetNamespace)
      return { version, targetNamespace }
    })
  }

  schema(
    schema: XmlElement,
    location: string,
    namespaceOverride: string | undefined
  ): Effect.Effect<void, DocumentLoadError | XmlError> {
    return Effect.gen({ self: this }, function* () {
      const read = collectSchema(schema, location, this.schemas, namespaceOverride)
      for (const reference of read.references) {
        const resolved = resolveLocation(location, reference.location)
        const key = reference.kind === "include" ? `${resolved}#${read.targetNamespace}` : resolved
        if (this.visited.has(key)) continue
        this.visited.add(key)
        const next = yield* this.load(resolved)
        if (!is(next, XsdNamespace, "schema")) continue
        yield* this.schema(
          next,
          resolved,
          reference.kind === "include" ? read.targetNamespace : undefined
        )
      }
    })
  }

  private read11(root: XmlElement, location: string, targetNamespace: string): void {
    const at = (element: XmlElement) => `${location}:${element.line}`
    for (const message of childrenNamed(root, Wsdl11Namespace, "message")) {
      const name = attribute(message, "name")
      if (name === undefined) continue
      this.wsdl11.messages.set(
        qname(targetNamespace, name),
        childrenNamed(message, Wsdl11Namespace, "part").map((part) => ({
          name: attribute(part, "name") ?? "",
          element: refOf(part, "element"),
          type: refOf(part, "type")
        }))
      )
    }
    for (const portType of childrenNamed(root, Wsdl11Namespace, "portType")) {
      const name = attribute(portType, "name")
      if (name === undefined) continue
      this.wsdl11.portTypes.set(
        qname(targetNamespace, name),
        childrenNamed(portType, Wsdl11Namespace, "operation").map((operation) => {
          const input = firstChild(operation, Wsdl11Namespace, "input")
          const output = firstChild(operation, Wsdl11Namespace, "output")
          return {
            name: attribute(operation, "name") ?? "",
            input: input === undefined ? undefined : refOf(input, "message"),
            output: output === undefined ? undefined : refOf(output, "message"),
            faults: childrenNamed(operation, Wsdl11Namespace, "fault").map((fault) => ({
              name: attribute(fault, "name") ?? "",
              message: refOf(fault, "message")
            })),
            documentation: wsdlDocumentation(operation, Wsdl11Namespace)
          }
        })
      )
    }
    for (const binding of childrenNamed(root, Wsdl11Namespace, "binding")) {
      const name = attribute(binding, "name")
      if (name === undefined) continue
      const soap11 = firstChild(binding, Soap11BindingNamespace, "binding")
      const soap12 = firstChild(binding, Soap12BindingNamespace, "binding")
      const soapNamespace = soap11 !== undefined ? Soap11BindingNamespace : Soap12BindingNamespace
      const soapBinding = soap11 ?? soap12
      const style = soapBinding === undefined ? "" : (attribute(soapBinding, "style") ?? "document")
      this.wsdl11.bindings.set(qname(targetNamespace, name), {
        name,
        portType: refOf(binding, "type"),
        soapVersion: soap11 !== undefined ? "1.1" : soap12 !== undefined ? "1.2" : undefined,
        style,
        location: at(binding),
        operations: childrenNamed(binding, Wsdl11Namespace, "operation").map((operation) => {
          const soapOperation = firstChild(operation, soapNamespace, "operation")
          const input = firstChild(operation, Wsdl11Namespace, "input")
          const body = input === undefined ? undefined : firstChild(input, soapNamespace, "body")
          return {
            name: attribute(operation, "name") ?? "",
            soapAction:
              soapOperation === undefined ? "" : (attribute(soapOperation, "soapAction") ?? ""),
            style:
              (soapOperation === undefined ? undefined : attribute(soapOperation, "style")) ??
              style,
            use: body === undefined ? "literal" : (attribute(body, "use") ?? "literal"),
            bodyParts: body === undefined ? undefined : attribute(body, "parts")
          }
        })
      })
    }
    for (const service of childrenNamed(root, Wsdl11Namespace, "service")) {
      const serviceName = attribute(service, "name") ?? ""
      for (const port of childrenNamed(service, Wsdl11Namespace, "port")) {
        const address =
          firstChild(port, Soap11BindingNamespace, "address") ??
          firstChild(port, Soap12BindingNamespace, "address")
        this.wsdl11.ports.push({
          service: serviceName,
          name: attribute(port, "name") ?? "",
          binding: refOf(port, "binding"),
          address: address === undefined ? undefined : attribute(address, "location"),
          location: at(port)
        })
      }
    }
  }

  private read20(root: XmlElement, location: string, targetNamespace: string): void {
    for (const iface of childrenNamed(root, Wsdl20Namespace, "interface")) {
      const name = attribute(iface, "name")
      if (name === undefined) continue
      const faults = new Map<string, QName | undefined>()
      for (const fault of childrenNamed(iface, Wsdl20Namespace, "fault")) {
        faults.set(attribute(fault, "name") ?? "", refOf(fault, "element"))
      }
      this.wsdl20.interfaces.set(qname(targetNamespace, name), {
        faults,
        operations: childrenNamed(iface, Wsdl20Namespace, "operation").map((operation) => {
          const input = firstChild(operation, Wsdl20Namespace, "input")
          const output = firstChild(operation, Wsdl20Namespace, "output")
          return {
            name: attribute(operation, "name") ?? "",
            input: input === undefined ? undefined : refOf(input, "element"),
            output: output === undefined ? undefined : refOf(output, "element"),
            faults: childrenNamed(operation, Wsdl20Namespace, "outfault").map((fault) => {
              const ref = refOf(fault, "ref")
              return ref === undefined ? "" : splitClark(ref).local
            }),
            documentation: wsdlDocumentation(operation, Wsdl20Namespace)
          }
        })
      })
    }
    for (const binding of childrenNamed(root, Wsdl20Namespace, "binding")) {
      const name = attribute(binding, "name")
      if (name === undefined) continue
      const actions = new Map<string, string>()
      for (const operation of childrenNamed(binding, Wsdl20Namespace, "operation")) {
        const ref = refOf(operation, "ref")
        if (ref !== undefined) {
          actions.set(
            splitClark(ref).local,
            attribute(operation, "action", Wsdl20SoapNamespace) ?? ""
          )
        }
      }
      this.wsdl20.bindings.set(qname(targetNamespace, name), {
        name,
        interfaceName: refOf(binding, "interface"),
        soap: attribute(binding, "type") === Wsdl20SoapNamespace,
        soapVersion: attribute(binding, "version", Wsdl20SoapNamespace) === "1.1" ? "1.1" : "1.2",
        actions
      })
    }
    for (const service of childrenNamed(root, Wsdl20Namespace, "service")) {
      const serviceName = attribute(service, "name") ?? ""
      for (const endpoint of childrenNamed(service, Wsdl20Namespace, "endpoint")) {
        this.wsdl20.endpoints.push({
          service: serviceName,
          name: attribute(endpoint, "name") ?? "",
          binding: refOf(endpoint, "binding"),
          address: attribute(endpoint, "address"),
          location: `${location}:${endpoint.line}`
        })
      }
    }
  }
}

const faultElement = (discovery: Discovery, message: QName | undefined): QName | undefined => {
  if (message === undefined) return undefined
  return discovery.wsdl11.messages.get(message)?.find((part) => part.element !== undefined)?.element
}

const operations11 = (
  discovery: Discovery,
  rootLocation: string
): Effect.Effect<
  { readonly operations: ReadonlyArray<Operation>; readonly endpoints: ReadonlyArray<Endpoint> },
  WsdlError
> => {
  const { bindings, portTypes, messages, ports } = discovery.wsdl11
  const operations = new Map<string, Operation>()
  const rejected: Array<string> = []
  // SOAP 1.1 bindings first: when a service offers both, the 1.1 binding
  // names the operation's defaults, and the 1.2 one only adds an endpoint.
  const ordered = [...bindings.values()].sort(
    (left, right) => (left.soapVersion === "1.1" ? 0 : 1) - (right.soapVersion === "1.1" ? 0 : 1)
  )
  for (const binding of ordered) {
    if (binding.soapVersion === undefined) {
      discovery.question(
        "unsupported-binding",
        binding.location,
        binding.name,
        `binding ${binding.name} is not a SOAP binding (HTTP or MIME bindings are out of scope)`
      )
      continue
    }
    const unsupported = binding.operations.filter(
      (operation) => operation.style === "rpc" || operation.use === "encoded"
    )
    if (unsupported.length > 0) {
      const styles = [...new Set(unsupported.map((op) => `${op.style}/${op.use}`))].join(", ")
      rejected.push(`${binding.name} (${styles})`)
      discovery.question(
        "unsupported-binding",
        binding.location,
        binding.name,
        `binding ${binding.name} uses ${styles}; only document/literal is supported`
      )
      continue
    }
    const portType = binding.portType === undefined ? undefined : portTypes.get(binding.portType)
    if (portType === undefined) continue
    for (const bound of binding.operations) {
      if (operations.has(bound.name)) continue
      const abstract = portType.find((operation) => operation.name === bound.name)
      if (abstract === undefined) continue
      const messageElement = (message: QName | undefined, direction: string) => {
        if (message === undefined) return undefined
        const parts = messages.get(message) ?? []
        const selected =
          bound.bodyParts === undefined
            ? parts
            : parts.filter((part) => bound.bodyParts?.split(/\s+/).includes(part.name))
        if (selected.length > 1) {
          discovery.question(
            "multi-part-message",
            binding.location,
            bound.name,
            `${direction} message ${splitClark(message).local} has ${selected.length} body parts; the first is used`
          )
        }
        const first = selected[0]
        if (first !== undefined && first.element === undefined) {
          discovery.question(
            "non-literal-part",
            binding.location,
            bound.name,
            `${direction} part ${first.name} uses type= instead of element=; not document/literal`
          )
          return undefined
        }
        return first?.element
      }
      const input = messageElement(abstract.input, "input")
      if (input === undefined) continue
      const output = messageElement(abstract.output, "output")
      const inputType = discovery.schemas.elements.get(input)?.type
      const inputComplex =
        inputType === undefined ? undefined : discovery.schemas.complex.get(inputType)
      operations.set(
        bound.name,
        new Operation({
          name: bound.name,
          soapAction: bound.soapAction,
          soapVersion: binding.soapVersion,
          binding: binding.name,
          wrapped:
            splitClark(input).local === bound.name &&
            inputComplex !== undefined &&
            inputComplex.attributes.length === 0,
          input,
          ...(output === undefined ? {} : { output }),
          faults: abstract.faults.flatMap((fault) => {
            const element = faultElement(discovery, fault.message)
            return element === undefined ? [] : [new FaultRef({ name: fault.name, element })]
          }),
          ...(abstract.documentation === undefined ? {} : { documentation: abstract.documentation })
        })
      )
    }
  }
  if (operations.size === 0) {
    return Effect.fail(
      rejected.length > 0
        ? new WsdlError({
            reason: "unsupported-binding",
            detail: `only document/literal bindings are supported; rejected: ${rejected.join("; ")}`,
            location: rootLocation
          })
        : new WsdlError({
            reason: "no-operations",
            detail: "no SOAP operation could be read from the WSDL",
            location: rootLocation
          })
    )
  }
  const endpoints = ports.flatMap((port) => {
    const binding = port.binding === undefined ? undefined : bindings.get(port.binding)
    if (binding?.soapVersion === undefined) return []
    if (port.address === undefined) {
      discovery.question(
        "missing-address",
        port.location,
        port.name,
        `port ${port.name} has no address`
      )
      return []
    }
    return [
      new Endpoint({
        service: port.service,
        port: port.name,
        binding: binding.name,
        soapVersion: binding.soapVersion,
        address: port.address
      })
    ]
  })
  return Effect.succeed({ operations: [...operations.values()], endpoints })
}

const operations20 = (
  discovery: Discovery,
  rootLocation: string
): Effect.Effect<
  { readonly operations: ReadonlyArray<Operation>; readonly endpoints: ReadonlyArray<Endpoint> },
  WsdlError
> => {
  const { interfaces, bindings, endpoints } = discovery.wsdl20
  const operations = new Map<string, Operation>()
  for (const binding of bindings.values()) {
    if (!binding.soap) continue
    const iface =
      binding.interfaceName === undefined ? undefined : interfaces.get(binding.interfaceName)
    if (iface === undefined) continue
    for (const abstract of iface.operations) {
      if (operations.has(abstract.name) || abstract.input === undefined) continue
      const inputType = discovery.schemas.elements.get(abstract.input)?.type
      const inputComplex =
        inputType === undefined ? undefined : discovery.schemas.complex.get(inputType)
      operations.set(
        abstract.name,
        new Operation({
          name: abstract.name,
          soapAction: binding.actions.get(abstract.name) ?? "",
          soapVersion: binding.soapVersion,
          binding: binding.name,
          wrapped:
            splitClark(abstract.input).local === abstract.name &&
            inputComplex !== undefined &&
            inputComplex.attributes.length === 0,
          input: abstract.input,
          ...(abstract.output === undefined ? {} : { output: abstract.output }),
          faults: abstract.faults.flatMap((name) => {
            const element = iface.faults.get(name)
            return element === undefined ? [] : [new FaultRef({ name, element })]
          }),
          ...(abstract.documentation === undefined ? {} : { documentation: abstract.documentation })
        })
      )
    }
  }
  if (operations.size === 0) {
    return Effect.fail(
      new WsdlError({
        reason: "no-operations",
        detail: "no SOAP operation could be read from the WSDL 2.0 description",
        location: rootLocation
      })
    )
  }
  return Effect.succeed({
    operations: [...operations.values()],
    endpoints: endpoints.flatMap((endpoint) => {
      const binding = endpoint.binding === undefined ? undefined : bindings.get(endpoint.binding)
      if (binding === undefined || !binding.soap || endpoint.address === undefined) return []
      return [
        new Endpoint({
          service: endpoint.service,
          port: endpoint.name,
          binding: binding.name,
          soapVersion: binding.soapVersion,
          address: endpoint.address
        })
      ]
    })
  })
}

/**
 * Discover a SOAP service: read the WSDL at `location` (a path or URL) with
 * every document it imports, and return its typed catalog.
 */
export const readCatalog = (
  location: string
): Effect.Effect<WsdlCatalog, DocumentLoadError | XmlError | WsdlError, DocumentLoader> =>
  Effect.gen(function* () {
    const loader = yield* DocumentLoader
    const discovery = new Discovery(loader)
    const root = yield* discovery.wsdl(location)
    const schemas = finishSchemas(discovery.schemas)
    const read =
      root.version === "1.1"
        ? yield* operations11(discovery, location)
        : yield* operations20(discovery, location)
    return new WsdlCatalog({
      version: CatalogVersion,
      wsdlVersion: root.version,
      targetNamespace: root.targetNamespace,
      documents: discovery.documents,
      endpoints: read.endpoints,
      operations: read.operations,
      elements: schemas.elements,
      types: schemas.types,
      openQuestions: [...schemas.questions, ...discovery.questions]
    })
  })
