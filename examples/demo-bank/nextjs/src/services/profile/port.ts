// ProfilePort: the typed contract pages program against.
// The wire shape is specified in contracts/profile.openapi.yaml; keep the two
// in sync when either changes.

export interface Profile {
  readonly customerId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
}

export interface ProfileUpdate {
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
}

export interface ProfilePort {
  getProfile(customerId: string): Promise<Profile>;
  updateProfile(customerId: string, update: ProfileUpdate): Promise<Profile>;
}

/** Adapters are created through a factory so wiring stays in the registry. */
export type ProfilePortFactory = () => ProfilePort;
