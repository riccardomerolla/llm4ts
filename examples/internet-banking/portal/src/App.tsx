// The single composition point: the list of features, in navigation order.
// Exactly one story per epic owns this file (CONTRIBUTING.md).
import { useMemo, useState } from "react"
import { homeFeature } from "./features/home/route.tsx"
import { profiloFeature } from "./features/profilo/route.tsx"
import { Shell, type NavItem } from "./kit/components.tsx"
import { useI18n } from "./kit/i18n.tsx"
import { NavigationProvider, type Feature } from "./kit/navigation.tsx"

const FEATURES: ReadonlyArray<Feature> = [homeFeature, profiloFeature]

export const App = () => {
  const { language } = useI18n()
  const [current, setCurrent] = useState<string>(FEATURES[0]?.id ?? "")
  const items: ReadonlyArray<NavItem> = useMemo(
    () => FEATURES.map((item) => ({ id: item.id, label: item.nav[language] })),
    [language]
  )
  const active = FEATURES.find((item) => item.id === current) ?? FEATURES[0]
  const Screen = active?.screen
  return (
    <NavigationProvider value={{ current, navigate: setCurrent }}>
      <Shell items={items} current={current} onSelect={setCurrent}>
        {Screen === undefined ? null : <Screen />}
      </Shell>
    </NavigationProvider>
  )
}
