import { createContext, type ComponentType, type ReactNode, useContext } from "react"
import type { Language } from "./i18n.tsx"

/**
 * A feature as the shell sees it: an id, a nav label in both languages, and
 * the screen. Each feature exports one from `route.tsx`; `App.tsx` lists
 * them — the single composition point, owned by exactly one story per epic.
 */
export interface Feature {
  readonly id: string
  readonly nav: Readonly<Record<Language, string>>
  readonly screen: ComponentType
}

export const feature = (definition: Feature): Feature => definition

export interface Navigation {
  readonly current: string
  readonly navigate: (id: string) => void
}

const NavigationContext = createContext<Navigation>({ current: "", navigate: () => {} })

export const NavigationProvider = ({
  value,
  children
}: {
  readonly value: Navigation
  readonly children: ReactNode
}) => <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>

/** Move to another feature by id, e.g. from the home page to the transfer form. */
export const useNavigate = (): ((id: string) => void) => useContext(NavigationContext).navigate
