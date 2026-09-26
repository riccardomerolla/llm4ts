import * as Schema from "effect/Schema"

// The typed catalog of one SOAP service: what `soap-discover` persists as
// `catalog.json` and every later step (sample authoring, masking by field,
// analysis, the 1:1 mapping, the REST design) reads. It is produced by the
// deterministic WSDL/XSD reader, never by a model. Anything the reader does
// not model is recorded as an open question instead of being guessed.

export const CatalogVersion = 1

export const XsdNamespace = "http://www.w3.org/2001/XMLSchema"

/** A qualified name in Clark notation, `{namespace}local`. */
export const QName = Schema.String
export type QName = typeof QName.Type

export const qname = (namespace: string, local: string): QName => `{${namespace}}${local}`

export const splitClark = (name: QName): { readonly namespace: string; readonly local: string } => {
  const close = name.indexOf("}")
  return name.startsWith("{") && close > 0
    ? { namespace: name.slice(1, close), local: name.slice(close + 1) }
    : { namespace: "", local: name }
}

export const localName = (name: QName): string => splitClark(name).local

export const isBuiltin = (name: QName): boolean => splitClark(name).namespace === XsdNamespace

export const Occurs = Schema.Union([Schema.Int, Schema.Literal("unbounded")])
export type Occurs = typeof Occurs.Type

export class Facets extends Schema.Class<Facets>("Facets")({
  enumeration: Schema.optionalKey(Schema.Array(Schema.String)),
  pattern: Schema.optionalKey(Schema.Array(Schema.String)),
  length: Schema.optionalKey(Schema.Int),
  minLength: Schema.optionalKey(Schema.Int),
  maxLength: Schema.optionalKey(Schema.Int),
  totalDigits: Schema.optionalKey(Schema.Int),
  fractionDigits: Schema.optionalKey(Schema.Int),
  minInclusive: Schema.optionalKey(Schema.String),
  maxInclusive: Schema.optionalKey(Schema.String),
  minExclusive: Schema.optionalKey(Schema.String),
  maxExclusive: Schema.optionalKey(Schema.String),
  whiteSpace: Schema.optionalKey(Schema.Literals(["preserve", "replace", "collapse"]))
}) {}

/** A model group (`xs:sequence`, `xs:choice`, `xs:all`) of a complex type's content. */
export class ModelGroup extends Schema.Class<ModelGroup>("ModelGroup")({
  /** Index of the group within its type's `groups`. */
  id: Schema.Int,
  kind: Schema.Literals(["sequence", "choice", "all"]),
  minOccurs: Schema.Int,
  maxOccurs: Occurs,
  /** The enclosing group; absent for a group at the top of the content. */
  parent: Schema.optionalKey(Schema.Int),
  /** Index into the type's `fields` of the first field at or after the group's start. */
  start: Schema.Int
}) {}

/** An element particle's own occurrence bounds, before its groups' bounds fold in. */
export const ParticleOccurs = Schema.Struct({ min: Schema.Int, max: Occurs })
export type ParticleOccurs = typeof ParticleOccurs.Type

/** A child element of a complex type's content model. */
export class ElementField extends Schema.Class<ElementField>("ElementField")({
  name: Schema.String,
  /** Namespace of the element as it appears on the wire (`""` when unqualified). */
  namespace: Schema.String,
  type: QName,
  /**
   * Effective bounds within one instance of the type: an optional group
   * makes its elements optional, a repeating group makes them repeat.
   */
  minOccurs: Schema.Int,
  maxOccurs: Occurs,
  nillable: Schema.Boolean,
  /** Set when the field sits inside an `xs:choice`: the innermost choice's index within the type. */
  choice: Schema.optionalKey(Schema.Int),
  /** Within a choice: the alternative this field belongs to (a sequence is one alternative). */
  branch: Schema.optionalKey(Schema.Int),
  /** The innermost model group (index into the type's `groups`); the exact content model. */
  group: Schema.optionalKey(Schema.Int),
  /** The element particle's own bounds within `group`. */
  occurs: Schema.optionalKey(ParticleOccurs),
  /** `fixed=`: the only value the element may hold. */
  fixed: Schema.optionalKey(Schema.String),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export class AttributeField extends Schema.Class<AttributeField>("AttributeField")({
  name: Schema.String,
  /** Namespace of the attribute on the wire; absent when unqualified. */
  namespace: Schema.optionalKey(Schema.String),
  type: QName,
  required: Schema.Boolean,
  /** `fixed=`: the only value the attribute may hold. */
  fixed: Schema.optionalKey(Schema.String),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export class ComplexTypeDef extends Schema.Class<ComplexTypeDef>("ComplexTypeDef")({
  _tag: Schema.tag("complex"),
  name: QName,
  /** True for a type declared inline in an element; its name is synthesized. */
  anonymous: Schema.Boolean,
  /** `xs:extension` base, already flattened into `fields`/`attributes`. */
  base: Schema.optionalKey(QName),
  fields: Schema.Array(ElementField),
  /** The model groups the fields sit in (see `ElementField.group`). */
  groups: Schema.optionalKey(Schema.Array(ModelGroup)),
  attributes: Schema.Array(AttributeField),
  /** Simple content (`xs:simpleContent`): the text value's type. */
  textType: Schema.optionalKey(QName),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export class SimpleTypeDef extends Schema.Class<SimpleTypeDef>("SimpleTypeDef")({
  _tag: Schema.tag("simple"),
  name: QName,
  anonymous: Schema.Boolean,
  /** The restriction base (an `xs:` builtin or another simple type). */
  base: QName,
  facets: Facets,
  /** `xs:list` and `xs:union` types; absent for a restriction. */
  variety: Schema.optionalKey(Schema.Literals(["list", "union"])),
  /** A list's item type. */
  itemType: Schema.optionalKey(QName),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export const TypeDef = Schema.Union([ComplexTypeDef, SimpleTypeDef])
export type TypeDef = typeof TypeDef.Type

export class ElementDecl extends Schema.Class<ElementDecl>("ElementDecl")({
  name: QName,
  type: QName,
  nillable: Schema.Boolean,
  fixed: Schema.optionalKey(Schema.String),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export const SoapVersion = Schema.Literals(["1.1", "1.2"])
export type SoapVersion = typeof SoapVersion.Type

export class FaultRef extends Schema.Class<FaultRef>("FaultRef")({
  name: Schema.String,
  element: QName
}) {}

export class Operation extends Schema.Class<Operation>("Operation")({
  name: Schema.String,
  soapAction: Schema.String,
  soapVersion: SoapVersion,
  binding: Schema.String,
  /** Document/literal wrapped: the request element carries the operation name. */
  wrapped: Schema.Boolean,
  input: QName,
  output: Schema.optionalKey(QName),
  faults: Schema.Array(FaultRef),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export class Endpoint extends Schema.Class<Endpoint>("Endpoint")({
  service: Schema.String,
  port: Schema.String,
  binding: Schema.String,
  soapVersion: SoapVersion,
  address: Schema.String
}) {}

export const OpenQuestionCode = Schema.Literals([
  "xsd-any",
  "xsd-any-attribute",
  "substitution-group",
  "abstract",
  "group-ref",
  "attribute-group",
  "complex-restriction",
  "mixed-content",
  "list-or-union",
  "unresolved-type",
  "unresolved-element",
  "unresolved-attribute",
  "redefine",
  "non-literal-part",
  "unsupported-binding",
  "multi-part-message",
  "missing-address"
])
export type OpenQuestionCode = typeof OpenQuestionCode.Type

export class OpenQuestion extends Schema.Class<OpenQuestion>("OpenQuestion")({
  code: OpenQuestionCode,
  /** Where: `<document>:<line>`, plus the owning type or operation when known. */
  location: Schema.String,
  subject: Schema.String,
  detail: Schema.String
}) {}

export class WsdlCatalog extends Schema.Class<WsdlCatalog>("WsdlCatalog")({
  version: Schema.Literal(CatalogVersion),
  wsdlVersion: Schema.Literals(["1.1", "2.0"]),
  targetNamespace: Schema.String,
  /** Every document read, root first, as given or resolved. */
  documents: Schema.Array(Schema.String),
  endpoints: Schema.Array(Endpoint),
  operations: Schema.Array(Operation),
  elements: Schema.Array(ElementDecl),
  types: Schema.Array(TypeDef),
  openQuestions: Schema.Array(OpenQuestion)
}) {}

export const typeByName = (catalog: WsdlCatalog, name: QName): TypeDef | undefined =>
  catalog.types.find((type) => type.name === name)

export const elementByName = (catalog: WsdlCatalog, name: QName): ElementDecl | undefined =>
  catalog.elements.find((element) => element.name === name)

export const operationByName = (catalog: WsdlCatalog, name: string): Operation | undefined =>
  catalog.operations.find((operation) => operation.name === name)

// ---------------------------------------------------------------------------
// Content models

/** A particle of a complex type's content model: an element or a model group. */
export type Particle =
  | {
      readonly kind: "element"
      readonly field: ElementField
      readonly min: number
      readonly max: Occurs
    }
  | {
      readonly kind: "sequence" | "choice" | "all"
      readonly min: number
      readonly max: Occurs
      readonly children: ReadonlyArray<Particle>
    }

/**
 * The content model of a complex type as a particle tree, rooted in a
 * sequence that occurs once (an extension's base content, then its own).
 * A catalog written before model groups were recorded is rebuilt from the
 * fields' choice and branch ids.
 */
export const contentModel = (type: ComplexTypeDef): Particle => {
  const groups = type.groups ?? []
  const exact = type.fields.every((field) => field.group !== undefined)
  const legacyElement = (field: ElementField): Particle => ({
    kind: "element",
    field,
    min: field.minOccurs,
    max: field.maxOccurs
  })
  if (!exact || groups.length === 0) {
    // Top-level entries: a field, or the id of a choice at its first field.
    const top: Array<ElementField | number> = []
    const choices = new Map<number, Map<number | undefined, Array<ElementField>>>()
    for (const field of type.fields) {
      if (field.choice === undefined) {
        top.push(field)
        continue
      }
      const branches =
        choices.get(field.choice) ?? new Map<number | undefined, Array<ElementField>>()
      if (!choices.has(field.choice)) top.push(field.choice)
      choices.set(field.choice, branches)
      branches.set(field.branch, [...(branches.get(field.branch) ?? []), field])
    }
    const children = top.map((entry): Particle => {
      if (typeof entry !== "number") return legacyElement(entry)
      const alternatives = [...(choices.get(entry)?.values() ?? [])].map(
        (members): Particle =>
          members.length === 1 && members[0] !== undefined
            ? legacyElement(members[0])
            : { kind: "sequence", min: 1, max: 1, children: members.map(legacyElement) }
      )
      return { kind: "choice", min: 1, max: 1, children: alternatives }
    })
    return { kind: "sequence", min: 1, max: 1, children }
  }
  // Children of each group in document order: a group sits before the
  // field it starts at; groups starting together keep their id order.
  const entries: Array<{
    readonly parent: number | undefined
    readonly order: readonly [number, number, number]
    readonly build: () => Particle
  }> = []
  const childrenOf = (parent: number | undefined): ReadonlyArray<Particle> =>
    entries
      .filter((entry) => entry.parent === parent)
      .sort(
        (left, right) =>
          left.order[0] - right.order[0] ||
          left.order[1] - right.order[1] ||
          left.order[2] - right.order[2]
      )
      .map((entry) => entry.build())
  groups.forEach((group) => {
    entries.push({
      parent: group.parent,
      order: [group.start, 0, group.id],
      build: () => ({
        kind: group.kind,
        min: group.minOccurs,
        max: group.maxOccurs,
        children: childrenOf(group.id)
      })
    })
  })
  type.fields.forEach((field, index) => {
    entries.push({
      parent: field.group,
      order: [index, 1, 0],
      build: () => ({
        kind: "element",
        field,
        min: field.occurs?.min ?? field.minOccurs,
        max: field.occurs?.max ?? field.maxOccurs
      })
    })
  })
  return { kind: "sequence", min: 1, max: 1, children: childrenOf(undefined) }
}

/** Every element field under a particle, in order. */
export const particleFields = (particle: Particle): ReadonlyArray<ElementField> =>
  particle.kind === "element" ? [particle.field] : particle.children.flatMap(particleFields)

/** Whether a particle can be satisfied by no elements at all. */
export const emptiable = (particle: Particle): boolean => {
  if (particle.min === 0) return true
  if (particle.kind === "element") return false
  return particle.kind === "choice"
    ? particle.children.some(emptiable)
    : particle.children.every(emptiable)
}
