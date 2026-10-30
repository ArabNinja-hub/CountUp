// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { useShop } from './context/ShopContext';

vi.mock('./context/ShopContext', () => ({
  useShop: vi.fn(),
  ShopProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/Toast', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ notify: vi.fn() }),
}));
vi.mock('./components/AuthScreen', () => ({
  AuthScreen: ({
    onOpenHelp,
    onAdminSignedIn,
  }: {
    onOpenHelp: () => void;
    onAdminSignedIn: () => void;
  }) => (
    <div>
      <h1>Shop sign in</h1>
      <button onClick={onOpenHelp}>Help before sign in</button>
      <button onClick={onAdminSignedIn}>Verified admin sign in</button>
    </div>
  ),
}));
vi.mock('./components/Header', () => ({
  Header: ({ onOpenHelp }: { onOpenHelp: () => void }) => (
    <button onClick={onOpenHelp}>Help in shop</button>
  ),
}));
vi.mock('./components/AdminScreen', () => ({
  AdminScreen: ({ onBack, exitLabel }: { onBack: () => void; exitLabel: string }) => (
    <div>
      <h1>Admin console</h1>
      <button onClick={onBack}>{exitLabel}</button>
    </div>
  ),
}));
vi.mock('./components/HomeScreen', () => ({ HomeScreen: () => <h1>Shop home</h1> }));
vi.mock('./components/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('./components/Navigation', () => ({ Navigation: () => null }));
vi.mock('./components/OfflineNotice', () => ({ OfflineNotice: () => null }));
vi.mock('./components/SellScreen', () => ({ SellScreen: () => null }));
vi.mock('./components/StockScreen', () => ({ StockScreen: () => null }));
vi.mock('./components/CreditBookScreen', () => ({ CreditBookScreen: () => null }));
vi.mock('./components/ReportsScreen', () => ({ ReportsScreen: () => null }));
vi.mock('./components/PlanScreen', () => ({ PlanScreen: () => null }));
vi.mock('./components/LegalPages', () => ({ LegalPages: () => null }));

const cancelEmailLogin = vi.fn();
const state = () =>
  ({
    shop: null,
    user: { uid: 'ordinary-user', isAnonymous: false, email: 'person@example.com' },
    isAdmin: false,
    isOnline: true,
    cancelEmailLogin,
    activeTab: 'home',
    setActiveTab: vi.fn(),
    isLoading: false,
    sales: [],
    items: [],
    archivedItems: [],
    stockMovements: [],
    stockConflicts: [],
    customers: [],
    creditPayments: [],
    expenses: [],
    subscription: {},
  }) as unknown as ReturnType<typeof useShop>;

beforeEach(() => {
  cancelEmailLogin.mockResolvedValue(undefined);
  vi.mocked(useShop).mockReturnValue(state());
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Admin authorization and guide routing', () => {
  it('keeps the shop mounted but inaccessible during deletion so a failure can be shown', () => {
    const current = { ...state(), shop: { id: 'shop', name: 'My Shop' } } as ReturnType<
      typeof useShop
    >;
    vi.mocked(useShop).mockReturnValue(current);
    const view = render(<App />);
    const header = screen.getByText('Help in shop');
    vi.mocked(useShop).mockReturnValue({ ...current, isLoading: true });
    view.rerender(<App />);
    expect(screen.getByText(/Deleting shop and data/i)).toBeTruthy();
    expect(screen.getByText('Help in shop')).toBe(header);
    expect(header.closest('[inert]')).toBeTruthy();
    vi.mocked(useShop).mockReturnValue(current);
    view.rerender(<App />);
    expect(screen.queryByText(/Deleting shop and data/i)).toBeNull();
    expect(screen.getByText('Help in shop')).toBe(header);
    expect(header.closest('[inert]')).toBeNull();
  });

  it('does not open or arm the admin console from an event sent by a non-admin', () => {
    const ordinary = { ...state(), shop: { id: 'shop', name: 'My Shop' } } as ReturnType<
      typeof useShop
    >;
    vi.mocked(useShop).mockReturnValue(ordinary);
    const view = render(<App />);
    expect(screen.getByRole('heading', { name: 'Shop home' })).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent('open-admin')));
    expect(screen.queryByRole('heading', { name: 'Admin console' })).toBeNull();
    vi.mocked(useShop).mockReturnValue({ ...ordinary, isAdmin: true });
    view.rerender(<App />);
    expect(screen.queryByRole('heading', { name: 'Admin console' })).toBeNull();
    act(() => window.dispatchEvent(new CustomEvent('open-admin')));
    expect(screen.getByRole('heading', { name: 'Admin console' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Exit admin' }));
    expect(screen.getByRole('heading', { name: 'Shop home' })).toBeTruthy();
    expect(cancelEmailLogin).not.toHaveBeenCalled();
  });

  it('does not auto-open for a persisted admin identity, but opens after sign-in and signs out on exit', async () => {
    vi.mocked(useShop).mockReturnValue({
      ...state(),
      user: { uid: 'admin', isAnonymous: true, email: null },
      isAdmin: true,
    } as ReturnType<typeof useShop>);
    const view = render(<App />);
    expect(screen.getByRole('heading', { name: 'Shop sign in' })).toBeTruthy();
    act(() => window.dispatchEvent(new CustomEvent('open-admin')));
    expect(screen.queryByRole('heading', { name: 'Admin console' })).toBeNull();
    vi.mocked(useShop).mockReturnValue({
      ...state(),
      user: { uid: 'admin', isAnonymous: false, email: 'admin@example.com' },
      isAdmin: true,
    } as ReturnType<typeof useShop>);
    view.rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Verified admin sign in' }));
    expect(screen.getByRole('heading', { name: 'Admin console' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(cancelEmailLogin).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Shop sign in' })).toBeTruthy());
  });

  it('requires the admin grant at render time and offers the guide before and after login', () => {
    const view = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Help before sign in' }));
    expect(screen.getByRole('dialog', { name: 'How to use CountUp' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close guide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verified admin sign in' }));
    expect(screen.queryByRole('heading', { name: 'Admin console' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Admin access unavailable' })).toBeTruthy();

    vi.mocked(useShop).mockReturnValue({
      ...state(),
      shop: { id: 'shop', name: 'My Shop' },
    } as ReturnType<typeof useShop>);
    view.rerender(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Help in shop' }));
    expect(screen.getByRole('dialog', { name: 'How to use CountUp' })).toBeTruthy();
  });
});
