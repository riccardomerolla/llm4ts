'use client';

import { useAuth } from '@/auth/AuthProvider';

/** Shows who is signed in (via the SSO stub) in the app shell header. */
export function SignedInBadge() {
  const user = useAuth();
  return <span className="db-shell-user">Signed in as {user.name}</span>;
}
