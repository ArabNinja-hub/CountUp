// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useShop } from '../context/ShopContext';
import { StockTools } from './StockTools';

vi.mock('../context/ShopContext', () => ({ useShop: vi.fn() }));
vi.mock('./Toast', () => ({ useToast: () => ({ notify: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('explains a stale count separately from a stock shortfall', () => {
  vi.mocked(useShop).mockReturnValue({
    stockMovements: [],
    stockConflicts: [
      {
        id: 'c1',
        itemName: 'Tea',
        kind: 'recount',
        observed: 10,
        requested: 12,
        available: 8,
        shortfall: 0,
        resolved: false,
      },
      { id: 'c2', itemName: 'Sugar', requested: 5, available: 3, shortfall: 2, resolved: false },
    ],
    resolveStockConflict: vi.fn(),
    adjustStock: vi.fn(),
  } as unknown as ReturnType<typeof useShop>);
  render(<StockTools adjustingItem={null} onCloseAdjustment={vi.fn()} />);
  expect(screen.getByText(/Tea: the count of 12 was not applied/i).textContent).toMatch(
    /changed from 10 to 8/i
  );
  expect(screen.getByText(/Sugar: 2 units short/i).textContent).toMatch(/requested 5, had 3/i);
});
