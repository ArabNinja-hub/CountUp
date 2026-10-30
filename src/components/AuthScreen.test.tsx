// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { AuthScreen } from './AuthScreen';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));

const loginAsAdmin = vi.fn();
const registerNewShop = vi.fn();
const resetEmailPassword = vi.fn();
beforeEach(() => {
  vi.mocked(useShop).mockReturnValue({
    t: translations.en,
    language: 'en',
    setLanguage: vi.fn(),
    isLoading: false,
    loginWithPhoneAndPin: vi.fn(),
    registerNewShop,
    loginAsAdmin,
    resetEmailPassword,
    loginWithEmail: vi.fn(),
    cancelEmailLogin: vi.fn(),
    selectEmailShop: vi.fn(),
  } as unknown as ReturnType<typeof useShop>);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Shop and admin sign in', () => {
  it('shows clear shop actions, validates and creates a shop, and opens help', async () => {
    const help = vi.fn();
    registerNewShop.mockResolvedValueOnce(true);
    render(<AuthScreen onOpenHelp={help} onAdminSignedIn={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Create your shop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(help).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Shop / Kiosk Name'), {
      target: { value: 'Bwino Kiosk' },
    });
    fireEvent.change(screen.getByLabelText('Phone Number'), { target: { value: '0977 123 456' } });
    fireEvent.change(screen.getByLabelText('4-Digit PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create shop' }));
    await waitFor(() =>
      expect(registerNewShop).toHaveBeenCalledWith('Bwino Kiosk', '0977123456', '1234')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.getByRole('heading', { name: 'Log in to your shop' })).toBeTruthy();
    expect(screen.queryByLabelText('Shop / Kiosk Name')).toBeNull();
    expect(screen.getByRole('button', { name: 'Email sign in' })).toBeTruthy();
  });

  it('does not open the admin console on a rejected account, and opens it after verification', async () => {
    const onSignedIn = vi.fn();
    loginAsAdmin.mockRejectedValueOnce(new Error('This account does not have admin access.'));
    loginAsAdmin.mockResolvedValueOnce(undefined);
    render(<AuthScreen onOpenHelp={vi.fn()} onAdminSignedIn={onSignedIn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Admin sign in' }));
    expect(screen.getByRole('heading', { name: 'Admin sign in' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open admin console' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/does not have admin access/)
    );
    expect(onSignedIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open admin console' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    expect(loginAsAdmin).toHaveBeenCalledWith('admin@example.com', 'password123');
  });

  it('supports password recovery and shows actionable connection errors', async () => {
    resetEmailPassword.mockResolvedValueOnce(undefined);
    loginAsAdmin.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { code: 'unavailable' })
    );
    render(<AuthScreen onOpenHelp={vi.fn()} onAdminSignedIn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Admin sign in' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/inbox/));
    expect(resetEmailPassword).toHaveBeenCalledWith('admin@example.com');
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open admin console' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/internet connection/)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to shop sign in' }));
    expect(screen.getByRole('heading', { name: 'Create your shop' })).toBeTruthy();
  });

  it('opens the requested legal page', () => {
    render(<AuthScreen onOpenHelp={vi.fn()} onAdminSignedIn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terms' }));
    expect(
      screen.getByRole('tab', { name: 'Terms of Service' }).getAttribute('aria-selected')
    ).toBe('true');
  });
});
