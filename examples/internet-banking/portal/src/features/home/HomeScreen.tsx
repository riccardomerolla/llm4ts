import { useAuth } from "../../kit/auth.tsx"
import { Panel } from "../../kit/components.tsx"
import { useMessages } from "../../kit/i18n.tsx"
import { homeMessages } from "./messages.ts"

/** The placeholder home. An epic's fan-in story replaces this with the dashboard. */
export const HomeScreen = () => {
  const t = useMessages(homeMessages)
  const { customer } = useAuth()
  return (
    <>
      <h1>{t("title", { name: customer.name.split(" ")[0] ?? customer.name })}</h1>
      <Panel title={t("nav")}>
        <p className="muted">{t("explain")}</p>
      </Panel>
    </>
  )
}
