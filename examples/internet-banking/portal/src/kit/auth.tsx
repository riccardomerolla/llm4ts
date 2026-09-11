import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react"
import { useMessages } from "./i18n.tsx"
import { kitMessages } from "./messages.ts"

/** The signed-in retail customer. Features consume this; they never implement sign-in. */
export interface Customer {
  readonly customerId: string
  readonly name: string
  /** Bearer token attached to every API call. A fixed value in the demonstration. */
  readonly token: string
}

export interface AuthState {
  readonly customer: Customer
  readonly signOut: () => void
}

/** The one fictitious customer of the demonstration. Fixture data keys off `customerId`. */
export const DEMO_CUSTOMER: Customer = {
  customerId: "C-000123",
  name: "Giulia Bianchi",
  token: "demo-token-C-000123"
}

const STORAGE_KEY = "portal.signedIn"

const AuthContext = createContext<AuthState | undefined>(undefined)

/**
 * OIDC-shaped sign-in in front of every screen. The demonstration has no
 * identity provider: one button signs the fixed customer in, and the choice
 * survives a reload. Replacing this with a real provider changes this file
 * only; `useAuth` keeps its shape.
 */
export const AuthProvider = ({
  children,
  customer
}: {
  readonly children: ReactNode
  /** A customer already signed in — for tests and previews. */
  readonly customer?: Customer
}) => {
  const t = useMessages(kitMessages)
  const [signedIn, setSignedIn] = useState<boolean>(() => {
    if (customer !== undefined) return true
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "1"
    } catch {
      return false
    }
  })
  const signIn = useCallback(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, "1")
    } catch {
      // Storage refused: the session lives in memory only.
    }
    setSignedIn(true)
  }, [])
  const signOut = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
    setSignedIn(false)
  }, [])
  const current = customer ?? DEMO_CUSTOMER
  const state = useMemo<AuthState>(() => ({ customer: current, signOut }), [current, signOut])
  if (!signedIn) {
    return (
      <div className="login">
        <h1>{t("auth.signIn")}</h1>
        <p className="muted">{t("auth.explain")}</p>
        <button type="button" className="primary" onClick={signIn}>
          {t("auth.continue", { name: current.name })}
        </button>
      </div>
    )
  }
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>
}

export const useAuth = (): AuthState => {
  const value = useContext(AuthContext)
  if (value === undefined) throw new Error("useAuth used outside a signed-in AuthProvider")
  return value
}
