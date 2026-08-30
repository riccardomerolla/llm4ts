// Mock adapter for CardsPort: deterministic fixture data plus a small
// artificial delay so pages exercise their loading states.

import type { CardsPort, CardsPortFactory, CardSummary } from './port';

const DELAY_MS = 20;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE_CARDS: ReadonlyArray<CardSummary> = [
  {
    id: 'card-001',
    label: 'Everyday Debit',
    maskedPan: '**** **** **** 4242',
    kind: 'debit',
    status: 'active',
    balance: { amount: 1245.5, currency: 'EUR' },
  },
  {
    id: 'card-002',
    label: 'Travel Credit',
    maskedPan: '**** **** **** 9310',
    kind: 'credit',
    status: 'active',
    balance: { amount: -320.75, currency: 'EUR' },
  },
  {
    id: 'card-003',
    label: 'Backup Debit',
    maskedPan: '**** **** **** 0007',
    kind: 'debit',
    status: 'blocked',
    balance: { amount: 0, currency: 'EUR' },
  },
];

export const makeMockCardsPort: CardsPortFactory = () => {
  const port: CardsPort = {
    async listCards(customerId) {
      await delay(DELAY_MS);
      // The fixture gateway knows a single customer; anyone else has no cards.
      return customerId === 'CUST-1001' ? FIXTURE_CARDS : [];
    },
  };
  return port;
};
