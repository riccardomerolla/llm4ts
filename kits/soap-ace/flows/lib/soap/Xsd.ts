import {
  AttributeField,
  ComplexTypeDef,
  ElementDecl,
  ElementField,
  Facets,
  isBuiltin,
  ModelGroup,
  type Occurs,
  OpenQuestion,
  type OpenQuestionCode,
  qname,
  type QName,
  SimpleTypeDef,
  splitClark,
  type TypeDef,
  XsdNamespace
} from "./Catalog.ts"
import {
  attribute,
  elements,
  firstChild,
  is,
  resolveQName,
  textOf,
  type XmlElement
} from "./Xml.ts"

// XSD reading in two passes. `collectSchema` reads one `xs:schema` element
// into a collector without resolving anything across documents (imports and
// includes are followed by the WSDL loader, which feeds every schema it finds
// into the same collector). `finishSchemas` then resolves element refs,
// flattens `xs:extension` bases, and reports every dangling reference as an
// open question. Nothing here is guessed: an unmodelled construct is kept
// out of the typed model and named in an open question.

const anyType = qname(XsdNamespace, "anyType")
const stringType = qname(XsdNamespace, "string")

interface RawField {
  readonly name: string
  readonly namespace: string
  readonly type: QName | undefined
  /** Global element this field refers to (`ref=`); resolved in the finish pass. */
  readonly ref: QName | undefined
  readonly minOccurs: number
  readonly maxOccurs: Occurs
  /** The element particle's own bounds, before its groups' bounds fold in. */
  readonly own: { readonly min: number; readonly max: Occurs }
  readonly nillable: boolean
  readonly fixed: string | undefined
  readonly choice: number | undefined
  /** Within a choice: which alternative the field belongs to (a sequence is one branch). */
  readonly branch: number | undefined
  /** The innermost model group the element sits in. */
  readonly group: number
  readonly documentation: string | undefined
  readonly location: string
}

interface RawAttribute {
  readonly name: string
  readonly namespace: string | undefined
  readonly type: QName
  /** Global attribute this one refers to (`ref=`); resolved in the finish pass. */
  readonly ref: QName | undefined
  readonly use: string | undefined
  readonly fixed: string | undefined
  readonly documentation: string | undefined
  readonly location: string
}

interface GlobalAttribute {
  readonly type: QName
  readonly fixed: string | undefined
  readonly documentation: string | undefined
}

interface RawComplex {
  readonly name: QName
  readonly anonymous: boolean
  readonly base: QName | undefined
  /**
   * How the type derives from `base`: an extension appends to the base's
   * content, a restriction restates it (only the base's attributes carry over).
   */
  readonly derivation: "extension" | "restriction" | undefined
  readonly fields: ReadonlyArray<RawField>
  readonly groups: ReadonlyArray<ModelGroup>
  readonly attributes: ReadonlyArray<RawAttribute>
  readonly textType: QName | undefined
  /** Derived by simpleContent: `base` may be complex (inherit its text and attributes). */
  readonly simpleContent: boolean
  readonly documentation: string | undefined
  readonly location: string
}

export interface SchemaReference {
  /** A redefine is followed as an include; its redefinitions are reported. */
  readonly kind: "import" | "include"
  readonly namespace: string | undefined
  readonly location: string
}

export interface SchemaCollector {
  readonly complex: Map<QName, RawComplex>
  readonly simple: Map<QName, SimpleTypeDef>
  readonly elements: Map<QName, ElementDecl>
  readonly attributes: Map<QName, GlobalAttribute>
  readonly questions: Array<OpenQuestion>
  /** Namespaces declared by at least one schema, for unresolved-reference reporting. */
  readonly namespaces: Set<string>
  /** Synthesized names of anonymous types, kept unique across every schema read. */
  readonly anonymous: Set<QName>
  /** `<document>:<line>` of simple types and global elements, for open questions. */
  readonly locations: Map<QName, string>
}

export const makeSchemaCollector = (): SchemaCollector => ({
  complex: new Map(),
  simple: new Map(),
  elements: new Map(),
  attributes: new Map(),
  questions: [],
  namespaces: new Set(),
  anonymous: new Set(),
  locations: new Map()
})

const xs = (element: XmlElement, local: string): boolean => is(element, XsdNamespace, local)

const xsChildren = (element: XmlElement): ReadonlyArray<XmlElement> =>
  elements(element).filter((child) => child.name.namespace === XsdNamespace)

export const documentationOf = (element: XmlElement): string | undefined => {
  const annotation = firstChild(element, XsdNamespace, "annotation")
  if (annotation === undefined) return undefined
  const text = elements(annotation)
    .filter((child) => xs(child, "documentation"))
    .map((child) => textOf(child).trim().replace(/\s+/g, " "))
    .filter((value) => value !== "")
    .join(" ")
  return text === "" ? undefined : text
}

const optionalDoc = (documentation: string | undefined) =>
  documentation === undefined ? {} : { documentation }

const parseOccurs = (value: string | undefined, fallback: number): Occurs => {
  if (value === undefined) return fallback
  if (value === "unbounded") return "unbounded"
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

const parseMinOccurs = (value: string | undefined): number => {
  const parsed = parseOccurs(value, 1)
  return parsed === "unbounded" ? 1 : parsed
}

/** An XSD boolean attribute: `true` or `1`. */
const flag = (element: XmlElement, name: string): boolean => {
  const value = attribute(element, name)?.trim()
  return value === "true" || value === "1"
}

const facetNames = new Set([
  "enumeration",
  "pattern",
  "length",
  "minLength",
  "maxLength",
  "totalDigits",
  "fractionDigits",
  "minInclusive",
  "maxInclusive",
  "minExclusive",
  "maxExclusive",
  "whiteSpace"
])

interface ParticleContext {
  readonly choice: number | undefined
  readonly branch: number | undefined
  readonly group: number | undefined
  readonly optional: boolean
  readonly repeats: Occurs
}

const multiply = (left: Occurs, right: Occurs): Occurs =>
  left === "unbounded" || right === "unbounded" ? "unbounded" : left * right

class SchemaReader {
  readonly targetNamespace: string
  private readonly qualifiedElements: boolean
  private readonly qualifiedAttributes: boolean
  /** A schema without targetNamespace included into one: its no-namespace refs mean the includer's. */
  private readonly chameleon: boolean
  private readonly schema: XmlElement
  private readonly document: string
  private readonly into: SchemaCollector

  constructor(
    schema: XmlElement,
    document: string,
    into: SchemaCollector,
    /** For chameleon includes: the including schema's namespace. */
    namespaceOverride: string | undefined
  ) {
    this.schema = schema
    this.document = document
    this.into = into
    this.targetNamespace = attribute(schema, "targetNamespace") ?? namespaceOverride ?? ""
    this.chameleon =
      attribute(schema, "targetNamespace") === undefined && namespaceOverride !== undefined
    this.qualifiedElements = attribute(schema, "elementFormDefault") === "qualified"
    this.qualifiedAttributes = attribute(schema, "attributeFormDefault") === "qualified"
  }

  /**
   * A name for an anonymous type at `path` (`~op/x`). A global element and
   * a named type may share a local name, so a taken path gets a `#n` suffix.
   */
  private anonymousName(path: string): QName {
    const base = `~${path.replace(/^~/, "")}`
    let name = qname(this.targetNamespace, base)
    for (let n = 2; this.into.anonymous.has(name); n++) {
      name = qname(this.targetNamespace, `${base}#${n}`)
    }
    this.into.anonymous.add(name)
    return name
  }

  private where(element: XmlElement): string {
    return `${this.document}:${element.line}`
  }

  private question(
    code: OpenQuestionCode,
    element: XmlElement,
    subject: string,
    detail: string
  ): void {
    // Anonymous types carry a `~` marker in their synthesized names; the
    // question speaks of the element path the reader sees in the schema.
    this.into.questions.push(
      new OpenQuestion({
        code,
        location: this.where(element),
        subject: subject.replace(/^~/, ""),
        detail: detail.replace(/(^|\s)~/g, "$1")
      })
    )
  }

  private typeRef(element: XmlElement, value: string | undefined): QName | undefined {
    if (value === undefined) return undefined
    const resolved = resolveQName(element, value)
    if (resolved === undefined) return `{?}${value}`
    const namespace =
      this.chameleon && resolved.namespace === "" ? this.targetNamespace : resolved.namespace
    return qname(namespace, resolved.local)
  }

  read(): ReadonlyArray<SchemaReference> {
    this.into.namespaces.add(this.targetNamespace)
    const references: Array<SchemaReference> = []
    for (const child of xsChildren(this.schema)) {
      const name = attribute(child, "name")
      if (xs(child, "import") || xs(child, "include") || xs(child, "redefine")) {
        const location = attribute(child, "schemaLocation")
        if (location !== undefined) {
          references.push({
            kind: xs(child, "import") ? "import" : "include",
            namespace: xs(child, "import") ? attribute(child, "namespace") : this.targetNamespace,
            location
          })
        }
        const redefined = xsChildren(child)
          .filter((definition) => !xs(definition, "annotation"))
          .map((definition) => attribute(definition, "name") ?? "?")
        if (xs(child, "redefine") && redefined.length > 0) {
          this.question(
            "redefine",
            child,
            location ?? "?",
            `schema ${location ?? "?"} is included, but its redefinitions of ${redefined.join(", ")} are not applied`
          )
        }
      } else if (xs(child, "attribute") && name !== undefined) {
        this.globalAttribute(child, name)
      } else if (xs(child, "element") && name !== undefined) {
        this.globalElement(child, name)
      } else if (xs(child, "complexType") && name !== undefined) {
        this.complexType(child, qname(this.targetNamespace, name), false)
      } else if (xs(child, "simpleType") && name !== undefined) {
        this.simpleType(child, qname(this.targetNamespace, name), false)
      } else if (xs(child, "group") || xs(child, "attributeGroup")) {
        // Definitions are harmless; their use is reported where referenced.
      }
    }
    return references
  }

  private globalElement(element: XmlElement, name: string): void {
    const elementName = qname(this.targetNamespace, name)
    if (attribute(element, "substitutionGroup") !== undefined) {
      this.question(
        "substitution-group",
        element,
        name,
        `element ${name} joins substitution group ${attribute(element, "substitutionGroup") ?? ""}; substitutes are not modelled`
      )
    }
    if (flag(element, "abstract")) {
      this.question("abstract", element, name, `element ${name} is abstract`)
    }
    const type = this.elementType(element, name)
    const fixed = attribute(element, "fixed")
    this.into.locations.set(elementName, this.where(element))
    this.into.elements.set(
      elementName,
      new ElementDecl({
        name: elementName,
        type,
        nillable: flag(element, "nillable"),
        ...(fixed === undefined ? {} : { fixed }),
        ...optionalDoc(documentationOf(element))
      })
    )
  }

  private globalAttribute(element: XmlElement, name: string): void {
    const inline = firstChild(element, XsdNamespace, "simpleType")
    let type = this.typeRef(element, attribute(element, "type"))
    if (type === undefined && inline !== undefined) {
      type = this.anonymousName(`@${name}`)
      this.simpleType(inline, type, true)
    }
    this.into.attributes.set(qname(this.targetNamespace, name), {
      type: type ?? stringType,
      fixed: attribute(element, "fixed"),
      documentation: documentationOf(element)
    })
  }

  /** The type of an element: its `type=` or its inline (anonymous) type. */
  private elementType(element: XmlElement, anonymousPath: string): QName {
    const declared = this.typeRef(element, attribute(element, "type"))
    if (declared !== undefined) return declared
    const inlineComplex = firstChild(element, XsdNamespace, "complexType")
    if (inlineComplex !== undefined) {
      const name = this.anonymousName(anonymousPath)
      this.complexType(inlineComplex, name, true)
      return name
    }
    const inlineSimple = firstChild(element, XsdNamespace, "simpleType")
    if (inlineSimple !== undefined) {
      const name = this.anonymousName(anonymousPath)
      this.simpleType(inlineSimple, name, true)
      return name
    }
    return anyType
  }

  private complexType(element: XmlElement, name: QName, anonymous: boolean): void {
    const local = splitClark(name).local
    const complexContent = firstChild(element, XsdNamespace, "complexContent")
    const simpleContent = firstChild(element, XsdNamespace, "simpleContent")
    if (flag(element, "mixed") || (complexContent !== undefined && flag(complexContent, "mixed"))) {
      this.question("mixed-content", element, local, `type ${local} allows mixed text content`)
    }
    if (flag(element, "abstract")) {
      this.question("abstract", element, local, `type ${local} is abstract`)
    }
    let base: QName | undefined
    let derivation: RawComplex["derivation"]
    let textType: QName | undefined
    let content = element
    if (complexContent !== undefined) {
      const extension = firstChild(complexContent, XsdNamespace, "extension")
      const restriction = firstChild(complexContent, XsdNamespace, "restriction")
      if (extension !== undefined) {
        base = this.typeRef(extension, attribute(extension, "base"))
        derivation = "extension"
        content = extension
      } else if (restriction !== undefined) {
        this.question(
          "complex-restriction",
          restriction,
          local,
          `type ${local} restricts ${attribute(restriction, "base") ?? "?"}; only the restated content is modelled`
        )
        base = this.typeRef(restriction, attribute(restriction, "base"))
        derivation = "restriction"
        content = restriction
      }
    } else if (simpleContent !== undefined) {
      const extension = firstChild(simpleContent, XsdNamespace, "extension")
      const restriction = firstChild(simpleContent, XsdNamespace, "restriction")
      const step = extension ?? restriction
      if (step !== undefined) {
        // The base may be a simple type (the text's type) or a complex type
        // with simple content (inherit its text type and attributes); which
        // one is only known once every schema is read.
        base = this.typeRef(step, attribute(step, "base")) ?? stringType
        derivation = extension === undefined ? "restriction" : "extension"
        textType = base
        content = step
        const inline = firstChild(step, XsdNamespace, "simpleType")
        const facets = xsChildren(step).some((child) => facetNames.has(child.name.local))
        if (extension === undefined && (facets || inline !== undefined)) {
          // A restriction narrows the text: an anonymous simple type over
          // the base's text type (resolved in the finish pass) keeps its facets.
          textType = this.anonymousName(`${local}/#text`)
          this.simpleType(step, textType, true, base)
        }
      }
    }

    const fields: Array<RawField> = []
    const groups: Array<ModelGroup> = []
    const attributes: Array<RawAttribute> = []
    let counter = 0
    const next = (): number => counter++
    for (const child of xsChildren(content)) {
      if (xs(child, "sequence") || xs(child, "all") || xs(child, "choice")) {
        this.particle(
          child,
          local,
          fields,
          groups,
          {
            choice: undefined,
            branch: undefined,
            group: undefined,
            optional: false,
            repeats: 1
          },
          next
        )
      } else if (xs(child, "group")) {
        this.question(
          "group-ref",
          child,
          local,
          `type ${local} uses model group ${attribute(child, "ref") ?? "?"}; its fields are not modelled`
        )
      }
    }
    this.attributes(content, local, attributes)

    this.into.complex.set(name, {
      name,
      anonymous,
      base,
      derivation,
      fields,
      groups,
      attributes,
      textType,
      simpleContent: simpleContent !== undefined,
      documentation: documentationOf(element),
      location: this.where(element)
    })
  }

  private particle(
    group: XmlElement,
    owner: string,
    into: Array<RawField>,
    groups: Array<ModelGroup>,
    context: ParticleContext,
    next: () => number
  ): void {
    const minOccurs = parseMinOccurs(attribute(group, "minOccurs"))
    const maxOccurs = parseOccurs(attribute(group, "maxOccurs"), 1)
    const optional = context.optional || minOccurs === 0
    const repeats = multiply(context.repeats, maxOccurs)
    const isChoice = xs(group, "choice")
    const choice = isChoice ? next() : context.choice
    // The exact content model: every group, with its own bounds and parent.
    const id = groups.length
    groups.push(
      new ModelGroup({
        id,
        kind: isChoice ? "choice" : xs(group, "all") ? "all" : "sequence",
        minOccurs,
        maxOccurs,
        ...(context.group === undefined ? {} : { parent: context.group }),
        start: into.length
      })
    )
    for (const child of xsChildren(group)) {
      // Every alternative of a choice is its own branch; inside a branch,
      // a nested sequence keeps the branch it belongs to.
      const branch = isChoice ? next() : context.branch
      const inner: ParticleContext = { choice, branch, group: id, optional, repeats }
      if (xs(child, "element")) {
        into.push(this.localElement(child, owner, inner))
      } else if (xs(child, "sequence") || xs(child, "choice") || xs(child, "all")) {
        this.particle(child, owner, into, groups, inner, next)
      } else if (xs(child, "any")) {
        this.question(
          "xsd-any",
          child,
          owner,
          `type ${owner} accepts any element (namespace ${attribute(child, "namespace") ?? "##any"}); its content is open`
        )
      } else if (xs(child, "group")) {
        this.question(
          "group-ref",
          child,
          owner,
          `type ${owner} uses model group ${attribute(child, "ref") ?? "?"}; its fields are not modelled`
        )
      }
    }
  }

  private localElement(element: XmlElement, owner: string, context: ParticleContext): RawField {
    const ref = this.typeRef(element, attribute(element, "ref"))
    const own = {
      min: parseMinOccurs(attribute(element, "minOccurs")),
      max: parseOccurs(attribute(element, "maxOccurs"), 1)
    }
    const base = {
      minOccurs: context.optional ? 0 : own.min,
      maxOccurs: multiply(own.max, context.repeats),
      own,
      nillable: flag(element, "nillable"),
      fixed: attribute(element, "fixed"),
      choice: context.choice,
      branch: context.branch,
      group: context.group ?? 0,
      documentation: documentationOf(element),
      location: this.where(element)
    }
    if (ref !== undefined) {
      const target = splitClark(ref)
      return { ...base, name: target.local, namespace: target.namespace, type: undefined, ref }
    }
    const name = attribute(element, "name") ?? "?"
    const form = attribute(element, "form")
    const qualified = form === undefined ? this.qualifiedElements : form === "qualified"
    return {
      ...base,
      name,
      namespace: qualified ? this.targetNamespace : "",
      type: this.elementType(element, `${owner}/${name}`),
      ref: undefined
    }
  }

  private attributes(content: XmlElement, owner: string, into: Array<RawAttribute>): void {
    for (const child of xsChildren(content)) {
      if (xs(child, "attribute")) {
        const common = {
          use: attribute(child, "use"),
          fixed: attribute(child, "fixed"),
          documentation: documentationOf(child),
          location: this.where(child)
        }
        const ref = this.typeRef(child, attribute(child, "ref"))
        if (ref !== undefined) {
          // A global attribute: its name, type and namespace are the
          // declaration's, looked up once every schema is read.
          const target = splitClark(ref)
          into.push({
            ...common,
            name: target.local,
            namespace: target.namespace === "" ? undefined : target.namespace,
            type: stringType,
            ref
          })
          continue
        }
        const name = attribute(child, "name") ?? "?"
        const inline = firstChild(child, XsdNamespace, "simpleType")
        let type = this.typeRef(child, attribute(child, "type"))
        if (type === undefined && inline !== undefined) {
          type = this.anonymousName(`${owner}/@${name}`)
          this.simpleType(inline, type, true)
        }
        const form = attribute(child, "form")
        const qualified = form === undefined ? this.qualifiedAttributes : form === "qualified"
        into.push({
          ...common,
          name,
          namespace: qualified && this.targetNamespace !== "" ? this.targetNamespace : undefined,
          type: type ?? stringType,
          ref: undefined
        })
      } else if (xs(child, "attributeGroup")) {
        this.question(
          "attribute-group",
          child,
          owner,
          `type ${owner} uses attribute group ${attribute(child, "ref") ?? "?"}; its attributes are not modelled`
        )
      } else if (xs(child, "anyAttribute")) {
        this.question("xsd-any-attribute", child, owner, `type ${owner} accepts any attribute`)
      }
    }
  }

  /**
   * A simple type from its `xs:simpleType` element, or (with `restrictionBase`)
   * from a simpleContent restriction whose base is only known later.
   */
  private simpleType(
    element: XmlElement,
    name: QName,
    anonymous: boolean,
    restrictionBase?: QName
  ): void {
    const local = splitClark(name).local
    this.into.locations.set(name, this.where(element))
    const restriction =
      restrictionBase === undefined ? firstChild(element, XsdNamespace, "restriction") : element
    const list = firstChild(element, XsdNamespace, "list")
    if (restriction === undefined && list !== undefined) {
      // A list: whitespace-separated items of the item type; length facets
      // of a restriction over it count items.
      const inline = firstChild(list, XsdNamespace, "simpleType")
      let itemType = this.typeRef(list, attribute(list, "itemType"))
      if (itemType === undefined && inline !== undefined) {
        itemType = this.anonymousName(`${local}/#item`)
        this.simpleType(inline, itemType, true)
      }
      this.into.simple.set(
        name,
        new SimpleTypeDef({
          name,
          anonymous,
          base: stringType,
          facets: new Facets({}),
          variety: "list",
          itemType: itemType ?? stringType,
          ...optionalDoc(documentationOf(element))
        })
      )
      return
    }
    if (restriction === undefined) {
      this.question(
        "list-or-union",
        element,
        local,
        `simple type ${local} is a union; values are treated as strings`
      )
      this.into.simple.set(
        name,
        new SimpleTypeDef({
          name,
          anonymous,
          base: stringType,
          facets: new Facets({}),
          variety: "union",
          ...optionalDoc(documentationOf(element))
        })
      )
      return
    }
    // The base is `base=`, or an anonymous simple type written inside.
    let base = this.typeRef(restriction, attribute(restriction, "base")) ?? restrictionBase
    const inline = firstChild(restriction, XsdNamespace, "simpleType")
    if (inline !== undefined && (base === undefined || restrictionBase !== undefined)) {
      const inlineName = this.anonymousName(`${local}/#base`)
      this.simpleType(inline, inlineName, true)
      base = inlineName
    }
    this.into.simple.set(
      name,
      new SimpleTypeDef({
        name,
        anonymous,
        base: base ?? stringType,
        facets: readFacets(restriction),
        ...optionalDoc(documentationOf(element))
      })
    )
  }
}

const intFacet = (restriction: XmlElement, local: string): number | undefined => {
  const facet = firstChild(restriction, XsdNamespace, local)
  const value = facet === undefined ? undefined : attribute(facet, "value")
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

const stringFacet = (restriction: XmlElement, local: string): string | undefined => {
  const facet = firstChild(restriction, XsdNamespace, local)
  return facet === undefined ? undefined : attribute(facet, "value")
}

const readFacets = (restriction: XmlElement): Facets => {
  const all = (local: string): ReadonlyArray<string> =>
    elements(restriction)
      .filter((child) => xs(child, local))
      .map((child) => attribute(child, "value") ?? "")
  const enumeration = all("enumeration")
  const pattern = all("pattern")
  const bound = (key: string) => stringFacet(restriction, key)
  const minInclusive = bound("minInclusive")
  const maxInclusive = bound("maxInclusive")
  const minExclusive = bound("minExclusive")
  const maxExclusive = bound("maxExclusive")
  const length = intFacet(restriction, "length")
  const minLength = intFacet(restriction, "minLength")
  const maxLength = intFacet(restriction, "maxLength")
  const totalDigits = intFacet(restriction, "totalDigits")
  const fractionDigits = intFacet(restriction, "fractionDigits")
  const whiteSpace = stringFacet(restriction, "whiteSpace")?.trim()
  return new Facets({
    ...(enumeration.length > 0 ? { enumeration } : {}),
    ...(pattern.length > 0 ? { pattern } : {}),
    ...(length === undefined ? {} : { length }),
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(totalDigits === undefined ? {} : { totalDigits }),
    ...(fractionDigits === undefined ? {} : { fractionDigits }),
    ...(minInclusive === undefined ? {} : { minInclusive }),
    ...(maxInclusive === undefined ? {} : { maxInclusive }),
    ...(minExclusive === undefined ? {} : { minExclusive }),
    ...(maxExclusive === undefined ? {} : { maxExclusive }),
    ...(whiteSpace === "preserve" || whiteSpace === "replace" || whiteSpace === "collapse"
      ? { whiteSpace }
      : {})
  })
}

/** Read one `xs:schema` into the collector; returns the imports/includes to follow. */
export const collectSchema = (
  schema: XmlElement,
  document: string,
  into: SchemaCollector,
  namespaceOverride?: string
): { readonly targetNamespace: string; readonly references: ReadonlyArray<SchemaReference> } => {
  const reader = new SchemaReader(schema, document, into, namespaceOverride)
  return { targetNamespace: reader.targetNamespace, references: reader.read() }
}

const typeExists = (collector: SchemaCollector, name: QName): boolean =>
  isBuiltin(name) || collector.complex.has(name) || collector.simple.has(name)

/** Resolve refs, flatten extensions, and report dangling references. */
export const finishSchemas = (
  collector: SchemaCollector
): {
  readonly types: ReadonlyArray<TypeDef>
  readonly elements: ReadonlyArray<ElementDecl>
  readonly questions: ReadonlyArray<OpenQuestion>
} => {
  const questions = [...collector.questions]
  const unresolvedType = (name: QName, location: string, subject: string): void => {
    questions.push(
      new OpenQuestion({
        code: "unresolved-type",
        location,
        subject,
        detail: `type ${name} is not defined in any schema that was read`
      })
    )
  }

  const resolveField = (
    field: RawField,
    owner: string,
    offset: number,
    groupOffset: number
  ): ElementField => {
    let type = field.type ?? anyType
    let nillable = field.nillable
    let fixed = field.fixed
    if (field.ref !== undefined) {
      const target = collector.elements.get(field.ref)
      if (target === undefined) {
        questions.push(
          new OpenQuestion({
            code: "unresolved-element",
            location: field.location,
            subject: owner,
            detail: `element ref ${field.ref} is not declared in any schema that was read`
          })
        )
      } else {
        type = target.type
        nillable = nillable || target.nillable
        fixed = fixed ?? target.fixed
      }
    } else if (!typeExists(collector, type)) {
      unresolvedType(type, field.location, owner)
    }
    return new ElementField({
      name: field.name,
      namespace: field.namespace,
      type,
      minOccurs: field.minOccurs,
      maxOccurs: field.maxOccurs,
      nillable,
      ...(field.choice === undefined ? {} : { choice: field.choice + offset }),
      ...(field.branch === undefined ? {} : { branch: field.branch + offset }),
      group: field.group + groupOffset,
      occurs: field.own,
      ...(fixed === undefined ? {} : { fixed }),
      ...optionalDoc(field.documentation)
    })
  }

  const resolveAttribute = (raw: RawAttribute, owner: string): AttributeField | undefined => {
    if (raw.use === "prohibited") return undefined
    let type = raw.type
    let fixed = raw.fixed
    let documentation = raw.documentation
    if (raw.ref !== undefined) {
      const target = collector.attributes.get(raw.ref)
      if (target === undefined) {
        questions.push(
          new OpenQuestion({
            code: "unresolved-attribute",
            location: raw.location,
            subject: owner,
            detail: `attribute ref ${raw.ref} is not declared in any schema that was read`
          })
        )
      } else {
        type = target.type
        fixed = fixed ?? target.fixed
        documentation = documentation ?? target.documentation
      }
    }
    if (!typeExists(collector, type)) unresolvedType(type, raw.location, owner)
    return new AttributeField({
      name: raw.name,
      ...(raw.namespace === undefined ? {} : { namespace: raw.namespace }),
      type,
      required: raw.use === "required",
      ...(fixed === undefined ? {} : { fixed }),
      ...optionalDoc(documentation)
    })
  }

  const sameAttribute = (left: AttributeField | RawAttribute, right: RawAttribute): boolean =>
    left.name === right.name && (left.namespace ?? "") === (right.namespace ?? "")

  const flattened = new Map<QName, ComplexTypeDef>()
  const flatten = (raw: RawComplex, visiting: ReadonlySet<QName>): ComplexTypeDef => {
    const done = flattened.get(raw.name)
    if (done !== undefined) return done
    const owner = splitClark(raw.name).local
    let inheritedFields: ReadonlyArray<ElementField> = []
    let inheritedGroups: ReadonlyArray<ModelGroup> = []
    let inheritedAttributes: ReadonlyArray<AttributeField> = []
    let textType = raw.textType
    if (raw.base !== undefined && !isBuiltin(raw.base)) {
      const baseRaw = collector.complex.get(raw.base)
      if (baseRaw === undefined) {
        if (!collector.simple.has(raw.base)) unresolvedType(raw.base, raw.location, owner)
      } else if (!visiting.has(raw.base)) {
        const base = flatten(baseRaw, new Set([...visiting, raw.name]))
        // A restriction restates the content; only attributes carry over.
        if (raw.derivation !== "restriction" || raw.simpleContent) {
          inheritedFields = base.fields
          inheritedGroups = base.groups ?? []
        }
        inheritedAttributes = base.attributes
        // Simple content over a complex base: the text type is the base's.
        if (raw.simpleContent && raw.textType === raw.base) textType = base.textType ?? stringType
      }
    }
    // Choice and branch ids of the derived part continue after the base's,
    // so a base choice and a derived choice stay separate groups.
    const offset = inheritedFields.reduce(
      (max, field) => Math.max(max, (field.choice ?? -1) + 1, (field.branch ?? -1) + 1),
      0
    )
    const groupOffset = inheritedGroups.length
    const fieldOffset = inheritedFields.length
    if (textType !== undefined && !typeExists(collector, textType)) {
      unresolvedType(textType, raw.location, owner)
    }
    // Derived attributes restate (or prohibit) inherited ones of the same name.
    const attributes: Array<AttributeField> = []
    for (const inherited of inheritedAttributes) {
      const restated = raw.attributes.find((candidate) => sameAttribute(inherited, candidate))
      if (restated === undefined) attributes.push(inherited)
      else {
        const resolved = resolveAttribute(restated, owner)
        if (resolved !== undefined) attributes.push(resolved)
      }
    }
    for (const declared of raw.attributes) {
      if (inheritedAttributes.some((inherited) => sameAttribute(inherited, declared))) continue
      const resolved = resolveAttribute(declared, owner)
      if (resolved !== undefined) attributes.push(resolved)
    }
    const groups = [
      ...inheritedGroups,
      ...raw.groups.map(
        (group) =>
          new ModelGroup({
            ...group,
            id: group.id + groupOffset,
            ...(group.parent === undefined ? {} : { parent: group.parent + groupOffset }),
            start: group.start + fieldOffset
          })
      )
    ]
    const result = new ComplexTypeDef({
      name: raw.name,
      anonymous: raw.anonymous,
      ...(raw.base === undefined || (raw.derivation === "restriction" && !raw.simpleContent)
        ? {}
        : { base: raw.base }),
      fields: [
        ...inheritedFields,
        ...raw.fields.map((field) => resolveField(field, owner, offset, groupOffset))
      ],
      ...(groups.length === 0 ? {} : { groups }),
      attributes,
      ...(textType === undefined ? {} : { textType }),
      ...optionalDoc(raw.documentation)
    })
    flattened.set(raw.name, result)
    return result
  }

  const complex = [...collector.complex.values()].map((raw) => flatten(raw, new Set()))
  // A simpleContent restriction's text type restricts its complex base's
  // text type, known only now.
  const simple = [...collector.simple.values()].map((type) => {
    const complexBase = collector.complex.get(type.base)
    if (complexBase === undefined) return type
    return new SimpleTypeDef({
      ...type,
      base: flatten(complexBase, new Set()).textType ?? stringType
    })
  })
  for (const type of simple) {
    const types = [type.base, ...(type.itemType === undefined ? [] : [type.itemType])]
    for (const name of types) {
      if (!typeExists(collector, name)) {
        unresolvedType(
          name,
          collector.locations.get(type.name) ?? "(simple type)",
          splitClark(type.name).local
        )
      }
    }
  }
  for (const element of collector.elements.values()) {
    if (!typeExists(collector, element.type)) {
      unresolvedType(
        element.type,
        collector.locations.get(element.name) ?? "(global element)",
        splitClark(element.name).local
      )
    }
  }
  return {
    types: [...complex, ...simple],
    elements: [...collector.elements.values()],
    questions
  }
}
