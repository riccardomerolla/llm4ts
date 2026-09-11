import { useEffect, useState } from "react"
import { profileDomain } from "../../contracts/profile.fake.ts"
import { ContactUpdate } from "../../contracts/profile.ts"
import { useAction, useLoad } from "../../kit/api.ts"
import { Field, KeyValues, Loading, Notice, Panel } from "../../kit/components.tsx"
import { dateText } from "../../kit/format.ts"
import { useI18n, useMessages } from "../../kit/i18n.tsx"
import { profiloMessages } from "./messages.ts"

/**
 * The exemplar feature. Every feature follows this shape: load through the
 * domain's typed client, render with kit components only, validate as a pure
 * function beside the screen, act through `useAction`, and read every string
 * from the feature's own dictionary.
 */
export const ProfiloScreen = () => {
  const t = useMessages(profiloMessages)
  const { language } = useI18n()
  const profile = useLoad(profileDomain, (client) => client.profile.current(), [])
  const { act, busy, message, tone } = useAction(profileDomain)
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (profile.data !== undefined) {
      setEmail(profile.data.email)
      setPhone(profile.data.phone)
    }
  }, [profile.data])

  if (profile.loading && profile.data === undefined) return <Loading />
  if (profile.data === undefined) return <Notice text={profile.error} tone="error" />

  const data = profile.data
  const errors = validateContact({ email, phone })
  const emailError = touched ? errors.email : undefined
  const phoneError = touched ? errors.phone : undefined

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTouched(true)
    if (errors.email !== undefined || errors.phone !== undefined) return
    const updated = await act(t("saveLabel"), (client) =>
      client.profile.updateContact({ payload: ContactUpdate.make({ email, phone }) })
    )
    if (updated !== undefined) profile.reload()
  }

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="muted">{t("explain")}</p>
      <div className="grid-2">
        <Panel title={t("personal")}>
          <KeyValues
            rows={[
              [t("name"), `${data.firstName} ${data.lastName}`],
              [t("taxCode"), <span className="mono">{data.taxCode}</span>],
              [t("customerSince"), dateText(data.customerSince, language)],
              [
                t("address"),
                `${data.address.street}, ${data.address.postalCode} ${data.address.city} (${data.address.province})`
              ]
            ]}
          />
        </Panel>
        <Panel title={t("contact")}>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <Field label={t("email")} {...(emailError === undefined ? {} : { error: t(emailError) })}>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={emailError !== undefined}
              />
            </Field>
            <Field label={t("phone")} {...(phoneError === undefined ? {} : { error: t(phoneError) })}>
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                aria-invalid={phoneError !== undefined}
              />
            </Field>
            <div className="panel-actions">
              <button type="submit" className="primary" disabled={busy}>
                {t("save")}
              </button>
            </div>
            <Notice text={message} tone={tone} />
          </form>
        </Panel>
      </div>
    </>
  )
}

export interface ContactErrors {
  readonly email?: "emailInvalid"
  readonly phone?: "phoneInvalid"
}

/** Validation is a pure function beside the screen; it returns message keys, not text. */
export const validateContact = (values: { readonly email: string; readonly phone: string }): ContactErrors => ({
  ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) ? {} : { email: "emailInvalid" }),
  ...((values.phone.match(/\d/g) ?? []).length >= 6 ? {} : { phone: "phoneInvalid" })
})
