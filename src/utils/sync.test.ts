import { describe, expect, it } from 'vitest';
import {
  cleanForFirestore,
  reconcile,
  replayQueuedWrites,
  rebaseQueuedProjections,
  isTransientSyncError,
  PendingSyncAction,
} from './sync';

interface Doc {
  id: string;
  name?: string;
}

const SHOP = 'shops/shop_0962838581';
const ITEMS = `${SHOP}/items`;
const SALES = `${SHOP}/sales`;

const doc = (id: string, name?: string): Doc => ({ id, name });

describe('replayQueuedWrites', () => {
  it('rebuilds creates and ordered patches after an interrupted cache update', () => {
    const cached = [doc('old', 'Before')];
    const queue = [
      {
        path: `${ITEMS}/new`,
        writes: [
          { path: `${ITEMS}/new`, data: { id: 'new', name: 'New item' } },
          { path: `${ITEMS}/old`, data: { name: 'Updated' } },
          { path: `${SALES}/ignored`, data: { id: 'ignored' } },
        ],
      },
      { path: `${ITEMS}/new`, data: { name: 'Renamed' } },
      { path: `${ITEMS}/missing`, data: { name: 'partial without a cached record' } },
    ];
    expect(replayQueuedWrites(cached, queue, ITEMS)).toEqual([
      doc('old', 'Updated'),
      doc('new', 'Renamed'),
    ]);
  });
});

describe('reconcile', () => {
  it('returns the server snapshot untouched when nothing is queued', () => {
    const remote = [doc('a'), doc('b')];
    const local = [doc('a'), doc('b'), doc('c')];

    const result = reconcile(remote, local, [], ITEMS);

    // Same reference: no pointless re-render when the queue is empty.
    expect(result).toBe(remote);
    expect(result.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('keeps a queued document that has not reached the server yet', () => {
    const remote = [doc('a')];
    const local = [doc('a'), doc('b')];
    const queue = [{ path: `${ITEMS}/b` }];

    expect(reconcile(remote, local, queue, ITEMS).map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('does not duplicate a queued document that already exists on the server', () => {
    const remote = [doc('a', 'server')];
    const local = [doc('a', 'local')];
    const queue = [{ path: `${ITEMS}/a` }];

    const result = reconcile(remote, local, queue, ITEMS);

    expect(result).toBe(remote);
    expect(result).toHaveLength(1);
    // Server value wins once the document is there.
    expect(result[0].name).toBe('server');
  });

  it('applies server deletions even when a local copy is still cached', () => {
    const remote: Doc[] = [];
    const local = [doc('gone')];

    expect(reconcile(remote, local, [], ITEMS)).toEqual([]);
  });

  it('ignores queue entries that belong to another collection', () => {
    const remote = [doc('a')];
    const local = [doc('a'), doc('sale-1')];
    const queue = [{ path: `${SALES}/sale-1` }];

    const result = reconcile(remote, local, queue, ITEMS);

    expect(result).toBe(remote);
    expect(result.map((d) => d.id)).toEqual(['a']);
  });

  it('does not treat a similarly named collection as the same one', () => {
    const remote: Doc[] = [];
    const local = [doc('x')];
    // `items_archive/x` must not be matched by the prefix `items/`.
    const queue = [{ path: `${ITEMS}_archive/x` }];

    expect(reconcile(remote, local, queue, ITEMS)).toEqual([]);
  });

  it('keeps several queued documents in their original order, after server rows', () => {
    const remote = [doc('a')];
    const local = [doc('b'), doc('a'), doc('c')];
    const queue = [{ path: `${ITEMS}/b` }, { path: `${ITEMS}/c` }];

    expect(reconcile(remote, local, queue, ITEMS).map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a queued document that no longer exists locally', () => {
    const remote = [doc('a')];
    const local = [doc('a')];
    const queue = [{ path: `${ITEMS}/deleted-locally` }];

    expect(reconcile(remote, local, queue, ITEMS).map((d) => d.id)).toEqual(['a']);
  });

  it('keeps pending grouped edits visible and hides pending deletes', () => {
    const remote = [doc('a', 'old'), doc('b', 'removed')];
    const local = [doc('a', 'new')];
    const queue = [
      {
        path: `${ITEMS}/a`,
        writes: [
          { path: `${ITEMS}/a`, data: { name: 'new' } },
          { path: `${ITEMS}/b`, data: { isDeleted: true } },
        ],
      },
    ];
    expect(reconcile(remote, local, queue, ITEMS)).toEqual([doc('a', 'new')]);
  });

  it('removes undefined optional fields before sending Firestore documents', () => {
    expect(
      cleanForFirestore({ value: 1, optional: undefined, nested: { note: undefined, name: 'ok' } })
    ).toEqual({ value: 1, nested: { name: 'ok' } });
  });

  it('works with a deeper or different collection path', () => {
    const payments = `${SHOP}/credit_payments`;
    const remote = [doc('p1')];
    const local = [doc('p1'), doc('p2')];

    expect(
      reconcile(remote, local, [{ path: `${payments}/p2` }], payments).map((d) => d.id)
    ).toEqual(['p1', 'p2']);
  });
});

describe('rebase after an explicitly reviewed sync conflict', () => {
  it('recalculates only pending previews, never changes the original deltas or partial metadata patches', () => {
    const customer = `${SHOP}/customers/a`;
    const queue: PendingSyncAction[] = [
      {
        id: 'sale',
        type: 'sale',
        path: `${SALES}/s`,
        data: { id: 's' },
        timestamp: 1,
        writes: [
          { path: `${SALES}/s`, data: { id: 's', totalAmount: 2 } },
          { path: customer, data: { id: 'a', totalOwed: 4 } },
        ],
        adjustments: [{ kind: 'credit', path: customer, deltaNgwee: 200, updatedAt: 'then' }],
      },
      {
        id: 'payment',
        type: 'payment',
        path: `${SHOP}/credit_payments/p`,
        data: { id: 'p', amount: 2 },
        timestamp: 2,
        writes: [
          { path: `${SHOP}/credit_payments/p`, data: { id: 'p', amount: 2 } },
          { path: customer, data: { id: 'a', totalOwed: 2 } },
        ],
        adjustments: [{ kind: 'credit', path: customer, deltaNgwee: -200, updatedAt: 'then' }],
      },
      {
        id: 'edit',
        type: 'customer',
        path: customer,
        data: { name: 'Renamed' },
        timestamp: 3,
        writes: [{ path: customer, data: { name: 'Renamed' } }],
      },
    ];
    const before = JSON.stringify(queue);
    const result = rebaseQueuedProjections(queue, [
      { path: customer, data: { id: 'a', name: 'Server', totalOwed: 1 } },
    ]);
    expect(result.queue[0].writes?.[1].data).toMatchObject({ totalOwed: 3 });
    expect(result.queue[1].writes?.[1].data).toMatchObject({ totalOwed: 1 });
    expect(result.queue[1].writes?.[0].data).toEqual({ id: 'p', amount: 2 });
    expect(result.queue[2].writes?.[0].data).toEqual({ name: 'Renamed' });
    expect(result.documents.find((entry) => entry.path === customer)?.data).toMatchObject({
      totalOwed: 1,
      name: 'Renamed',
    });
    expect(JSON.stringify(queue)).toBe(before);
    expect(result.queue[1].adjustments?.[0]).toMatchObject({ deltaNgwee: -200 });
  });

  it('keeps a later overpayment intact and previews a stale recount without overwriting stock', () => {
    const customer = `${SHOP}/customers/a`;
    const item = `${ITEMS}/a`;
    const movement = `${SHOP}/stock_movements/m`;
    const queue: PendingSyncAction[] = [
      {
        id: 'pay',
        type: 'payment',
        path: `${SHOP}/credit_payments/p`,
        data: { id: 'p', amount: 3 },
        timestamp: 1,
        writes: [
          { path: `${SHOP}/credit_payments/p`, data: { id: 'p', amount: 3 } },
          { path: customer, data: { id: 'a', totalOwed: 0 } },
        ],
        adjustments: [{ kind: 'credit', path: customer, deltaNgwee: -300, updatedAt: 'then' }],
      },
      {
        id: 'count',
        type: 'stock_update',
        path: item,
        data: { id: 'a', quantity: 12 },
        timestamp: 2,
        writes: [
          { path: item, data: { id: 'a', quantity: 12 } },
          { path: movement, data: { id: 'm' } },
        ],
        adjustments: [
          {
            kind: 'stock',
            path: item,
            delta: 2,
            setTo: 12,
            updatedAt: 'then',
            movement: {
              path: movement,
              data: {
                id: 'm',
                shopId: 'shop_0962838581',
                itemId: 'a',
                itemName: 'Tea',
                type: 'adjustment',
                delta: 2,
                previousQuantity: 10,
                newQuantity: 12,
                reason: 'count',
                createdAt: 'then',
              },
            },
          },
        ],
      },
    ];
    const result = rebaseQueuedProjections(queue, [
      { path: customer, data: { id: 'a', totalOwed: 1 } },
      { path: item, data: { id: 'a', quantity: 8 } },
    ]);
    expect(result.documents.find((entry) => entry.path === customer)?.data?.totalOwed).toBe(0);
    expect(result.queue[0].writes?.[0].data).toEqual({ id: 'p', amount: 3 });
    expect(result.queue[0].adjustments?.[0]).toMatchObject({ deltaNgwee: -300 });
    expect(result.documents.find((entry) => entry.path === item)?.data?.quantity).toBe(8);
    expect(result.documents.find((entry) => entry.path === movement)?.data).toMatchObject({
      recountNeeded: true,
      requestedQuantity: 12,
      delta: 0,
    });
  });
});

it('only identifies transient Firebase failures as automatic-retry candidates', () => {
  expect(isTransientSyncError({ code: 'unavailable' })).toBe(true);
  expect(isTransientSyncError({ code: 'auth/network-request-failed' })).toBe(true);
  expect(isTransientSyncError({ code: 'permission-denied' })).toBe(false);
  expect(isTransientSyncError(new Error('A financial conflict'))).toBe(false);
});
