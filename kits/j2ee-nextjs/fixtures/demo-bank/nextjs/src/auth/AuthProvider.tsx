'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

export interface AuthUser {
  readonly name: string;
  readonly customerId: string;
}

/**
 * SSO stub. In production the shell exchanges the gateway session for a
 * profile; here a fixed user is always signed in. Pages consume useAuth()
 * and NEVER implement login, token handling, or redirects themselves.
 */
const DEMO_USER: AuthUser = {
  name: 'Ada Doe',
  customerId: 'CUST-1001',
};

const AuthContext = createContext<AuthUser | null>(null);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  return (
    <AuthContext.Provider value={DEMO_USER}>{children}</AuthContext.Provider>
  );
}

/** Current signed-in user. Throws when rendered outside the app shell. */
export function useAuth(): AuthUser {
  const user = useContext(AuthContext);
  if (user === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return user;
}
