import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

// Tests live next to the code they cover (`src/**/*.test.ts(x)`), so a
// feature's tests sit inside its own directory — inside its story's
// perimeter (CONTRIBUTING.md).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"]
  }
})
