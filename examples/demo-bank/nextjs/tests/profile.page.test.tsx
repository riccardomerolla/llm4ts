// House test style for form pages: swap the registry for an instrumented
// port, render inside AuthProvider, assert the fields render, validation
// fires, and the port receives the expected payload on save.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuthProvider } from '@/auth/AuthProvider';
import type { Profile, ProfileUpdate } from '@/services/profile/port';
import ProfilePage from '@/app/profile/page';

const { getProfile, updateProfile } = vi.hoisted(() => ({
  getProfile: vi.fn<(customerId: string) => Promise<Profile>>(),
  updateProfile:
    vi.fn<(customerId: string, update: ProfileUpdate) => Promise<Profile>>(),
}));

vi.mock('@/services/registry', () => ({
  getProfilePort: () => ({ getProfile, updateProfile }),
}));

const FIXTURE_PROFILE: Profile = {
  customerId: 'CUST-1001',
  fullName: 'Ada Doe',
  email: 'ada.doe@example.invalid',
  phone: '+00 555 0100',
};

const renderPage = () =>
  render(
    <AuthProvider>
      <ProfilePage />
    </AuthProvider>,
  );

describe('ProfilePage', () => {
  beforeEach(() => {
    getProfile.mockReset();
    updateProfile.mockReset();
    getProfile.mockResolvedValue(FIXTURE_PROFILE);
    updateProfile.mockImplementation(async (customerId, update) => ({
      customerId,
      ...update,
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the profile fields with values from the port', async () => {
    renderPage();

    expect(await screen.findByLabelText('Full name')).toBeDefined();
    expect(screen.getByLabelText('Email')).toBeDefined();
    expect(screen.getByLabelText('Phone')).toBeDefined();
    expect(screen.getByDisplayValue('Ada Doe')).toBeDefined();
    expect(screen.getByDisplayValue('ada.doe@example.invalid')).toBeDefined();
    expect(getProfile).toHaveBeenCalledWith('CUST-1001');
  });

  it('fires validation and does not call the port on invalid input', async () => {
    renderPage();
    const email = await screen.findByLabelText('Email');

    fireEvent.change(email, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeDefined();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('saves through the port with the expected payload', async () => {
    renderPage();
    const fullName = await screen.findByLabelText('Full name');

    fireEvent.change(fullName, { target: { value: 'Ada Q. Doe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Profile saved.')).toBeDefined();
    expect(updateProfile).toHaveBeenCalledTimes(1);
    expect(updateProfile).toHaveBeenCalledWith('CUST-1001', {
      fullName: 'Ada Q. Doe',
      email: 'ada.doe@example.invalid',
      phone: '+00 555 0100',
    });
  });
});
