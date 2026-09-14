'use client';

import { Card, PageLayout, Stepper } from '@/components';
import { useAuth } from '@/auth/AuthProvider';

/** Landing page: greets the stubbed SSO user and shows the house Stepper. */
export default function HomePage() {
  const user = useAuth();
  return (
    <PageLayout
      title={`Welcome back, ${user.name}`}
      subtitle="Your everyday banking, in one place."
    >
      <Card title="Getting started">
        <Stepper
          steps={['Review your cards', 'Check your profile', 'Explore']}
          activeIndex={0}
        />
        <p>
          Use the navigation above to review your payment cards or update your
          contact details.
        </p>
      </Card>
    </PageLayout>
  );
}
