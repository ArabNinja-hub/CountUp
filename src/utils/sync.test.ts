import { describe, expect, it } from 'vitest';
import { reconcile } from './sync';

interface Doc {
  id: string;
  name?: string;
}

const SHOP = 'shops/shop_0962838581';
const ITEMS = `${SHOP}/items`;
const SALES = `${SHOP}/sales`;

const doc = (id: string, name?: string): Doc => ({ id, name });

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

  it('works with a deeper or different collection path', () => {
    const payments = `${SHOP}/credit_payments`;
    const remote = [doc('p1')];
    const local = [doc('p1'), doc('p2')];

    expect(
      reconcile(remote, local, [{ path: `${payments}/p2` }], payments).map((d) => d.id)
    ).toEqual(['p1', 'p2']);
  });
});
