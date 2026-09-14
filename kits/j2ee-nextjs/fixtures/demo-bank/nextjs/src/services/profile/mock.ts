// Mock adapter for ProfilePort: deterministic fixture data plus a small
// artificial delay so pages exercise their loading states. Updates are kept
// in memory for the lifetime of the adapter.

import type { Profile, ProfilePort, ProfilePortFactory } from './port';

const DELAY_MS = 20;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE_PROFILE: Profile = {
  customerId: 'CUST-1001',
  fullName: 'Ada Doe',
  email: 'ada.doe@example.invalid',
  phone: '+00 555 0100',
};

export const makeMockProfilePort: ProfilePortFactory = () => {
  const profiles = new Map<string, Profile>([
    [FIXTURE_PROFILE.customerId, FIXTURE_PROFILE],
  ]);

  const port: ProfilePort = {
    async getProfile(customerId) {
      await delay(DELAY_MS);
      const profile = profiles.get(customerId);
      if (profile === undefined) {
        throw new Error(`Unknown customer: ${customerId}`);
      }
      return profile;
    },
    async updateProfile(customerId, update) {
      await delay(DELAY_MS);
      const current = profiles.get(customerId);
      if (current === undefined) {
        throw new Error(`Unknown customer: ${customerId}`);
      }
      const next: Profile = { customerId: current.customerId, ...update };
      profiles.set(customerId, next);
      return next;
    },
  };
  return port;
};
