import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import { RateLimitError, UsageLimitError, type LlmError } from "./Errors.ts"

const codexAt = /try again at\s+(\d{1,2}:\d{2}\s*[AP]M)/i
const claudeAt = /usage limit.*?(?:resets?|try again) at\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i
const geminiReset = /reset after\s+((?:\d+(?:ms|[dhms]))+)/i
const resetComponent = /(\d+)(ms|[dhms])/gi
const shortResetLimit = Duration.seconds(120)

const geminiQuotaSignals: ReadonlyArray<string> = [
  "exhausted your capacity",
  "quota",
  "resource_exhausted",
  "rate_limit",
  "rate limit",
  "429"
]

const genericQuotaSignals: ReadonlyArray<string> = [
  ...geminiQuotaSignals,
  "usage limit",
  "out of credits",
  "too many requests"
]

const includesSignal = (text: string, signals: ReadonlyArray<string>): boolean => {
  const normalized = text.toLowerCase()
  return signals.some((signal) => normalized.includes(signal))
}

export const isGeminiQuota = (text: string): boolean => includesSignal(text, geminiQuotaSignals)

const isGenericQuota = (text: string): boolean => includesSignal(text, genericQuotaSignals)

const resetDuration = (specification: string): Duration.Duration => {
  let milliseconds = 0

  for (const match of specification.matchAll(resetComponent)) {
    const amount = Number(match[1] ?? "0")
    const unit = (match[2] ?? "ms").toLowerCase()

    switch (unit) {
      case "d":
        milliseconds += amount * 86_400_000
        break
      case "h":
        milliseconds += amount * 3_600_000
        break
      case "m":
        milliseconds += amount * 60_000
        break
      case "s":
        milliseconds += amount * 1_000
        break
      default:
        milliseconds += amount
    }
  }

  return Duration.millis(milliseconds)
}

interface WallClockTime {
  readonly hour: number
  readonly minute: number
}

const parseWallClockTime = (raw: string): WallClockTime | undefined => {
  const match = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])m$/i)
  if (match === null) {
    return undefined
  }

  const clockHour = Number(match[1])
  const minute = Number(match[2] ?? "0")
  const period = (match[3] ?? "").toLowerCase()
  if (clockHour < 1 || clockHour > 12 || minute < 0 || minute > 59) {
    return undefined
  }

  return {
    hour: (clockHour % 12) + (period === "p" ? 12 : 0),
    minute
  }
}

interface CalendarDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

const dateTimeFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  })

const numericPart = (
  parts: ReadonlyArray<Intl.DateTimeFormatPart>,
  type: Intl.DateTimeFormatPartTypes
): number => Number(parts.find((part) => part.type === type)?.value ?? "0")

const localParts = (epochMillis: number, timeZone: string) => {
  const parts = dateTimeFormatter(timeZone).formatToParts(new Date(epochMillis))
  return {
    year: numericPart(parts, "year"),
    month: numericPart(parts, "month"),
    day: numericPart(parts, "day"),
    hour: numericPart(parts, "hour"),
    minute: numericPart(parts, "minute"),
    second: numericPart(parts, "second")
  }
}

const timeZoneOffsetMillis = (epochMillis: number, timeZone: string): number => {
  const parts = localParts(epochMillis, timeZone)
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  )
  return representedAsUtc - Math.trunc(epochMillis / 1_000) * 1_000
}

const epochForLocalTime = (date: CalendarDate, time: WallClockTime, timeZone: string): number => {
  const utcGuess = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute)
  const firstCandidate = utcGuess - timeZoneOffsetMillis(utcGuess, timeZone)
  return utcGuess - timeZoneOffsetMillis(firstCandidate, timeZone)
}

const nextCalendarDate = (date: CalendarDate): CalendarDate => {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1))
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  }
}

const wallClockReset = (
  text: string,
  pattern: RegExp,
  now: DateTime.Utc,
  timeZone: string
): DateTime.Utc | undefined => {
  const rawTime = text.match(pattern)?.[1]
  const time = rawTime === undefined ? undefined : parseWallClockTime(rawTime)
  if (time === undefined) {
    return undefined
  }

  try {
    const nowMillis = DateTime.toEpochMillis(now)
    const localNow = localParts(nowMillis, timeZone)
    const today: CalendarDate = {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day
    }
    const todayCandidate = epochForLocalTime(today, time, timeZone)
    const resetMillis =
      todayCandidate > nowMillis
        ? todayCandidate
        : epochForLocalTime(nextCalendarDate(today), time, timeZone)

    return DateTime.makeUnsafe(resetMillis)
  } catch {
    return undefined
  }
}

export const classifyUsageLimit = (
  provider: string,
  text: string,
  now: DateTime.Utc,
  timeZone: string
): LlmError | undefined => {
  switch (provider) {
    case "codex": {
      const resetAt = wallClockReset(text, codexAt, now, timeZone)
      return resetAt === undefined
        ? undefined
        : UsageLimitError.make({
            resetAt,
            provider,
            message: text
          })
    }
    case "claude": {
      const resetAt = wallClockReset(text, claudeAt, now, timeZone)
      return resetAt === undefined
        ? undefined
        : UsageLimitError.make({
            resetAt,
            provider,
            message: text
          })
    }
    case "gemini": {
      const resetSpecification = text.match(geminiReset)?.[1]
      if (resetSpecification !== undefined) {
        const duration = resetDuration(resetSpecification)
        return Duration.toMillis(duration) <= Duration.toMillis(shortResetLimit)
          ? RateLimitError.make({ retryAfter: duration })
          : UsageLimitError.make({
              resetAt: DateTime.addDuration(now, duration),
              provider,
              message: text
            })
      }

      return isGeminiQuota(text)
        ? UsageLimitError.make({
            provider,
            message: text
          })
        : undefined
    }
    case "grok":
    case "cursor":
    case "opencode":
      return isGenericQuota(text)
        ? UsageLimitError.make({
            provider,
            message: text
          })
        : undefined
    default:
      return undefined
  }
}
