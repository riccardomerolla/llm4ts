import { feature } from "../../kit/navigation.tsx"
import { HomeScreen } from "./HomeScreen.tsx"
import { homeMessages } from "./messages.ts"

export const homeFeature = feature({
  id: "home",
  nav: { it: homeMessages.it.nav, en: homeMessages.en.nav },
  screen: HomeScreen
})
