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
  maxExclusive: Schema.optionalKey(Schema.String)
}) {}

/** A child element of a complex type's content model. */
export class ElementField extends Schema.Class<ElementField>("ElementField")({
  name: Schema.String,
  /** Namespace of the element as it appears on the wire (`""` when unqualified). */
  namespace: Schema.String,
  type: QName,
  minOccurs: Schema.Int,
  maxOccurs: Occurs,
  nillable: Schema.Boolean,
  /** Set when the field sits inside an `xs:choice`: the choice's index within the type. */
  choice: Schema.optionalKey(Schema.Int),
  /** Within a choice: the alternative this field belongs to (a sequence is one alternative). */
  branch: Schema.optionalKey(Schema.Int),
  documentation: Schema.optionalKey(Schema.String)
}) {}

export class AttributeField extends Schema.Class<AttributeField>("AttributeField")({
  name: Schema.String,
  type: QName,
  required: Schema.Boolean,
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
  documentation: Schema.optionalKey(Schema.String)
}) {}

export const TypeDef = Schema.Union([ComplexTypeDef, SimpleTypeDef])
export type TypeDef = typeof TypeDef.Type

export class ElementDecl extends Schema.Class<ElementDecl>("ElementDecl")({
  name: QName,
  type: QName,
  nillable: Schema.Boolean,
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
