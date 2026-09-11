import { createContext, type ReactNode, useContext, useEffect } from "react"

/** Portal configuration from Vite environment variables, one bank per build. */
export interface PortalConfig {
  readonly bankName: string
  readonly brandColor: string
  /** Language the portal opens in when the reader has not chosen one. */
  readonly defaultLanguage: string
  /** Base URL of the real service API; unused while `transport` is "fake". */
  readonly apiUrl: string
  /**
   * "fake": every domain's contract is answered in memory by its fake routes
   * (the client-only default). "http": the same contracts over the network.
   */
  readonly transport: "fake" | "http"
}

const read = (env: Readonly<Record<string, string | undefined>>, key: string, fallback: string): string =>
  env[key] ?? fallback

export const portalConfig = (env: Readonly<Record<string, string | undefined>>): PortalConfig => ({
  bankName: read(env, "VITE_BANK_NAME", "Banca Demo"),
  brandColor: read(env, "VITE_BRAND_COLOR", "#20623B"),
  defaultLanguage: read(env, "VITE_LOCALE", "it"),
  apiUrl: read(env, "VITE_API_URL", "http://127.0.0.1:4200"),
  transport: read(env, "VITE_TRANSPORT", "fake") === "http" ? "http" : "fake"
})

const ConfigContext = createContext<PortalConfig>(portalConfig({}))

/** Holds the configuration and paints the brand token, so `theme.css` restyles per bank. */
export const ConfigProvider = ({ config, children }: { readonly config: PortalConfig; readonly children: ReactNode }) => {
  useEffect(() => {
    document.documentElement.style.setProperty("--brand", config.brandColor)
  }, [config.brandColor])
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>
}

export const useConfig = (): PortalConfig => useContext(ConfigContext)
