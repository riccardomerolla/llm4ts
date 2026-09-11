/** Formatting helpers shared by every feature. Money is integer cents on the wire. */

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")

/** Cents to an Italian-style euro string: `1.234,56 €`; negative amounts keep their sign. */
export const euroText = (cents: number): string => {
  const sign = cents < 0 ? "-" : ""
  const absolute = Math.abs(Math.round(cents))
  const whole = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, "0")
  return `${sign}${group(String(whole))},${fraction} €`
}

/** Parses "1.234,56" or "1234.56" into cents; undefined when malformed or negative. */
export const parseEuro = (text: string): number | undefined => {
  const trimmed = text.trim().replace(/\s|€/g, "")
  if (trimmed.length === 0) return undefined
  const normalized = /,\d{1,2}$/.test(trimmed)
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed.replace(/,/g, "")
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return undefined
  return Math.round(Number(normalized) * 100)
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * An ISO date (or date-time) as the reader expects it: `14/03/2016` in
 * Italian, `14 Mar 2016` in English. Formatted by hand so the output does
 * not depend on the ICU data of the machine rendering it.
 */
export const dateText = (iso: string, language: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (match === null) return iso
  const [, year, month, day] = match
  if (year === undefined || month === undefined || day === undefined) return iso
  if (language === "it") return `${day}/${month}/${year}`
  const name = MONTHS_EN[Number(month) - 1]
  return name === undefined ? iso : `${Number(day)} ${name} ${year}`
}

/** IBAN in groups of four for reading; the wire keeps it compact. */
export const ibanText = (iban: string): string =>
  iban.replace(/\s+/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim()
