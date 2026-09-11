import { feature } from "../../kit/navigation.tsx"
import { profiloMessages } from "./messages.ts"
import { ProfiloScreen } from "./ProfiloScreen.tsx"

export const profiloFeature = feature({
  id: "profilo",
  nav: { it: profiloMessages.it.nav, en: profiloMessages.en.nav },
  screen: ProfiloScreen
})
