'use client';

import { useEffect, useState } from 'react';
import { Card, DataTable, PageLayout } from '@/components';
import type { DataTableColumn } from '@/components';
import { useAuth } from '@/auth/AuthProvider';
import { getCardsPort } from '@/services/registry';
import type { CardSummary, Money } from '@/services/cards/port';

const formatMoney = ({ amount, currency }: Money): string =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(
    amount,
  );

const COLUMNS: ReadonlyArray<DataTableColumn<CardSummary>> = [
  { id: 'label', header: 'Card', cell: (card) => card.label },
  { id: 'maskedPan', header: 'Number', cell: (card) => card.maskedPan },
  { id: 'kind', header: 'Type', cell: (card) => card.kind },
  { id: 'status', header: 'Status', cell: (card) => card.status },
  { id: 'balance', header: 'Balance', cell: (card) => formatMoney(card.balance) },
];

/**
 * Exemplar list page: loads rows through a port from the registry and renders
 * them with DataTable inside a Card. No fetch calls, no ad-hoc tables.
 */
export default function CardsPage() {
  const user = useAuth();
  const [cards, setCards] = useState<ReadonlyArray<CardSummary> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCardsPort()
      .listCards(user.customerId)
      .then((loaded) => {
        if (!cancelled) {
          setCards(loaded);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.customerId]);

  return (
    <PageLayout title="Your cards" subtitle="Payment cards on your account.">
      <Card>
        {cards === null ? (
          <p className="db-loading">Loading your cards…</p>
        ) : (
          <DataTable
            caption={`Cards for ${user.name}`}
            columns={COLUMNS}
            rows={cards}
            rowKey={(card) => card.id}
            emptyMessage="You have no cards yet."
          />
        )}
      </Card>
    </PageLayout>
  );
}
