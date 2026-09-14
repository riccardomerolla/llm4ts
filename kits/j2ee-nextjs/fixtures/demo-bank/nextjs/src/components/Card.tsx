'use client';

import type { ReactNode } from 'react';

export interface CardProps {
  readonly title?: string;
  readonly children: ReactNode;
}

/** House surface. Every block of page content sits inside a Card. */
export function Card({ title, children }: CardProps) {
  return (
    <section className="db-card">
      {title !== undefined ? <h2 className="db-card-title">{title}</h2> : null}
      {children}
    </section>
  );
}
