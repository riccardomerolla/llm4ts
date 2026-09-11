// House test style: render the screen inside the kit providers against the
// domain's own fake transport (no mocking), then assert in both languages
// that the fields render, validation blocks a bad submit, and a good submit
// reaches the fake and is visible on reload.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetProfileFake } from "../../contracts/profile.fake.ts"
import { AuthProvider, DEMO_CUSTOMER } from "../../kit/auth.tsx"
import { ConfigProvider, portalConfig } from "../../kit/config.tsx"
import { LanguageProvider } from "../../kit/i18n.tsx"
import { ProfiloScreen, validateContact } from "./ProfiloScreen.tsx"

const renderScreen = (language: "it" | "en") =>
  render(
    <ConfigProvider config={portalConfig({ VITE_TRANSPORT: "fake" })}>
      <LanguageProvider defaultLanguage={language}>
        <AuthProvider customer={DEMO_CUSTOMER}>
          <ProfiloScreen />
        </AuthProvider>
      </LanguageProvider>
    </ConfigProvider>
  )

describe("ProfiloScreen", () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetProfileFake()
  })
  afterEach(() => {
    cleanup()
  })

  it("renders the customer's details from the fake transport, in Italian by default", async () => {
    renderScreen("it")
    expect(await screen.findByText("Il tuo profilo")).toBeDefined()
    expect(screen.getByText("Giulia Bianchi")).toBeDefined()
    expect(screen.getByText("BNCGLI85M41F205X")).toBeDefined()
    expect(screen.getByText("14/03/2016")).toBeDefined()
    expect(screen.getByLabelText("Email")).toHaveProperty("value", "giulia.bianchi@example.invalid")
  })

  it("renders the same screen in English", async () => {
    renderScreen("en")
    expect(await screen.findByText("Your profile")).toBeDefined()
    expect(screen.getByText("Customer since")).toBeDefined()
    expect(screen.getByText("14 Mar 2016")).toBeDefined()
  })

  it("validation fires and blocks the fake on bad input; a good update is saved", async () => {
    renderScreen("it")
    const email = await screen.findByLabelText("Email")
    fireEvent.change(email, { target: { value: "not-an-email" } })
    fireEvent.click(screen.getByText("Salva i recapiti"))
    expect(await screen.findByText("Inserisci un indirizzo email valido.")).toBeDefined()

    fireEvent.change(email, { target: { value: "giulia@example.invalid" } })
    fireEvent.click(screen.getByText("Salva i recapiti"))
    expect(await screen.findByText("Aggiornamento recapiti: eseguita")).toBeDefined()
    await waitFor(() =>
      expect(screen.getByLabelText("Email")).toHaveProperty("value", "giulia@example.invalid")
    )
  })

  it("validateContact is a pure function returning message keys", () => {
    expect(validateContact({ email: "a@b.co", phone: "+39 333 1234" })).toEqual({})
    expect(validateContact({ email: "nope", phone: "12" })).toEqual({
      email: "emailInvalid",
      phone: "phoneInvalid"
    })
  })
})
