import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"

/**
 * Interface language. English defines a feature's message set and Italian is
 * typed against it, so a missing or misspelt translation is a compile error
 * rather than a silent fallback in front of a customer. Italian is the default.
 */
export const LANGUAGES = ["it", "en"] as const
export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_NAMES: Record<Language, string> = { it: "Italiano", en: "English" }

const isLanguage = (value: string): value is Language => LANGUAGES.some((l) => l === value)

/**
 * A feature's dictionary: both languages over one key set. Each feature owns
 * its own module (`src/features/<feature>/messages.ts`), so no shared file is
 * edited when a feature is added; the kit's strings live in `messages.ts`.
 */
export interface Messages<K extends string> {
  readonly en: Readonly<Record<K, string>>
  readonly it: Readonly<Record<K, string>>
}

export const messages = <const D extends Readonly<Record<string, string>>>(
  en: D,
  it: Readonly<Record<keyof D & string, string>>
): Messages<keyof D & string> => ({ en, it })

/** `{name}` placeholders are filled from `values`. */
export type Translate<K extends string> = (key: K, values?: Readonly<Record<string, string>>) => string

export interface I18n {
  readonly language: Language
  readonly setLanguage: (language: Language) => void
}

const STORAGE_KEY = "portal.language"

const initialLanguage = (fallback: string): Language => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored !== null && isLanguage(stored)) return stored
  } catch {
    // A browser that refuses storage still gets a working portal.
  }
  return isLanguage(fallback) ? fallback : "it"
}

const I18nContext = createContext<I18n | undefined>(undefined)

export const LanguageProvider = ({
  defaultLanguage,
  children
}: {
  readonly defaultLanguage: string
  readonly children: ReactNode
}) => {
  const [language, setLanguageState] = useState<Language>(() => initialLanguage(defaultLanguage))
  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not remembering the choice is better than failing to apply it.
    }
    document.documentElement.lang = next
  }, [])
  const value = useMemo<I18n>(() => ({ language, setLanguage }), [language, setLanguage])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export const useI18n = (): I18n => {
  const value = useContext(I18nContext)
  if (value === undefined) throw new Error("useI18n used outside a LanguageProvider")
  return value
}

const fill = (template: string, values: Readonly<Record<string, string>> | undefined): string =>
  values === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)

/** The translate function for one dictionary, in the reader's language. */
export const useMessages = <K extends string>(dictionary: Messages<K>): Translate<K> => {
  const { language } = useI18n()
  return useCallback<Translate<K>>(
    (key, values) => fill(dictionary[language][key], values),
    [dictionary, language]
  )
}
