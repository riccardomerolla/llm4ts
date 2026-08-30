'use client';

import type { ReactNode } from 'react';

export interface PageLayoutProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Page-level actions (Buttons), rendered top-right of the header. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

/**
 * House page frame: heading, optional subtitle and actions, then content.
 * Every page renders exactly one PageLayout at its root.
 */
export function PageLayout({
  title,
  subtitle,
  actions,
  children,
}: PageLayoutProps) {
  return (
    <main className="db-page">
      <header className="db-page-header">
        <div>
          <h1 className="db-page-title">{title}</h1>
          {subtitle !== undefined ? (
            <p className="db-page-subtitle">{subtitle}</p>
          ) : null}
        </div>
        {actions !== undefined ? (
          <div className="db-page-actions">{actions}</div>
        ) : null}
      </header>
      {children}
    </main>
  );
}
