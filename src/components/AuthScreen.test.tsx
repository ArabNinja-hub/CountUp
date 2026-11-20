// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { translations } from '../i18n/translations';
import { AuthScreen } from './AuthScreen';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));

const sendPhoneVerificationCode = vi.fn();
const verifyPhoneVerificationCode = vi.fn();
const completeShopRegistration = vi.fn();
const unlockCloudShopWithPin = vi.fn();
const recoverCloudShopPin = vi.fn();
const unlockLocalScreen = vi.fn();
const loginAsAdmin = vi.fn();
const resetEmailPassword = vi.fn();
const logout = vi.fn();

beforeEach(() => {
  vi.mocked(useShop).mockReturnValue({
    shop: null,
    isScreenLocked: false,
    isOnline: true,
    t: translations.en,
    language: 'en',
    setLanguage: vi.fn(),
    isLoading: false,
    sendPhoneVerificationCode,
    verifyPhoneVerificationCode,
    completeShopRegistration,
    unlockCloudShopWithPin,
    recoverCloudShopPin,
    unlockLocalScreen,
    loginAsAdmin,
    resetEmailPassword,
    cancelEmailLogin: vi.fn(),
    logout,
  } as unknown as ReturnType<typeof useShop>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Shop and admin sign in (Supabase SMS OTP + PIN + Recovery)', () => {
  it('verifies phone via SMS OTP, registers a new shop with 4-digit PIN, and opens help', async () => {
    const help = vi.fn();
    sendPhoneVerificationCode.mockResolvedValueOnce({ phoneE164: '+260977123456' });
    verifyPhoneVerificationCode.mockResolvedValueOnce({
      hasShop: false,
      sessionVerified: false,
      isLockedOut: false,
      lockedUntil: null,
    });
    completeShopRegistration.mockResolvedValueOnce({
      recoveryCode: 'CU-ABCD-EFGH-JKLM',
      trialGranted: true,
    });

    render(<AuthScreen onOpenHelp={help} onAdminSignedIn={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Create your shop' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Help' }));
    expect(help).toHaveBeenCalledOnce();

    fireEvent.change(screen.getByLabelText('Phone Number'), { target: { value: '0977 123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS code' }));

    await waitFor(() =>
      expect(sendPhoneVerificationCode).toHaveBeenCalledWith('0977 123 456', undefined)
    );

    fireEvent.change(screen.getByLabelText('6-digit SMS code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify SMS code' }));

    await waitFor(() =>
      expect(verifyPhoneVerificationCode).toHaveBeenCalledWith('+260977123456', '123456')
    );

    expect(screen.getByRole('heading', { name: 'Set up your shop & PIN' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Shop / Kiosk Name'), {
      target: { value: 'Bwino Kiosk' },
    });
    fireEvent.change(screen.getByLabelText('Choose 4-Digit PIN'), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText('Repeat 4-Digit PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: translations.en.registerBtn }));

    await waitFor(() =>
      expect(completeShopRegistration).toHaveBeenCalledWith('Bwino Kiosk', '1234')
    );
  });

  it('requires PIN after SMS OTP for an existing shop and supports one-time recovery code unlock', async () => {
    sendPhoneVerificationCode.mockResolvedValueOnce({ phoneE164: '+260966111222' });
    verifyPhoneVerificationCode.mockResolvedValueOnce({
      hasShop: true,
      sessionVerified: false,
      isLockedOut: false,
      lockedUntil: null,
    });
    unlockCloudShopWithPin.mockRejectedValueOnce(
      new Error('Incorrect PIN. Check your 4-digit PIN.')
    );
    recoverCloudShopPin.mockResolvedValueOnce({ recoveryCode: 'CU-ZZZZ-YYYY-XXXX' });

    render(<AuthScreen onOpenHelp={vi.fn()} onAdminSignedIn={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: translations.en.logInBtn }));
    expect(screen.getByRole('heading', { name: 'Sign in to your shop' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Phone Number'), { target: { value: '0966111222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS code' }));
    await screen.findByLabelText('6-digit SMS code');

    fireEvent.change(screen.getByLabelText('6-digit SMS code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify SMS code' }));
    await screen.findByRole('heading', { name: 'Enter your shop PIN' });

    fireEvent.change(screen.getByLabelText('4-Digit PIN'), { target: { value: '0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open my shop' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Incorrect PIN/));

    fireEvent.click(
      screen.getByRole('button', { name: /Forgot PIN or locked out\? Use recovery code/i })
    );
    expect(screen.getByRole('heading', { name: 'Recover shop PIN' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('One-time recovery code'), {
      target: { value: 'cu-abcd-efgh-jklm' },
    });
    fireEvent.change(screen.getByLabelText('New 4-Digit PIN'), { target: { value: '4321' } });
    fireEvent.change(screen.getByLabelText('Repeat New PIN'), { target: { value: '4321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset PIN & open shop' }));

    await waitFor(() =>
      expect(recoverCloudShopPin).toHaveBeenCalledWith('CU-ABCD-EFGH-JKLM', '4321')
    );
  });

  it('unlocks an already-open shop offline on the same device with escalating lockout feedback', async () => {
    unlockLocalScreen
      .mockResolvedValueOnce({ unlocked: false, lockedOut: true, remainingLockoutMs: 30_000 })
      .mockResolvedValueOnce({ unlocked: true, lockedOut: false, remainingLockoutMs: 0 });

    vi.mocked(useShop).mockReturnValue({
      shop: { id: 'shop-uuid-1', name: 'Matero Mart', ownerPhone: '+260977123456' },
      isScreenLocked: true,
      isOnline: false,
      t: translations.en,
      language: 'en',
      setLanguage: vi.fn(),
      unlockLocalScreen,
      logout,
    } as unknown as ReturnType<typeof useShop>);

    render(<AuthScreen onOpenHelp={vi.fn()} onAdminSignedIn={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Unlock Matero Mart' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('4-Digit PIN'), { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock shop' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Wait 30 seconds/i));

    fireEvent.change(screen.getByLabelText('4-Digit PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock shop' }));
    await waitFor(() => expect(unlockLocalScreen).toHaveBeenCalledWith('1234'));
  });

  it('does not open the admin console on a rejected account, and opens it after verification', async () => {
    const onSignedIn = vi.fn();
    loginAsAdmin.mockRejectedValueOnce(new Error('This account does not have admin access.'));
    loginAsAdmin.mockResolvedValueOnce(undefined);
    render(<AuthScreen onOpenHelp={vi.fn()} onAdminSignedIn={onSignedIn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Admin sign in' }));
    expect(screen.getByRole('heading', { name: 'Admin sign in' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Account email'), {
      target: { value: 'admin@example.com' },
    });
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
    fireEvent.change(screen.getByLabelText('Account email'), {
      target: { value: 'admin@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/reset link/));
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
