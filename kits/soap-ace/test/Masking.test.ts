import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  isValidCodiceFiscale,
  isValidIban,
  isValidLuhn,
  isValidPan,
  isValidPartitaIva,
  italianCheckLetter,
  kindForName,
  maskDocument,
  MaskingOverrides,
  maskText,
  pseudonymize
} from "../flows/lib/soap/Masking.ts"
import { elements, parseXml, renderXml, textOf, type XmlElement } from "../flows/lib/soap/Xml.ts"

const key = new TextEncoder().encode("test-key-0123456789abcdef")
const otherKey = new TextEncoder().encode("another-key-0123456789")

// Well-known public example values, valid by checksum; no real person.
const iban = "IT60X0542811101000000123456"
const cf = "RSSMRA85T10A562S"
const piva = "12345678903"
const pan = "4111111111111111"

// A deterministic generator of valid inputs for the property checks.
const lcg = (seed: number) => {
  let state = seed
  return (bound: number) => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % bound
  }
}

const ibanCheck = (bban: string): string => {
  const rearranged = `${bban}IT00`
  let remainder = 0
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55)
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return String(98 - remainder).padStart(2, "0")
}

const randomItalianIban = (draw: (bound: number) => number): string => {
  const digits = (count: number) => Array.from({ length: count }, () => String(draw(10))).join("")
  const abiCab = digits(10)
  const account = digits(12)
  const cin = italianCheckLetter(`${abiCab}${account}`)
  const bban = `${cin}${abiCab}${account}`
  return `IT${ibanCheck(bban)}${bban}`
}

const randomCf = (draw: (bound: number) => number, female: boolean): string => {
  const letter = () => String.fromCharCode(65 + draw(26))
  const digit = () => String(draw(10))
  const day = String(1 + draw(28) + (female ? 40 : 0)).padStart(2, "0")
  const body = `${letter()}${letter()}${letter()}${letter()}${letter()}${letter()}${digit()}${digit()}${"ABCDEHLMPRST"[draw(12)] ?? "A"}${day}${letter()}${digit()}${digit()}${digit()}`
  return `${body}${italianCheckLetter(body)}`
}

describe("Masking checksums", () => {
  it("recognizes the public example identifiers", () => {
    assert.isTrue(isValidIban(iban))
    assert.isFalse(isValidIban("IT61X0542811101000000123456"))
    assert.isTrue(isValidCodiceFiscale(cf))
    assert.isFalse(isValidCodiceFiscale("RSSMRA85T10A562T"))
    assert.isTrue(isValidPartitaIva(piva))
    assert.isFalse(isValidPartitaIva("12345678904"))
    assert.isTrue(isValidPan(pan))
    assert.isFalse(isValidLuhn("4111111111111112"))
  })
})

describe("pseudonymize", () => {
  it("keeps IBANs valid, Italian ones with their ABI/CAB and a correct CIN", () => {
    const draw = lcg(7)
    for (let run = 0; run < 200; run++) {
      const original = randomItalianIban(draw)
      assert.isTrue(isValidIban(original), original)
      const masked = pseudonymize(key, "iban", original)
      assert.isTrue(isValidIban(masked), `${original} → ${masked}`)
      assert.strictEqual(masked.slice(5, 15), original.slice(5, 15))
      assert.strictEqual(masked[4], italianCheckLetter(masked.slice(5)))
      assert.notStrictEqual(masked, original)
    }
    assert.isTrue(isValidIban(pseudonymize(key, "iban", "DE89370400440532013000")))
  })

  it("keeps codici fiscali valid and the holder's sex", () => {
    const draw = lcg(11)
    for (let run = 0; run < 200; run++) {
      const female = run % 2 === 0
      const original = randomCf(draw, female)
      const masked = pseudonymize(key, "codice-fiscale", original)
      assert.isTrue(isValidCodiceFiscale(masked), `${original} → ${masked}`)
      assert.strictEqual(Number(masked.slice(9, 11)) > 40, female)
    }
    // Omocodia in the original is normalized away in the pseudonym.
    assert.isTrue(isValidCodiceFiscale(pseudonymize(key, "codice-fiscale", cf)))
  })

  it("keeps partite IVA and PANs valid, with office code and BIN", () => {
    const maskedPiva = pseudonymize(key, "partita-iva", piva)
    assert.isTrue(isValidPartitaIva(maskedPiva))
    assert.strictEqual(maskedPiva.slice(7, 10), piva.slice(7, 10))
    const maskedPan = pseudonymize(key, "pan", pan)
    assert.isTrue(isValidPan(maskedPan))
    assert.strictEqual(maskedPan.slice(0, 6), "411111")
    assert.strictEqual(maskedPan.length, pan.length)
  })

  it("is stable per key and differs across keys", () => {
    assert.strictEqual(pseudonymize(key, "iban", iban), pseudonymize(key, "iban", iban))
    assert.notStrictEqual(pseudonymize(key, "iban", iban), pseudonymize(otherKey, "iban", iban))
  })

  it("preserves shape for text, emails, phones, and birth dates", () => {
    const name = pseudonymize(key, "personal-text", "Maria De Rossi")
    assert.match(name, /^[A-Z][a-z]{4} [A-Z][a-z] [A-Z][a-z]{4}$/)
    assert.match(
      pseudonymize(key, "email", "maria.rossi@banca.it"),
      /^[a-z]{5}\.[a-z]{5}@example\.invalid$/
    )
    assert.match(pseudonymize(key, "phone", "+39 333 1234567"), /^\+39 333 \d{7}$/)
    assert.match(pseudonymize(key, "birth-date", "1985-12-10"), /^\d{4}-\d{2}-\d{2}$/)
  })

  it("falls back to class-preserving scrambling when a value does not fit its field's kind", () => {
    // A company's codiceFiscale is its partita IVA.
    assert.isTrue(isValidPartitaIva(pseudonymize(key, "codice-fiscale", piva)))
    assert.match(pseudonymize(key, "iban", "n/a"), /^[a-z]\/[a-z]$/)
  })
})

describe("detection", () => {
  it("maps field names to kinds by words, not substrings", () => {
    assert.strictEqual(kindForName("ibanOrdinante"), "iban")
    assert.strictEqual(kindForName("codiceFiscale"), "codice-fiscale")
    assert.strictEqual(kindForName("partitaIva"), "partita-iva")
    assert.strictEqual(kindForName("numeroCarta"), "pan")
    assert.strictEqual(kindForName("dataNascita"), "birth-date")
    assert.strictEqual(kindForName("intestatario"), "personal-text")
    assert.strictEqual(kindForName("indirizzoResidenza"), "personal-text")
    assert.strictEqual(kindForName("codiceOtp"), "secret")
    assert.strictEqual(kindForName("dataValuta"), undefined)
    assert.strictEqual(kindForName("invia"), undefined)
    assert.strictEqual(kindForName("causale"), undefined)
  })

  it("finds checksummed identifiers inside free text and leaves look-alikes", () => {
    const found = maskText(
      key,
      `Bonifico da ${iban} per ${cf}, carta ${pan}, P.IVA IT${piva}, mail a.b@c.it, id 4111111111111112`
    )
    assert.sameMembers([...found.kinds], ["iban", "codice-fiscale", "pan", "partita-iva", "email"])
    assert.notInclude(found.text, iban)
    assert.notInclude(found.text, cf)
    assert.include(found.text, "4111111111111112")
  })
})

const findElement = (root: XmlElement, local: string): XmlElement | undefined => {
  if (root.name.local === local) return root
  for (const child of elements(root)) {
    const found = findElement(child, local)
    if (found !== undefined) return found
  }
  return undefined
}

describe("maskDocument", () => {
  const envelope = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <r:cercaContiResponse xmlns:r="urn:bank">
      <r:esito><r:codice>OK00</r:codice></r:esito>
      <r:conto>
        <r:iban>${iban}</r:iban>
        <r:intestatario>Mario Rossi</r:intestatario>
        <r:codiceFiscale>${cf}</r:codiceFiscale>
        <r:filiale>Milano Centro</r:filiale>
        <r:note causale="rif ${iban}">Accredito da ${iban}</r:note>
      </r:conto>
    </r:cercaContiResponse>
  </soap:Body>
</soap:Envelope>`

  it.effect("masks by field and by value, keeps structure, and reports each replacement", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(envelope)
      const { document, report } = maskDocument(root, { key })
      const xml = renderXml(document)
      assert.notInclude(xml, iban)
      assert.notInclude(xml, "Mario Rossi")
      assert.notInclude(xml, cf)
      assert.include(xml, "OK00")
      assert.include(xml, "Milano Centro")

      const reparsed = yield* parseXml(xml)
      const maskedIban = textOf(findElement(reparsed, "iban") ?? assert.fail("no iban element"))
      assert.isTrue(isValidIban(maskedIban))
      // The same IBAN is pseudonymized identically wherever it appears.
      assert.include(xml, `Accredito da ${maskedIban}`)
      assert.include(xml, `causale="rif ${maskedIban}"`)

      const summary = report.entries.map(
        (entry) => `${entry.path} ${entry.kind} ${entry.source} ${entry.count}`
      )
      assert.includeMembers(summary, [
        "Envelope/Body/cercaContiResponse/conto/iban iban field-name 1",
        "Envelope/Body/cercaContiResponse/conto/intestatario personal-text field-name 1",
        "Envelope/Body/cercaContiResponse/conto/note iban value 1",
        "Envelope/Body/cercaContiResponse/conto/note/@causale iban value 1"
      ])
    })
  )

  it.effect("applies keep and mask overrides and reports kept fields", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(envelope)
      const overrides = new MaskingOverrides({ fields: { intestatario: "keep", filiale: "mask" } })
      const { document, report } = maskDocument(root, { key, overrides })
      const xml = renderXml(document)
      assert.include(xml, "Mario Rossi")
      assert.notInclude(xml, "Milano Centro")
      assert.include(report.kept, "Envelope/Body/cercaContiResponse/conto/intestatario")
      assert.isTrue(report.entries.some((entry) => entry.source === "override"))
    })
  )

  it.effect("uses kinds implied by XSD types when names say nothing", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(`<r><rapporto>${iban.replace("IT60", "IT00")}</rapporto></r>`)
      const { report } = maskDocument(root, {
        key,
        typeKinds: new Map([["rapporto", "iban"]])
      })
      assert.strictEqual(report.entries[0]?.source, "field-type")
    })
  )
})
