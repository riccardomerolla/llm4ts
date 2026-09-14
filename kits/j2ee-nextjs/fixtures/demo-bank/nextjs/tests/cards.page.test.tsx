// House test style for list pages: swap the registry for an instrumented
// port, render inside AuthProvider, assert rows render and the port was
// called with the signed-in customer's id.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { AuthProvider } from '@/auth/AuthProvider';
import type { CardSummary } from '@/services/cards/port';
import CardsPage from '@/app/cards/page';

const { listCards } = vi.hoisted(() => ({
  listCards:
    vi.fn<(customerId: string) => Promise<ReadonlyArray<CardSummary>>>(),
}));

vi.mock('@/services/registry', () => ({
  getCardsPort: () => ({ listCards }),
}));

const FIXTURE_CARDS: ReadonlyArray<CardSummary> = [
  {
    id: 'card-100',
    label: 'Test Debit',
    maskedPan: '**** **** **** 1111',
    kind: 'debit',
    status: 'active',
    balance: { amount: 10, currency: 'EUR' },
  },
  {
    id: 'card-200',
    label: 'Test Credit',
    maskedPan: '**** **** **** 2222',
    kind: 'credit',
    status: 'blocked',
    balance: { amount: -5, currency: 'EUR' },
  },
];

const renderPage = () =>
  render(
    <AuthProvider>
      <CardsPage />
    </AuthProvider>,
  );

describe('CardsPage', () => {
  beforeEach(() => {
    listCards.mockReset();
    listCards.mockResolvedValue(FIXTURE_CARDS);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a loading state, then one row per card from the port', async () => {
    renderPage();
    expect(screen.getByText('Loading your cards…')).toBeDefined();

    expect(await screen.findByText('Test Debit')).toBeDefined();
    expect(screen.getByText('Test Credit')).toBeDefined();
    expect(screen.getByText('**** **** **** 1111')).toBeDefined();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 cards
  });

  it('asks the port for the signed-in customer', async () => {
    renderPage();
    await screen.findByText('Test Debit');

    expect(listCards).toHaveBeenCalledTimes(1);
    expect(listCards).toHaveBeenCalledWith('CUST-1001');
  });

  it('shows the empty state when the port returns no cards', async () => {
    listCards.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('You have no cards yet.')).toBeDefined();
  });
});
