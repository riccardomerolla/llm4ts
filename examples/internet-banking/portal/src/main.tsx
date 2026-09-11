import "./kit/theme.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { AuthProvider } from "./kit/auth.tsx"
import { ConfigProvider, portalConfig } from "./kit/config.tsx"
import { LanguageProvider } from "./kit/i18n.tsx"

const config = portalConfig(import.meta.env)
const root = document.getElementById("root")
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <ConfigProvider config={config}>
        <LanguageProvider defaultLanguage={config.defaultLanguage}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </LanguageProvider>
      </ConfigProvider>
    </StrictMode>
  )
}
