'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Field, Form, PageLayout } from '@/components';
import type { ValidationErrors } from '@/components';
import { useAuth } from '@/auth/AuthProvider';
import { getProfilePort } from '@/services/registry';
import type { Profile, ProfileUpdate } from '@/services/profile/port';

type ProfileFormValues = ProfileUpdate;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateProfile = (
  values: ProfileFormValues,
): ValidationErrors<ProfileFormValues> => {
  const errors: {
    fullName?: string;
    email?: string;
    phone?: string;
  } = {};
  if (values.fullName.trim().length === 0) {
    errors.fullName = 'Full name is required.';
  }
  if (values.email.trim().length === 0) {
    errors.email = 'Email is required.';
  } else if (!EMAIL_PATTERN.test(values.email)) {
    errors.email = 'Enter a valid email address.';
  }
  if (values.phone.trim().length === 0) {
    errors.phone = 'Phone number is required.';
  }
  return errors;
};

/**
 * Exemplar form page: loads via ProfilePort, edits with Form + Field, saves
 * through the port. Validation lives in a pure function next to the page.
 */
export default function ProfilePage() {
  const user = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getProfilePort()
      .getProfile(user.customerId)
      .then((loaded) => {
        if (!cancelled) {
          setProfile(loaded);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user.customerId]);

  const handleSubmit = async (values: ProfileFormValues): Promise<void> => {
    setSaved(false);
    const updated = await getProfilePort().updateProfile(
      user.customerId,
      values,
    );
    setProfile(updated);
    setSaved(true);
  };

  return (
    <PageLayout title="Your profile" subtitle="Contact details we hold for you.">
      <Card title="Contact details">
        {profile === null ? (
          <p className="db-loading">Loading your profile…</p>
        ) : (
          <Form<ProfileFormValues>
            initialValues={{
              fullName: profile.fullName,
              email: profile.email,
              phone: profile.phone,
            }}
            validate={validateProfile}
            onSubmit={handleSubmit}
          >
            {({ values, errors, setValue, submitting }) => (
              <>
                <Field id="fullName" label="Full name" error={errors.fullName}>
                  <input
                    id="fullName"
                    name="fullName"
                    value={values.fullName}
                    onChange={(event) =>
                      setValue('fullName', event.target.value)
                    }
                  />
                </Field>
                <Field id="email" label="Email" error={errors.email}>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    value={values.email}
                    onChange={(event) => setValue('email', event.target.value)}
                  />
                </Field>
                <Field id="phone" label="Phone" error={errors.phone}>
                  <input
                    id="phone"
                    name="phone"
                    type="tel"
                    value={values.phone}
                    onChange={(event) => setValue('phone', event.target.value)}
                  />
                </Field>
                <div className="db-form-actions">
                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Saving…' : 'Save changes'}
                  </Button>
                </div>
                {saved ? (
                  <p
                    className="db-form-status db-form-status--success"
                    role="status"
                  >
                    Profile saved.
                  </p>
                ) : null}
              </>
            )}
          </Form>
        )}
      </Card>
    </PageLayout>
  );
}
