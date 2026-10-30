// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { prepareLegacyBackupImport } from '../services/backupImport';
import { DataTools } from './DataTools';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('./Toast', () => ({ useToast: () => ({ notify }) }));

const now = '2026-10-30T00:00:00.000Z';
const backup = {
  format: 'shopbook-backup-v1',
  exportedAt: now,
  shopSettings: { shopName: 'My Shop' },
  products: [
    {
      id: 'tea',
      name: 'Tea',
      unitLabel: 'box',
      sellingPriceNgwee: 250,
      costPriceNgwee: 100,
      stockQty: 4,
      lowStockThreshold: 1,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  sales: [],
  saleItems: [],
  stockMovements: [],
  customers: [],
  creditTransactions: [],
};
const importBackup = vi.fn();

function chooseFile(contents: string) {
  const file = new File([contents], 'backup.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) });
  fireEvent.change(screen.getByLabelText('Choose legacy JSON backup'), {
    target: { files: [file] },
  });
}

beforeEach(() => {
  vi.mocked(useShop).mockReturnValue({
    shop: { id: 'shop', name: 'My Shop' },
    items: [],
    archivedItems: [],
    sales: [],
    customers: [],
    creditPayments: [],
    stockMovements: [],
    importLegacyBackup: importBackup,
    isOnline: true,
    pendingSyncCount: 0,
  } as unknown as ReturnType<typeof useShop>);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Unified data tools', () => {
  it('previews and imports supported legacy data without presenting a separate product', async () => {
    const raw = JSON.stringify(backup);
    importBackup.mockResolvedValueOnce(prepareLegacyBackupImport(raw, 'shop'));
    render(<DataTools onClose={vi.fn()} />);
    expect(screen.getByText('Import an earlier backup')).toBeTruthy();
    expect(
      screen.getByText(/current CountUp JSON export is not yet supported for restore/i)
    ).toBeTruthy();
    expect(screen.queryByText(/ShopBook/i)).toBeNull();
    chooseFile(raw);
    expect(await screen.findByText('Ready to import from My Shop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add these records to CountUp' }));
    await waitFor(() => expect(importBackup).toHaveBeenCalledWith(raw));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Backup records imported', expect.anything())
    );
    // Keep the existing namespaced IDs for duplicate checks and already-imported records.
    expect(prepareLegacyBackupImport(raw, 'shop').items[0].id).toBe('shopbook_tea');
  });

  it('reports an unsupported file without referring to a separate product', async () => {
    render(<DataTools onClose={vi.fn()} />);
    chooseFile(JSON.stringify({ format: 'countup-backup-v2' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid backup/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/ShopBook/i);
  });
});
