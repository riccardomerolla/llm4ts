/**
 * How the agent tree writes counts, clocks and money: the terminal tree and
 * the `watch --web` page (ADR 0051) print the same text. Pure, with no Node
 * import, so the page's browser bundle can carry it.
 */

/** 950 → "950", 12_400 → "12.4k", 1_250_000 → "1.3M". */
export const formatCount = (value: number): string =>
  value < 1_000
    ? `${Math.max(0, Math.round(value))}`
    : value < 1_000_000
      ? `${(value / 1_000).toFixed(1)}k`
      : `${(value / 1_000_000).toFixed(1)}M`

/** The time from `from` to `to` as `00:02:17`; zero when `from` is unknown. */
export const clock = (from: number | undefined, to: number): string => {
  const seconds = Math.max(0, Math.round((to - (from ?? to)) / 1_000))
  return [Math.floor(seconds / 3_600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

/** The time from `from` to `to` as `42s`, `3m07s` or `1h02m`. */
export const elapsed = (from: number | undefined, to: number | undefined): string => {
  const seconds = Math.max(0, Math.floor(((to ?? 0) - (from ?? to ?? 0)) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return seconds < 60
    ? `${seconds}s`
    : minutes < 60
      ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
      : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

/** An estimated cost: `~$0.42`. */
export const dollars = (usd: number): string => `~$${usd.toFixed(2)}`
