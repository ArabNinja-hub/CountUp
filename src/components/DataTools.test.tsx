// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { prepareLegacyBackupImport, prepareShopBackupImport } from '../services/backupImport';
import { DataTools } from './DataTools';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('./Toast', () => ({ useToast: () => ({ notify }) }));

const now = '2026-10-30T00:00:00.000Z';
const v1Backup = {
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

const v2Backup = {
  format: 'countup-backup-v2',
  version: '2.0',
  exportedAt: now,
  shop: { id: 'old-shop', name: 'Kabwata Store' },
  items: [
    {
      id: 'item_bread',
      name: 'Bread',
      buyingPrice: 10,
      buyingPriceKnown: true,
      sellingPrice: 12.5,
      quantity: 4,
      lowStockThreshold: 1,
      isDeleted: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  archivedItems: [],
  customers: [
    {
      id: 'cust_1',
      name: 'Mwamba',
      phone: '+260977111222',
      notes: '',
      totalOwed: 25,
      createdAt: now,
      updatedAt: now,
    },
  ],
  sales: [
    {
      id: 'sale_1',
      items: [
        {
          itemId: 'item_bread',
          name: 'Bread',
          quantity: 2,
          buyingPrice: 10,
          buyingPriceKnown: true,
          sellingPrice: 12.5,
          total: 25,
        },
      ],
      itemsCount: 2,
      totalAmount: 25,
      totalCost: 20,
      profit: 5,
      paymentType: 'credit',
      customerId: 'cust_1',
      receiptNumber: 'CU-01',
      createdAt: now,
    },
  ],
  creditPayments: [],
  expenses: [
    {
      id: 'exp_1',
      category: 'transport',
      amount: 15,
      note: 'Bus',
      createdAt: now,
    },
  ],
  stockMovements: [],
};

const previewShopBackup = vi.fn();
const restoreShopBackup = vi.fn();
const loadHistory = vi.fn();

function chooseFile(contents: string) {
  const file = new File([contents], 'backup.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) });
  fireEvent.change(screen.getByLabelText('Choose JSON backup file'), {
    target: { files: [file] },
  });
}

function mockShopState(overrides: Record<string, unknown> = {}) {
  vi.mocked(useShop).mockReturnValue({
    shop: { id: 'shop', name: 'My Shop' },
    items: [],
    archivedItems: [],
    sales: [],
    customers: [],
    creditPayments: [],
    expenses: [],
    stockMovements: [],
    previewShopBackup,
    restoreShopBackup,
    loadSyncResolutionHistory: loadHistory,
    isOnline: true,
    pendingSyncCount: 0,
    ...overrides,
  } as unknown as ReturnType<typeof useShop>);
}

beforeEach(() => {
  previewShopBackup.mockImplementation(async (raw: string) => {
    const prepared = prepareShopBackupImport(raw, 'shop');
    return {
      prepared,
      preview: prepared.preview,
      fileSha256: 'a'.repeat(64),
      shopHasExistingData: false,
      alreadyImported: false,
    };
  });
  restoreShopBackup.mockImplementation(async (raw: string) => {
    const prepared = prepareShopBackupImport(raw, 'shop');
    return {
      status: 'imported',
      idempotent: false,
      alreadyImported: false,
      preview: prepared.preview,
      imported: prepared,
    };
  });
  mockShopState();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Unified data tools & Phase 3c restore screen', () => {
  it('loads the original payment, owner-confirmed sync decision, and poison-discard audit history', async () => {
    loadHistory.mockResolvedValueOnce([
      {
        actionId: 'q1',
        kind: 'correct-payment',
        customerName: 'Mwamba',
        originalAmount: 8,
        correctedAmount: 4,
        serverBalanceBefore: 5,
        queuedAt: now,
        resolvedAt: now,
        originalPayment: { amount: 8, paymentMethod: 'momo', note: 'Original note' },
      },
      {
        actionId: 'q_poison',
        kind: 'discard-poison',
        customerName: 'Stock update',
        customerId: '',
        originalAmount: 0,
        serverBalanceBefore: 0,
        poisonActionType: 'stock_update',
        poisonSummary: 'Stock update on deleted item',
        poisonReason: 'Item not found on server',
        queuedAt: now,
        resolvedAt: now,
        resolvedBy: 'owner-1',
      },
    ]);
    render(<DataTools onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load sync review history' }));
    expect(await screen.findByText(/Payment amount corrected/)).toBeTruthy();
    expect(screen.getByText(/Original: K 8.00/).textContent).toContain('Recorded: K 4.00');
    expect(screen.getByText(/Original payment: Mobile Money/).textContent).toContain(
      'Original note'
    );
    expect(screen.getByText(/Blocked entry discarded · stock_update/)).toBeTruthy();
    expect(screen.getByText(/Stock update on deleted item/)).toBeTruthy();
  });

  it('previews and restores legacy v1 backup after confirmation without presenting a separate product', async () => {
    const raw = JSON.stringify(v1Backup);
    render(<DataTools onClose={vi.fn()} />);
    expect(screen.getByText('Restore from backup')).toBeTruthy();
    expect(screen.queryByText(/ShopBook/i)).toBeNull();
    chooseFile(raw);
    expect(await screen.findByText(/Backup preview · My Shop/)).toBeTruthy();
    expect(screen.getByText(/Earlier v1 JSON/)).toBeTruthy();
    // 4 boxes * K2.50 = K 10.00 stock value
    expect(screen.getByText('K 10.00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Review & confirm restore' }));
    expect(await screen.findByText('Confirm backup restore')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & restore backup' }));

    await waitFor(() =>
      expect(restoreShopBackup).toHaveBeenCalledWith(raw, { allowNonEmptyShop: false })
    );
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith('Backup records restored', expect.anything())
    );
    expect(prepareLegacyBackupImport(raw, 'shop').items[0].id).toBe('shopbook_tea');
  });

  it('previews countup-backup-v2 (counts, stock value, total owed) and blocks non-empty shop restore until explicitly opted in', async () => {
    const raw = JSON.stringify(v2Backup);
    previewShopBackup.mockImplementationOnce(async (text: string) => {
      const prepared = prepareShopBackupImport(text, 'shop');
      return {
        prepared,
        preview: prepared.preview,
        fileSha256: 'b'.repeat(64),
        shopHasExistingData: true,
        alreadyImported: false,
      };
    });

    render(<DataTools onClose={vi.fn()} />);
    chooseFile(raw);

    expect(await screen.findByText(/Backup preview · Kabwata Store/)).toBeTruthy();
    expect(screen.getByText(/CountUp v2 JSON/)).toBeTruthy();
    // Stock value: 4 * K12.50 = K 50.00; Total credit owed: K 25.00
    expect(screen.getByText('K 50.00')).toBeTruthy();
    expect(screen.getByText('K 25.00')).toBeTruthy();
    expect(screen.getByText(/This shop already has data/i)).toBeTruthy();

    const confirmTrigger = screen.getByRole('button', { name: 'Review & confirm restore' });
    expect((confirmTrigger as HTMLButtonElement).disabled).toBe(true);

    // Explicitly opt into non-empty shop restore
    fireEvent.click(
      screen.getByLabelText(
        /Allow importing into this non-empty shop without overwriting existing records/i
      )
    );
    expect((confirmTrigger as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirmTrigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm & restore backup' }));

    await waitFor(() =>
      expect(restoreShopBackup).toHaveBeenCalledWith(raw, { allowNonEmptyShop: true })
    );
  });

  it('blocks duplicate restore when preview reports alreadyImported and reports malformed backups cleanly', async () => {
    const raw = JSON.stringify(v2Backup);
    previewShopBackup.mockImplementationOnce(async (text: string) => {
      const prepared = prepareShopBackupImport(text, 'shop');
      return {
        prepared,
        preview: prepared.preview,
        fileSha256: 'c'.repeat(64),
        shopHasExistingData: false,
        alreadyImported: true,
      };
    });

    render(<DataTools onClose={vi.fn()} />);
    chooseFile(raw);
    expect(await screen.findByText(/already imported into this shop/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Review & confirm restore' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    // Malformed v2 file missing required collections/timestamp
    chooseFile(JSON.stringify({ format: 'countup-backup-v2' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Invalid backup/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/ShopBook/i);
  });
});
