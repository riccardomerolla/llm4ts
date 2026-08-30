import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/auth/AuthProvider';
import { SignedInBadge } from './signed-in-badge';
import '@/theme/tokens.css';
import '@/theme/components.css';

export const metadata: Metadata = {
  title: 'DemoBank',
  description: 'DemoBank online banking (synthetic fixture)',
};

/**
 * App shell: brand, primary navigation, signed-in user. The layout stays a
 * server component; everything interactive lives in client components.
 */
export default function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <header className="db-shell-header">
            <span className="db-shell-brand">DemoBank</span>
            <nav className="db-shell-nav" aria-label="Primary">
              <Link href="/">Home</Link>
              <Link href="/cards">Cards</Link>
              <Link href="/profile">Profile</Link>
            </nav>
            <SignedInBadge />
          </header>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
