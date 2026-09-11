// The Profile domain contract: what the portal asks of the service API about
// the signed-in customer. The contract is the source of truth — the fake
// transport answers it in memory (`profile.fake.ts`), a real backend
// implements it, and `pnpm openapi` renders it into contracts/openapi/.
import * as Schema from "effect/Schema"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"

export class Address extends Schema.Class<Address>("Address")({
  street: Schema.String,
  postalCode: Schema.String,
  city: Schema.String,
  province: Schema.String,
  country: Schema.String
}) {}

export class CustomerProfile extends Schema.Class<CustomerProfile>("CustomerProfile")({
  customerId: Schema.String,
  firstName: Schema.String,
  lastName: Schema.String,
  /** Italian codice fiscale. */
  taxCode: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  address: Address,
  /** ISO date the customer relationship began. */
  customerSince: Schema.String
}) {}

export class ContactUpdate extends Schema.Class<ContactUpdate>("ContactUpdate")({
  email: Schema.String,
  phone: Schema.String
}) {}

const profile = HttpApiGroup.make("profile").add(
  HttpApiEndpoint.get("current", "/profile", {
    success: CustomerProfile,
    error: HttpApiError.NotFound
  }),
  HttpApiEndpoint.post("updateContact", "/profile/contact", {
    payload: ContactUpdate,
    success: CustomerProfile,
    error: [HttpApiError.NotFound, HttpApiError.UnprocessableEntity]
  })
)

export const ProfileApi = HttpApi.make("Profile").add(profile)
