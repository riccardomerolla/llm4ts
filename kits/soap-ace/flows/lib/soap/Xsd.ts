import {
  AttributeField,
  ComplexTypeDef,
  ElementDecl,
  ElementField,
  Facets,
  isBuiltin,
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
  readonly nillable: boolean
  readonly choice: number | undefined
  /** Within a choice: which alternative the field belongs to (a sequence is one branch). */
  readonly branch: number | undefined
  readonly documentation: string | undefined
  readonly location: string
}

interface RawComplex {
  readonly name: QName
  readonly anonymous: boolean
  readonly base: QName | undefined
  readonly fields: ReadonlyArray<RawField>
  readonly attributes: ReadonlyArray<AttributeField>
  readonly textType: QName | undefined
  /** Derived by simpleContent: `base` may be complex (inherit its text and attributes). */
  readonly simpleContent: boolean
  readonly documentation: string | undefined
  readonly location: string
}

export interface SchemaReference {
  readonly kind: "import" | "include"
  readonly namespace: string | undefined
  readonly location: string
}

export interface SchemaCollector {
  readonly complex: Map<QName, RawComplex>
  readonly simple: Map<QName, SimpleTypeDef>
  readonly elements: Map<QName, ElementDecl>
  readonly questions: Array<OpenQuestion>
  /** Namespaces declared by at least one schema, for unresolved-reference reporting. */
  readonly namespaces: Set<string>
}

export const makeSchemaCollector = (): SchemaCollector => ({
  complex: new Map(),
  simple: new Map(),
  elements: new Map(),
  questions: [],
  namespaces: new Set()
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

interface ParticleContext {
  readonly choice: number | undefined
  readonly branch: number | undefined
  readonly optional: boolean
  readonly repeats: Occurs
}

const multiply = (left: Occurs, right: Occurs): Occurs =>
  left === "unbounded" || right === "unbounded" ? "unbounded" : left * right

class SchemaReader {
  readonly targetNamespace: string
  private readonly qualifiedElements: boolean
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
      if (xs(child, "import") || xs(child, "include")) {
        const location = attribute(child, "schemaLocation")
        if (location !== undefined) {
          references.push({
            kind: xs(child, "import") ? "import" : "include",
            namespace: xs(child, "import") ? attribute(child, "namespace") : this.targetNamespace,
            location
          })
        }
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
    if (attribute(element, "abstract") === "true") {
      this.question("abstract", element, name, `element ${name} is abstract`)
    }
    const type = this.elementType(element, `~${name}`)
    this.into.elements.set(
      elementName,
      new ElementDecl({
        name: elementName,
        type,
        nillable: attribute(element, "nillable") === "true",
        ...optionalDoc(documentationOf(element))
      })
    )
  }

  /** The type of an element: its `type=` or its inline (anonymous) type. */
  private elementType(element: XmlElement, anonymousLocal: string): QName {
    const declared = this.typeRef(element, attribute(element, "type"))
    if (declared !== undefined) return declared
    const inlineComplex = firstChild(element, XsdNamespace, "complexType")
    if (inlineComplex !== undefined) {
      const name = qname(this.targetNamespace, anonymousLocal)
      this.complexType(inlineComplex, name, true)
      return name
    }
    const inlineSimple = firstChild(element, XsdNamespace, "simpleType")
    if (inlineSimple !== undefined) {
      const name = qname(this.targetNamespace, anonymousLocal)
      this.simpleType(inlineSimple, name, true)
      return name
    }
    return anyType
  }

  private complexType(element: XmlElement, name: QName, anonymous: boolean): void {
    const local = splitClark(name).local
    if (attribute(element, "mixed") === "true") {
      this.question("mixed-content", element, local, `type ${local} allows mixed text content`)
    }
    if (attribute(element, "abstract") === "true") {
      this.question("abstract", element, local, `type ${local} is abstract`)
    }
    let base: QName | undefined
    let textType: QName | undefined
    let content = element
    const complexContent = firstChild(element, XsdNamespace, "complexContent")
    const simpleContent = firstChild(element, XsdNamespace, "simpleContent")
    if (complexContent !== undefined) {
      const extension = firstChild(complexContent, XsdNamespace, "extension")
      const restriction = firstChild(complexContent, XsdNamespace, "restriction")
      if (extension !== undefined) {
        base = this.typeRef(extension, attribute(extension, "base"))
        content = extension
      } else if (restriction !== undefined) {
        this.question(
          "complex-restriction",
          restriction,
          local,
          `type ${local} restricts ${attribute(restriction, "base") ?? "?"}; only the restated content is modelled`
        )
        content = restriction
      }
    } else if (simpleContent !== undefined) {
      const derivation =
        firstChild(simpleContent, XsdNamespace, "extension") ??
        firstChild(simpleContent, XsdNamespace, "restriction")
      if (derivation !== undefined) {
        // The base may be a simple type (the text's type) or a complex type
        // with simple content (inherit its text type and attributes); which
        // one is only known once every schema is read.
        base = this.typeRef(derivation, attribute(derivation, "base")) ?? stringType
        textType = base
        content = derivation
      }
    }

    const fields: Array<RawField> = []
    const attributes: Array<AttributeField> = []
    let counter = 0
    const next = (): number => counter++
    for (const child of xsChildren(content)) {
      if (xs(child, "sequence") || xs(child, "all") || xs(child, "choice")) {
        this.particle(
          child,
          local,
          fields,
          { choice: undefined, branch: undefined, optional: false, repeats: 1 },
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
      fields,
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
    context: ParticleContext,
    next: () => number
  ): void {
    const optional = context.optional || attribute(group, "minOccurs") === "0"
    const repeats = multiply(context.repeats, parseOccurs(attribute(group, "maxOccurs"), 1))
    const isChoice = xs(group, "choice")
    const choice = isChoice ? next() : context.choice
    for (const child of xsChildren(group)) {
      // Every alternative of a choice is its own branch; inside a branch,
      // a nested sequence keeps the branch it belongs to.
      const branch = isChoice ? next() : context.branch
      const inner: ParticleContext = { choice, branch, optional, repeats }
      if (xs(child, "element")) {
        into.push(this.localElement(child, owner, inner))
      } else if (xs(child, "sequence") || xs(child, "choice") || xs(child, "all")) {
        this.particle(child, owner, into, inner, next)
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
    const minOccurs = context.optional ? 0 : parseMinOccurs(attribute(element, "minOccurs"))
    const maxOccurs = multiply(parseOccurs(attribute(element, "maxOccurs"), 1), context.repeats)
    const base = {
      minOccurs,
      maxOccurs,
      nillable: attribute(element, "nillable") === "true",
      choice: context.choice,
      branch: context.branch,
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
      type: this.elementType(element, `~${owner.replace(/^~/, "")}/${name}`),
      ref: undefined
    }
  }

  private attributes(content: XmlElement, owner: string, into: Array<AttributeField>): void {
    for (const child of xsChildren(content)) {
      if (xs(child, "attribute")) {
        const name = attribute(child, "name") ?? attribute(child, "ref") ?? "?"
        const inline = firstChild(child, XsdNamespace, "simpleType")
        let type = this.typeRef(child, attribute(child, "type"))
        if (type === undefined && inline !== undefined) {
          type = qname(this.targetNamespace, `~${owner.replace(/^~/, "")}/@${name}`)
          this.simpleType(inline, type, true)
        }
        into.push(
          new AttributeField({
            name,
            type: type ?? stringType,
            required: attribute(child, "use") === "required",
            ...optionalDoc(documentationOf(child))
          })
        )
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

  private simpleType(element: XmlElement, name: QName, anonymous: boolean): void {
    const local = splitClark(name).local
    const restriction = firstChild(element, XsdNamespace, "restriction")
    if (restriction === undefined) {
      this.question(
        "list-or-union",
        element,
        local,
        `simple type ${local} is a list or union; values are treated as strings`
      )
      this.into.simple.set(
        name,
        new SimpleTypeDef({
          name,
          anonymous,
          base: stringType,
          facets: new Facets({}),
          ...optionalDoc(documentationOf(element))
        })
      )
      return
    }
    this.into.simple.set(
      name,
      new SimpleTypeDef({
        name,
        anonymous,
        base: this.typeRef(restriction, attribute(restriction, "base")) ?? stringType,
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
    ...(maxExclusive === undefined ? {} : { maxExclusive })
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

  const resolveField = (field: RawField, owner: string, offset: number): ElementField => {
    let type = field.type ?? anyType
    let nillable = field.nillable
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
      ...optionalDoc(field.documentation)
    })
  }

  const flattened = new Map<QName, ComplexTypeDef>()
  const flatten = (raw: RawComplex, visiting: ReadonlySet<QName>): ComplexTypeDef => {
    const done = flattened.get(raw.name)
    if (done !== undefined) return done
    const owner = splitClark(raw.name).local
    let inheritedFields: ReadonlyArray<ElementField> = []
    let inheritedAttributes: ReadonlyArray<AttributeField> = []
    let textType = raw.textType
    if (raw.base !== undefined && !isBuiltin(raw.base)) {
      const baseRaw = collector.complex.get(raw.base)
      if (baseRaw === undefined) {
        if (!collector.simple.has(raw.base)) unresolvedType(raw.base, raw.location, owner)
      } else if (!visiting.has(raw.base)) {
        const base = flatten(baseRaw, new Set([...visiting, raw.name]))
        inheritedFields = base.fields
        inheritedAttributes = base.attributes
        // Simple content over a complex base: the text type is the base's.
        if (raw.simpleContent) textType = base.textType ?? stringType
      }
    }
    // Choice and branch ids of the derived part continue after the base's,
    // so a base choice and a derived choice stay separate groups.
    const offset = inheritedFields.reduce(
      (max, field) => Math.max(max, (field.choice ?? -1) + 1, (field.branch ?? -1) + 1),
      0
    )
    if (textType !== undefined && !typeExists(collector, textType)) {
      unresolvedType(textType, raw.location, owner)
    }
    for (const attributeField of raw.attributes) {
      if (!typeExists(collector, attributeField.type)) {
        unresolvedType(attributeField.type, raw.location, owner)
      }
    }
    const result = new ComplexTypeDef({
      name: raw.name,
      anonymous: raw.anonymous,
      ...(raw.base === undefined ? {} : { base: raw.base }),
      fields: [
        ...inheritedFields,
        ...raw.fields.map((field) => resolveField(field, owner, offset))
      ],
      attributes: [...inheritedAttributes, ...raw.attributes],
      ...(textType === undefined ? {} : { textType }),
      ...optionalDoc(raw.documentation)
    })
    flattened.set(raw.name, result)
    return result
  }

  const complex = [...collector.complex.values()].map((raw) => flatten(raw, new Set()))
  const simple = [...collector.simple.values()]
  for (const type of simple) {
    if (!typeExists(collector, type.base)) {
      unresolvedType(type.base, "(simple type)", splitClark(type.name).local)
    }
  }
  for (const element of collector.elements.values()) {
    if (!typeExists(collector, element.type)) {
      unresolvedType(element.type, "(global element)", splitClark(element.name).local)
    }
  }
  return {
    types: [...complex, ...simple],
    elements: [...collector.elements.values()],
    questions
  }
}
