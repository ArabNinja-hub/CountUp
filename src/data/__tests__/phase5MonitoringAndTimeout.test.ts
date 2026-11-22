import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBackupImportChunks, prepareShopBackupImport } from '../../services/backupImport';
import { createTestSupabaseDb, type TestIdentity } from './supabaseTestHarness';

describe('Pre-5 Check #1 & Phase 5 Monitoring RPCs on PostgreSQL 17 (PGlite)', () => {
  let ctx: Awaited<ReturnType<typeof createTestSupabaseDb>>;
  let ownerA: TestIdentity;
  let ownerB: TestIdentity;
  let adminAal1: TestIdentity;
  let adminAal2: TestIdentity;
  let shopAId: string;
  let shopBId: string;

  beforeAll(async () => {
    ctx = await createTestSupabaseDb();

    adminAal2 = await ctx.createAuthUser({
      email: 'admin-p5-mfa@countup.zm',
      emailVerified: true,
      aal: 'aal2',
      appMetadata: { platform_admin: true },
    });
    adminAal1 = await ctx.createAuthUser({
      email: 'admin-p5-nomfa@countup.zm',
      emailVerified: true,
      aal: 'aal1',
      appMetadata: { platform_admin: true },
    });

    shopAId = randomUUID();
    shopBId = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    ownerA = await ctx.createAuthUser({
      phone: '+260977500001',
      sessionId: sessionA,
      appMetadata: { shop_id: shopAId },
    });
    ownerB = await ctx.createAuthUser({
      phone: '+260977500002',
      sessionId: sessionB,
      appMetadata: { shop_id: shopBId },
    });

    await ctx.asServiceRole(async (tx) => {
      for (const [shopId, owner, sessionId, name, phone] of [
        [shopAId, ownerA, sessionA, 'Phase 5 Shop A', '+260977500001'],
        [shopBId, ownerB, sessionB, 'Phase 5 Shop B', '+260977500002'],
      ] as const) {
        await tx.query(
          `INSERT INTO public.shops (
             id, owner_user_id, name, owner_phone, plan_status, plan_type,
             trial_ends_at, plan_expiry_at, sales_access_until
           ) VALUES (
             $1, $2, $3, $4, 'active', 'monthly',
             now() + interval '20 days', now() + interval '20 days', now() + interval '23 days'
           )`,
          [shopId, owner.id, name, phone]
        );
        await tx.query(
          `INSERT INTO public.shop_verified_sessions (session_id, user_id, shop_id)
           VALUES ($1, $2, $3)`,
          [sessionId, owner.id, shopId]
        );
      }
    });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('validates per-sale math incrementally during append_shop_backup_chunk and finalizes without statement_timeout overrides', async () => {
    // 1. Corrupt sale total is caught immediately during append_shop_backup_chunk (not deferred to finalize)
    const beginBad = await ctx.asUser(ownerA, async (tx) => {
      const res = await tx.query<{ begin_shop_backup_import: { session_id: string } }>(
        `SELECT public.begin_shop_backup_import($1::uuid, 'p5_bad_chunk', repeat('1', 64), 'countup-backup-v2', 1024, 1, 'Bad Math Shop', false)`,
        [shopAId]
      );
      return res.rows[0].begin_shop_backup_import;
    });

    await expect(
      ctx.asUser(ownerA, (tx) =>
        tx.query(
          `SELECT public.append_shop_backup_chunk($1::uuid, $2::uuid, 0, 'sales', $3::jsonb)`,
          [
            shopAId,
            beginBad.session_id,
            JSON.stringify([
              {
                id: 'bad_sale_1',
                receiptNumber: 'R-BAD-1',
                itemsCount: 1,
                items: [
                  {
                    itemId: 'i1',
                    name: 'Sugar 2kg',
                    unitLabel: 'pack',
                    quantity: 1,
                    buyingPrice: 40,
                    buyingPriceKnown: true,
                    sellingPrice: 55,
                    total: 55,
                  },
                ],
                totalAmount: 99, // Mismatched total!
                totalCost: 40,
                profit: 15,
                missingCostRevenue: 0,
                paymentType: 'cash',
                localDate: '2026-10-01',
                createdAt: '2026-10-01T10:00:00.000Z',
              },
            ]),
          ]
        )
      )
    ).rejects.toThrow(/totals or profit that do not match their items|BACKUP_SALE_TOTAL_MISMATCH/i);

    // 2. Valid multi-chunk import stages normalized ngwee rows and finalizes fast under default statement_timeout
    const rawBackup = JSON.stringify({
      format: 'countup-backup-v2',
      exportedAt: '2026-10-02T10:00:00.000Z',
      shop: { name: 'Fast Incremental Shop' },
      items: [
        {
          id: 'item_sugar',
          name: 'Sugar 2kg',
          buyingPrice: 42,
          buyingPriceKnown: true,
          sellingPrice: 55,
          unitLabel: 'pack',
          quantity: 18,
          lowStockThreshold: 5,
          createdAt: '2026-10-01T08:00:00.000Z',
        },
      ],
      sales: [
        {
          id: 'sale_ok_1',
          receiptNumber: 'R-OK-1',
          itemsCount: 2,
          items: [
            {
              itemId: 'item_sugar',
              name: 'Sugar 2kg',
              unitLabel: 'pack',
              quantity: 2,
              buyingPrice: 42,
              buyingPriceKnown: true,
              sellingPrice: 55,
              total: 110,
            },
          ],
          totalAmount: 110,
          totalCost: 84,
          profit: 26,
          paymentType: 'cash',
          createdAt: '2026-10-01T10:00:00.000Z',
        },
      ],
      customers: [],
      creditPayments: [],
      expenses: [],
      stockMovements: [],
    });

    const prepared = prepareShopBackupImport(rawBackup, shopBId);
    const chunks = buildBackupImportChunks(prepared);

    const beginOk = await ctx.asUser(ownerB, async (tx) => {
      const res = await tx.query<{ begin_shop_backup_import: { session_id: string } }>(
        `SELECT public.begin_shop_backup_import($1::uuid, 'p5_fast_ok', repeat('2', 64), $2, $3, $4, 'Fast Incremental Shop', false)`,
        [shopBId, prepared.format, Buffer.byteLength(rawBackup, 'utf8'), chunks.length]
      );
      return res.rows[0].begin_shop_backup_import;
    });

    await ctx.asUser(ownerB, async (tx) => {
      for (const chunk of chunks) {
        await tx.query(
          `SELECT public.append_shop_backup_chunk($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
          [
            shopBId,
            beginOk.session_id,
            chunk.chunkIndex,
            chunk.section,
            JSON.stringify(chunk.records),
          ]
        );
      }
    });

    const t0 = performance.now();
    const finalized = await ctx.asUser(ownerB, async (tx) => {
      const res = await tx.query<{
        finalize_shop_backup_import: {
          status: string;
          reconciliation: { total_differences: number };
        };
      }>(`SELECT public.finalize_shop_backup_import($1::uuid, $2::uuid, false)`, [
        shopBId,
        beginOk.session_id,
      ]);
      return res.rows[0].finalize_shop_backup_import;
    });
    const elapsedMs = performance.now() - t0;

    expect(finalized.status).toBe('imported');
    expect(finalized.reconciliation.total_differences).toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('persists sync_failure, client_error (rate-limited 15/hr/shop), and reconcile_diff alerts, and enforces aal2 on resolve_platform_alert', async () => {
    // 1. Unexpected apply_sync_batch halt persists a sync_failure alert
    const haltRes = await ctx.asUser(ownerA, async (tx) => {
      const res = await tx.query<{
        apply_sync_batch: { results: Array<{ operation_id: string; ok: boolean }> };
      }>(`SELECT public.apply_sync_batch($1::uuid, $2::jsonb)`, [
        shopAId,
        JSON.stringify([{ operation_id: 'bad_sync_1', rpc: 'unsupported_rpc_name' }]),
      ]);
      return res.rows[0].apply_sync_batch;
    });
    expect(haltRes.results[0].ok).toBe(false);

    const alertsAfterSyncFail = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ id: string; category: string; resolved_at: string | null }>(
        `SELECT id, category, resolved_at FROM public.platform_alerts WHERE alert_key = $1`,
        [`sync_fail:${shopAId}:bad_sync_1`]
      );
      return res.rows;
    });
    expect(alertsAfterSyncFail).toHaveLength(1);
    expect(alertsAfterSyncFail[0].category).toBe('sync_failure');
    expect(alertsAfterSyncFail[0].resolved_at).toBeNull();

    // 2. report_client_sync_alert enforces 15/hour/shop rate limit (note: 1 sync_failure already exists for shopAId)
    let recordedCount = 0;
    let rateLimitedCount = 0;
    for (let i = 0; i < 16; i++) {
      const rep = await ctx.asUser(ownerA, async (tx) => {
        const res = await tx.query<{
          report_client_sync_alert: { recorded: boolean; status: string };
        }>(
          `SELECT public.report_client_sync_alert($1::uuid, 'client_error', $2, 'Runtime error', 'Redacted stack trace', '{}'::jsonb)`,
          [shopAId, `ui_err_${i}`]
        );
        return res.rows[0].report_client_sync_alert;
      });
      if (rep.recorded) recordedCount += 1;
      if (rep.status === 'rate_limited') rateLimitedCount += 1;
    }
    expect(recordedCount).toBe(14); // 1 sync_failure + 14 client_error = 15/hour/shop cap!
    expect(rateLimitedCount).toBe(2);

    // 3. Global reconcile_shop_ledger(NULL) persists critical reconcile_diff alert on drift & auto-resolves when clean
    await ctx.asServiceRole(async (tx) => {
      await tx.query(
        `INSERT INTO public.customers (shop_id, id, name, total_owed_ngwee) VALUES ($1, 'drift_cust', 'Drift Customer', 5000)`,
        [shopAId]
      );
    });

    const driftReport = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ reconcile_shop_ledger: { total_differences: number } }>(
        `SELECT public.reconcile_shop_ledger(NULL)`
      );
      return res.rows[0].reconcile_shop_ledger;
    });
    expect(driftReport.total_differences).toBeGreaterThan(0);

    const driftAlert = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ severity: string; resolved_at: string | null }>(
        `SELECT severity, resolved_at FROM public.platform_alerts WHERE alert_key = 'reconcile_diff:ledger'`
      );
      return res.rows[0];
    });
    expect(driftAlert.severity).toBe('critical');
    expect(driftAlert.resolved_at).toBeNull();

    // Fix the synthetic customer drift -> global reconcile auto-resolves reconcile_diff:ledger
    await ctx.asServiceRole(async (tx) => {
      await tx.query(`DELETE FROM public.customers WHERE shop_id = $1 AND id = 'drift_cust'`, [
        shopAId,
      ]);
    });

    const cleanReport = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ reconcile_shop_ledger: { total_differences: number } }>(
        `SELECT public.reconcile_shop_ledger(NULL)`
      );
      return res.rows[0].reconcile_shop_ledger;
    });
    expect(cleanReport.total_differences).toBe(0);

    const autoResolvedAlert = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ resolved_at: string | null }>(
        `SELECT resolved_at FROM public.platform_alerts WHERE alert_key = 'reconcile_diff:ledger'`
      );
      return res.rows[0];
    });
    expect(autoResolvedAlert.resolved_at).toBeTruthy();

    // 4. resolve_platform_alert denies aal1 and allows aal2 + writes platform_audit
    await expect(
      ctx.asUser(adminAal1, (tx) =>
        tx.query(`SELECT public.resolve_platform_alert($1::uuid)`, [alertsAfterSyncFail[0].id])
      )
    ).rejects.toThrow(/aal2|MFA|Platform admin/i);

    const resolvedRow = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ resolve_platform_alert: { resolved_at: string } }>(
        `SELECT public.resolve_platform_alert($1::uuid)`,
        [alertsAfterSyncFail[0].id]
      );
      return res.rows[0].resolve_platform_alert;
    });
    expect(resolvedRow.resolved_at).toBeTruthy();

    const auditCount = await ctx.asUser(adminAal2, async (tx) => {
      const res = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.platform_audit WHERE action = 'platform_alert_resolved'`
      );
      return Number(res.rows[0].count);
    });
    expect(auditCount).toBe(1);
  });
});
