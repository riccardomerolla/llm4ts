// Fake routes for the Profile contract: deterministic fixture data and an
// in-memory store that lives as long as the page, so an update is visible on
// the next read. No randomness, no clocks: tests depend on that.
import { HttpApiClient } from "effect/unstable/httpapi"
import { domain } from "../kit/api.ts"
import { notFound, unprocessable, type FakeRoutes } from "../kit/fake-transport.ts"
import { ProfileApi } from "./profile.ts"

interface ProfileRecord {
  customerId: string
  firstName: string
  lastName: string
  taxCode: string
  email: string
  phone: string
  address: {
    street: string
    postalCode: string
    city: string
    province: string
    country: string
  }
  customerSince: string
}

const initial = (): ProfileRecord => ({
  customerId: "C-000123",
  firstName: "Giulia",
  lastName: "Bianchi",
  taxCode: "BNCGLI85M41F205X",
  email: "giulia.bianchi@example.invalid",
  phone: "+39 333 000 0123",
  address: {
    street: "Via Roma 12",
    postalCode: "20121",
    city: "Milano",
    province: "MI",
    country: "IT"
  },
  customerSince: "2016-03-14"
})

/** The page-lifetime store. `resetProfileFake` returns it to the fixture for tests. */
let store: ProfileRecord = initial()

export const resetProfileFake = (): void => {
  store = initial()
}

const isContactUpdate = (body: unknown): body is { email: string; phone: string } =>
  typeof body === "object" &&
  body !== null &&
  "email" in body &&
  typeof body.email === "string" &&
  "phone" in body &&
  typeof body.phone === "string"

export const profileRoutes: FakeRoutes = [
  {
    method: "GET",
    path: "/profile",
    handle: () => (store.customerId === "C-000123" ? { body: store } : notFound())
  },
  {
    method: "POST",
    path: "/profile/contact",
    handle: ({ body }) => {
      if (!isContactUpdate(body) || !body.email.includes("@") || body.phone.trim().length < 6) {
        return unprocessable()
      }
      store = { ...store, email: body.email.trim(), phone: body.phone.trim() }
      return { body: store }
    }
  }
]

/** What features import: the fake routes plus the typed client over any transport. */
export const profileDomain = domain(profileRoutes, (httpClient, baseUrl) =>
  HttpApiClient.makeWith(ProfileApi, { httpClient, baseUrl })
)
