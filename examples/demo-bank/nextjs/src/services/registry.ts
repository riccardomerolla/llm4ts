// Service registry: the single place adapters are wired to ports.
// Pages obtain ports ONLY through these getters — never by importing an
// adapter directly. Swapping the mock for a real gateway adapter is a
// one-line change per domain (replace the makeMock* factory).

import { makeMockCardsPort } from './cards/mock';
import type { CardsPort } from './cards/port';
import { makeMockProfilePort } from './profile/mock';
import type { ProfilePort } from './profile/port';

const cardsPort: CardsPort = makeMockCardsPort();
const profilePort: ProfilePort = makeMockProfilePort();

export function getCardsPort(): CardsPort {
  return cardsPort;
}

export function getProfilePort(): ProfilePort {
  return profilePort;
}
