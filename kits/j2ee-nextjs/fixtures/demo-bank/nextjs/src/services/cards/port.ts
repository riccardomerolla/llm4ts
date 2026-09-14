// CardsPort: the typed contract pages program against.
// The wire shape is specified in contracts/cards.openapi.yaml; keep the two
// in sync when either changes.

export interface Money {
  /** Minor units are NOT used; amount is a decimal number of major units. */
  readonly amount: number;
  /** ISO 4217 code, e.g. "EUR". */
  readonly currency: string;
}

export type CardKind = 'debit' | 'credit';

export type CardStatus = 'active' | 'blocked';

export interface CardSummary {
  readonly id: string;
  readonly label: string;
  /** Masked PAN, e.g. "**** **** **** 4242". */
  readonly maskedPan: string;
  readonly kind: CardKind;
  readonly status: CardStatus;
  readonly balance: Money;
}

export interface CardsPort {
  listCards(customerId: string): Promise<ReadonlyArray<CardSummary>>;
}

/** Adapters are created through a factory so wiring stays in the registry. */
export type CardsPortFactory = () => CardsPort;
