import { prepareShopBackupImport } from '../../services/backupImport';
import type {
  CreditPayment,
  Customer,
  Expense,
  Item,
  Sale,
  Shop,
  StockConflict,
  StockMovement,
  SubscriptionPayment,
} from '../../types';
import { fromNgwee, toNgwee } from '../../utils/money';
import type { ShopDomainCacheSnapshot } from '../offlineCache';
import type { ShopReadSyncTestOverride } from '../shopReadRepository';
import type { ShopRpcQueryClient } from '../shopWriteRpc';

export interface FakeDocsStateBridge {
  docs: Map<string, Record<string, unknown>>;
  emit: () => void;
  transactionAttempts: number;
  transactionError: Error | null;
  failMarker: string | null;
  failNextVerification: boolean;
}

function docToRow(
  table: string,
  shopId: string,
  id: string,
  doc: Record<string, unknown>
): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  switch (table) {
    case 'items': {
      const buyingKnown = doc.buyingPriceKnown !== false;
      return {
        shop_id: shopId,
        id,
        name: String(doc.name ?? 'Item'),
        buying_price_ngwee: buyingKnown ? toNgwee(Number(doc.buyingPrice ?? 0)) : 0,
        buying_price_known: buyingKnown,
        selling_price_ngwee: toNgwee(Number(doc.sellingPrice ?? 0)),
        unit_label: String(doc.unitLabel ?? ''),
        quantity: Number(doc.quantity ?? 0),
        low_stock_threshold: Number(doc.lowStockThreshold ?? 5),
        is_deleted: Boolean(doc.isDeleted),
        is_demo: Boolean(doc.isDemo),
        last_sold_at: (doc.lastSoldAt as string | undefined) ?? null,
        created_at: String(doc.createdAt ?? nowIso),
        updated_at: String(doc.updatedAt ?? doc.createdAt ?? nowIso),
      };
    }
    case 'sales': {
      const items = (doc.items as Array<Record<string, unknown>> | undefined) ?? [];
      const totalAmountNgwee = toNgwee(Number(doc.totalAmount ?? 0));
      const totalCostNgwee = toNgwee(Number(doc.totalCost ?? 0));
      const missingCostNgwee =
        doc.missingCostRevenue !== undefined ? toNgwee(Number(doc.missingCostRevenue)) : 0;
      const profitNgwee =
        doc.profit !== undefined
          ? toNgwee(Number(doc.profit))
          : totalAmountNgwee - totalCostNgwee - missingCostNgwee;
      return {
        shop_id: shopId,
        id,
        items_count: Number(
          doc.itemsCount ?? items.reduce((s, line) => s + Number(line.quantity ?? 0), 0)
        ),
        total_amount_ngwee: totalAmountNgwee,
        total_cost_ngwee: totalCostNgwee,
        profit_ngwee: profitNgwee,
        missing_cost_revenue_ngwee: missingCostNgwee,
        payment_type: String(doc.paymentType ?? 'cash'),
        momo_operator: (doc.momoOperator as string | undefined) ?? null,
        customer_id: (doc.customerId as string | undefined) ?? null,
        customer_name: (doc.customerName as string | undefined) ?? null,
        customer_phone: (doc.customerPhone as string | undefined) ?? null,
        receipt_number: String(doc.receiptNumber ?? id),
        payment_reference: (doc.paymentReference as string | undefined) ?? null,
        note: (doc.note as string | undefined) ?? null,
        local_date: (doc.localDate as string | undefined) ?? null,
        cash_tendered_ngwee:
          doc.cashTendered !== undefined ? toNgwee(Number(doc.cashTendered)) : null,
        change_given_ngwee: doc.changeGiven !== undefined ? toNgwee(Number(doc.changeGiven)) : null,
        is_deleted: Boolean(doc.isDeleted),
        is_demo: Boolean(doc.isDemo),
        is_offline_sync: Boolean(doc.isOfflineSync),
        offline_window_flagged: Boolean(doc.offlineWindowFlagged),
        offline_flag_reason: (doc.offlineFlagReason as string | undefined) ?? null,
        client_created_at: (doc.clientCreatedAt as string | undefined) ?? null,
        created_at: String(doc.createdAt ?? nowIso),
        updated_at: String(doc.updatedAt ?? doc.createdAt ?? nowIso),
      };
    }
    case 'customers':
      return {
        shop_id: shopId,
        id,
        name: String(doc.name ?? 'Customer'),
        phone: String(doc.phone ?? ''),
        notes: String(doc.notes ?? ''),
        total_owed_ngwee: toNgwee(Number(doc.totalOwed ?? 0)),
        is_demo: Boolean(doc.isDemo),
        created_at: String(doc.createdAt ?? nowIso),
        updated_at: String(doc.updatedAt ?? doc.createdAt ?? nowIso),
      };
    case 'credit_payments':
      return {
        shop_id: shopId,
        id,
        customer_id: String(doc.customerId ?? ''),
        customer_name: String(doc.customerName ?? 'Customer'),
        amount_ngwee: toNgwee(Number(doc.amount ?? 0)),
        payment_method: String(doc.paymentMethod ?? 'cash'),
        note: String(doc.note ?? ''),
        local_date: (doc.localDate as string | undefined) ?? null,
        is_demo: Boolean(doc.isDemo),
        sync_correction: (doc.syncCorrection as Record<string, unknown> | undefined) ?? null,
        created_at: String(doc.createdAt ?? nowIso),
        updated_at: String(doc.updatedAt ?? doc.createdAt ?? nowIso),
      };
    case 'stock_movements':
      return {
        shop_id: shopId,
        id,
        item_id: String(doc.itemId ?? ''),
        item_name: String(doc.itemName ?? 'Item'),
        type: String(doc.type ?? 'adjustment'),
        delta: Number(doc.delta ?? 0),
        previous_quantity: Number(doc.previousQuantity ?? 0),
        new_quantity: Number(doc.newQuantity ?? 0),
        reason: String(doc.reason ?? ''),
        related_sale_id: (doc.relatedSaleId as string | undefined) ?? null,
        requested_quantity:
          doc.requestedQuantity !== undefined ? Number(doc.requestedQuantity) : null,
        recount_needed: Boolean(doc.recountNeeded),
        is_demo: Boolean(doc.isDemo),
        created_at: String(doc.createdAt ?? nowIso),
        updated_at: String(doc.updatedAt ?? doc.createdAt ?? nowIso),
      };
    case 'sync_operations':
      return {
        shop_id: shopId,
        operation_id: id,
        operation_type: String(doc.operationType ?? 'sale'),
        outcome: String(doc.outcome ?? (doc.hasResolution ? 'resolved' : 'applied')),
        sale_id: (doc.saleId as string | undefined) ?? null,
        has_resolution: Boolean(doc.hasResolution || doc.resolution),
        resolution: (doc.resolution as Record<string, unknown> | undefined) ?? null,
        applied_at: String(doc.appliedAt ?? nowIso),
        created_at: String(doc.appliedAt ?? nowIso),
        updated_at: String(doc.appliedAt ?? nowIso),
      };
    default:
      return { shop_id: shopId, id, ...doc };
  }
}

function collectTableRows(
  docs: Map<string, Record<string, unknown>>,
  table: string,
  filters: Array<{ column: string; value: unknown }>
): Array<Record<string, unknown>> {
  const shopFilter = filters.find((f) => f.column === 'shop_id');
  const shopId = shopFilter ? String(shopFilter.value) : '';
  if (!shopId) return [];

  if (table === 'sale_lines') {
    const saleIdFilter = filters.find((f) => f.column === 'sale_id');
    const saleId = saleIdFilter ? String(saleIdFilter.value) : '';
    const saleDoc = docs.get(`shops/${shopId}/sales/${saleId}`);
    if (!saleDoc) return [];
    const lines = (saleDoc.items as Array<Record<string, unknown>> | undefined) ?? [];
    const nowIso = String(saleDoc.createdAt ?? new Date().toISOString());
    return lines.map((line, idx) => {
      const buyingKnown = line.buyingPriceKnown !== false;
      const sellingNgwee = toNgwee(Number(line.sellingPrice ?? 0));
      const qty = Number(line.quantity ?? 1);
      return {
        shop_id: shopId,
        id: `${saleId}:${idx}`,
        sale_id: saleId,
        line_index: idx,
        item_id: String(line.itemId ?? ''),
        item_name: String(line.name ?? 'Item'),
        unit_label: String(line.unitLabel ?? ''),
        quantity: qty,
        buying_price_ngwee: buyingKnown ? toNgwee(Number(line.buyingPrice ?? 0)) : 0,
        buying_price_known: buyingKnown,
        selling_price_ngwee: sellingNgwee,
        line_total_ngwee: sellingNgwee * qty,
        created_at: nowIso,
        updated_at: nowIso,
      };
    });
  }

  const prefix = `shops/${shopId}/${table}/`;
  const rows: Array<Record<string, unknown>> = [];
  for (const [key, doc] of docs.entries()) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    if (!id || id.includes('/')) continue;
    rows.push(docToRow(table, shopId, id, doc));
  }

  return rows.filter((row) => filters.every((f) => row[f.column] === f.value));
}

function makeRpcError(message: string, code: string, detail = ''): Record<string, unknown> {
  return { message, code, details: detail, detail };
}

export function createFakeDocsRpcClient(bridge: FakeDocsStateBridge): ShopRpcQueryClient {
  function writeDoc(path: string, data: Record<string, unknown>, merge = false): void {
    bridge.docs.set(path, merge ? { ...bridge.docs.get(path), ...data } : { ...data });
  }

  function executeSingle(
    fnName: string,
    args: Record<string, unknown>
  ): { ok: true; data: Record<string, unknown> } | { ok: false; error: Record<string, unknown> } {
    const shopId = String(args.p_shop_id ?? '');
    const opId = String(args.p_operation_id ?? '');
    const root = `shops/${shopId}`;
    const markerPath = `${root}/sync_operations/${opId}`;
    const nowIso = new Date().toISOString();

    if (bridge.failMarker && opId === bridge.failMarker) {
      return {
        ok: false,
        error: makeRpcError('Write permission denied', '42501', 'PERMISSION_DENIED'),
      };
    }

    const existingMarker = bridge.docs.get(markerPath);
    if (existingMarker && fnName !== 'resolve_sync_conflict' && fnName !== 'import_shop_backup') {
      return {
        ok: true,
        data: {
          status: 'duplicate',
          idempotent: true,
          outcome: String(existingMarker.outcome ?? 'applied'),
          has_resolution: Boolean(existingMarker.hasResolution || existingMarker.resolution),
        },
      };
    }

    const shopDoc = bridge.docs.get(root);
    if (fnName === 'record_sale' && shopDoc) {
      if (shopDoc.isDeactivated || shopDoc.planStatus === 'suspended') {
        return {
          ok: false,
          error: makeRpcError(
            'New sales are locked because this shop is suspended.',
            '42501',
            'SHOP_SUSPENDED'
          ),
        };
      }
      if (
        typeof shopDoc.salesAccessUntilMs === 'number' &&
        Date.now() > shopDoc.salesAccessUntilMs &&
        !args.p_is_offline_sync
      ) {
        return {
          ok: false,
          error: makeRpcError(
            'Subscription and grace period have expired. Renew your plan to record sales.',
            '42501',
            'PLAN_EXPIRED'
          ),
        };
      }
    }

    switch (fnName) {
      case 'record_sale': {
        const saleId = String(args.p_sale_id ?? '');
        const lines = (args.p_lines as Array<Record<string, unknown>> | undefined) ?? [];
        const paymentType = String(args.p_payment_type ?? 'cash');
        const customerId = args.p_customer_id ? String(args.p_customer_id) : null;

        // Verify all items & customer exist BEFORE writing anything
        for (const line of lines) {
          const itemPath = `${root}/items/${String(line.item_id)}`;
          const itemDoc = bridge.docs.get(itemPath);
          if (!itemDoc) {
            return {
              ok: false,
              error: makeRpcError(
                'A stock item or customer needed by this entry no longer exists.',
                'P0002',
                'ITEM_NOT_FOUND'
              ),
            };
          }
          const prev = Number(itemDoc.quantity);
          if (!Number.isSafeInteger(prev) || prev < 0) {
            return {
              ok: false,
              error: makeRpcError('Invalid stock quantity or queued stock adjustment.', '22023'),
            };
          }
        }

        let customerDoc: Record<string, unknown> | undefined;
        if (paymentType === 'credit') {
          if (!customerId) {
            return {
              ok: false,
              error: makeRpcError('Choose a customer for a credit sale.', '22023'),
            };
          }
          customerDoc = bridge.docs.get(`${root}/customers/${customerId}`);
          if (!customerDoc) {
            return {
              ok: false,
              error: makeRpcError(
                'A stock item or customer needed by this entry no longer exists.',
                'P0002',
                'CUSTOMER_NOT_FOUND'
              ),
            };
          }
          if (toNgwee(Number(customerDoc.totalOwed ?? 0)) < 0) {
            return {
              ok: false,
              error: makeRpcError('Invalid customer balance or queued credit adjustment.', '22023'),
            };
          }
        }

        let itemsCount = 0;
        let totalAmountNgwee = 0;
        let totalCostNgwee = 0;
        let missingCostNgwee = 0;

        const saleItems = lines.map((line) => {
          const qty = Number(line.quantity);
          const sellingNgwee = Number(line.selling_price_ngwee);
          const buyingKnown = line.buying_price_known !== false;
          const buyingNgwee = buyingKnown ? Number(line.buying_price_ngwee ?? 0) : 0;
          const lineTotalNgwee = sellingNgwee * qty;
          itemsCount += qty;
          totalAmountNgwee += lineTotalNgwee;
          if (buyingKnown) totalCostNgwee += buyingNgwee * qty;
          else missingCostNgwee += lineTotalNgwee;

          return {
            itemId: String(line.item_id),
            name: String(line.item_name ?? ''),
            ...(line.unit_label ? { unitLabel: String(line.unit_label) } : {}),
            quantity: qty,
            buyingPrice: fromNgwee(buyingNgwee),
            buyingPriceKnown: buyingKnown,
            sellingPrice: fromNgwee(sellingNgwee),
            total: fromNgwee(lineTotalNgwee),
          };
        });

        const profitNgwee = totalAmountNgwee - totalCostNgwee - missingCostNgwee;
        const createdAt = String(args.p_client_created_at ?? nowIso);
        const receiptNumber = String(args.p_receipt_number ?? saleId);

        const saleDoc: Record<string, unknown> = {
          id: saleId,
          shopId,
          items: saleItems,
          itemsCount,
          totalAmount: fromNgwee(totalAmountNgwee),
          totalCost: fromNgwee(totalCostNgwee),
          profit: fromNgwee(profitNgwee),
          ...(missingCostNgwee > 0 ? { missingCostRevenue: fromNgwee(missingCostNgwee) } : {}),
          paymentType,
          ...(args.p_momo_operator ? { momoOperator: args.p_momo_operator } : {}),
          ...(customerId ? { customerId } : {}),
          ...(args.p_customer_name
            ? { customerName: args.p_customer_name }
            : customerDoc?.name
              ? { customerName: customerDoc.name }
              : {}),
          ...(args.p_customer_phone ? { customerPhone: args.p_customer_phone } : {}),
          receiptNumber,
          ...(args.p_payment_reference ? { paymentReference: args.p_payment_reference } : {}),
          ...(args.p_note ? { note: args.p_note } : {}),
          ...(args.p_local_date ? { localDate: args.p_local_date } : {}),
          ...(typeof args.p_cash_tendered_ngwee === 'number'
            ? { cashTendered: fromNgwee(args.p_cash_tendered_ngwee) }
            : {}),
          ...(typeof args.p_change_given_ngwee === 'number'
            ? { changeGiven: fromNgwee(args.p_change_given_ngwee) }
            : {}),
          createdAt,
        };
        writeDoc(`${root}/sales/${saleId}`, saleDoc, true);

        lines.forEach((line, index) => {
          const itemId = String(line.item_id);
          const itemPath = `${root}/items/${itemId}`;
          const itemDoc = bridge.docs.get(itemPath)!;
          const prev = Number(itemDoc.quantity);
          const qty = Number(line.quantity);
          const next = Math.max(0, prev - qty);
          const shortfall = Math.max(0, qty - prev);
          const delta = next - prev;
          writeDoc(
            itemPath,
            {
              quantity: next,
              updatedAt: createdAt,
              lastSoldAt: createdAt,
            },
            true
          );

          const movementId = String(line.movement_id ?? `mv_${opId}_${index}`);
          writeDoc(`${root}/stock_movements/${movementId}`, {
            id: movementId,
            shopId,
            itemId,
            itemName: String(line.item_name ?? itemDoc.name ?? ''),
            type: 'sale',
            delta,
            previousQuantity: prev,
            newQuantity: next,
            reason: String(line.reason ?? `Sale ${receiptNumber}`),
            relatedSaleId: saleId,
            ...(shortfall > 0 ? { requestedQuantity: qty, recountNeeded: true } : {}),
            createdAt,
          });

          if (shortfall > 0) {
            const conflictId = `${opId}_${index}`;
            writeDoc(`${root}/stock_conflicts/${conflictId}`, {
              id: conflictId,
              itemId,
              itemName: String(line.item_name ?? itemDoc.name ?? ''),
              kind: 'shortfall',
              requested: qty,
              available: prev,
              shortfall,
              relatedSaleId: saleId,
              createdAt,
              resolved: false,
            });
          }
        });

        if (paymentType === 'credit' && customerId && customerDoc) {
          const prevOwedNgwee = toNgwee(Number(customerDoc.totalOwed ?? 0));
          writeDoc(
            `${root}/customers/${customerId}`,
            {
              totalOwed: fromNgwee(prevOwedNgwee + totalAmountNgwee),
              updatedAt: createdAt,
            },
            true
          );
        }

        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied', saleId });
        return { ok: true, data: { status: 'applied', outcome: 'applied', sale_id: saleId } };
      }

      case 'undo_sale': {
        const saleId = String(args.p_sale_id ?? '');
        const salePath = `${root}/sales/${saleId}`;
        const saleDoc = bridge.docs.get(salePath);
        if (!saleDoc) {
          return {
            ok: false,
            error: makeRpcError(
              'The sale needed by this undo no longer exists.',
              'P0002',
              'SALE_NOT_FOUND'
            ),
          };
        }

        if (saleDoc.isDeleted) {
          writeDoc(markerPath, {
            appliedAt: nowIso,
            outcome: 'already-voided',
            saleId,
          });
          return {
            ok: true,
            data: { status: 'already_voided', outcome: 'already-voided', sale_id: saleId },
          };
        }

        const expected = args.p_expected_checks as Record<string, unknown> | null | undefined;
        const saleAmountNgwee = toNgwee(Number(saleDoc.totalAmount ?? 0));
        if (expected) {
          const hasCredit = Boolean(expected.has_credit_adjustment);
          const expectedCustId = expected.customer_id ? String(expected.customer_id) : null;
          const expectedDelta =
            typeof expected.credit_delta_ngwee === 'number' ? expected.credit_delta_ngwee : null;
          if (
            (saleDoc.paymentType === 'credit' &&
              (!hasCredit ||
                expectedCustId !== String(saleDoc.customerId ?? '') ||
                expectedDelta !== -saleAmountNgwee)) ||
            (saleDoc.paymentType !== 'credit' && hasCredit)
          ) {
            return {
              ok: false,
              error: makeRpcError(
                'The sale or its customer changed; this undo needs manual review.',
                '22023',
                'UNDO_SALE_CHANGED'
              ),
            };
          }

          const stockDeltas =
            (expected.stock_deltas as Array<{ item_id: string; delta: number }> | undefined) ?? [];
          const saleItems = (saleDoc.items as Array<Record<string, unknown>> | undefined) ?? [];
          for (const entry of stockDeltas) {
            const line = saleItems.find((s) => String(s.itemId) === entry.item_id);
            if (!line || Number(line.quantity) !== entry.delta) {
              return {
                ok: false,
                error: makeRpcError(
                  'The sale items changed; this undo needs manual review.',
                  '22023',
                  'UNDO_SALE_ITEMS_CHANGED'
                ),
              };
            }
            if (!bridge.docs.has(`${root}/items/${entry.item_id}`)) {
              return {
                ok: false,
                error: makeRpcError(
                  'A stock item or customer needed by this entry no longer exists.',
                  'P0002',
                  'ITEM_NOT_FOUND'
                ),
              };
            }
          }
        }

        if (saleDoc.paymentType === 'credit') {
          const custPath = `${root}/customers/${String(saleDoc.customerId)}`;
          const custDoc = bridge.docs.get(custPath);
          if (!custDoc) {
            return {
              ok: false,
              error: makeRpcError(
                'A stock item or customer needed by this entry no longer exists.',
                'P0002',
                'CUSTOMER_NOT_FOUND'
              ),
            };
          }
          const owedNgwee = toNgwee(Number(custDoc.totalOwed ?? 0));
          if (owedNgwee < 0) {
            return {
              ok: false,
              error: makeRpcError('Invalid customer balance or queued credit adjustment.', '22023'),
            };
          }
          if (owedNgwee < saleAmountNgwee) {
            return {
              ok: false,
              error: makeRpcError(
                'This sale undo conflicts with a newer customer balance and needs review.',
                '23514',
                'CREDIT_BALANCE_CONFLICT'
              ),
            };
          }
          writeDoc(
            custPath,
            {
              totalOwed: fromNgwee(owedNgwee - saleAmountNgwee),
              updatedAt: nowIso,
            },
            true
          );
        }

        writeDoc(salePath, { isDeleted: true }, true);

        const customMovements =
          (args.p_movements as Array<{
            item_id: string;
            movement_id: string;
            reason: string;
          }> | null) ?? [];
        const saleItems = (saleDoc.items as Array<Record<string, unknown>> | undefined) ?? [];
        saleItems.forEach((line, idx) => {
          const itemId = String(line.itemId);
          const itemPath = `${root}/items/${itemId}`;
          const itemDoc = bridge.docs.get(itemPath);
          if (!itemDoc) return;
          const prev = Number(itemDoc.quantity);
          const restoreQty = Number(line.quantity);
          const next = prev + restoreQty;
          writeDoc(itemPath, { quantity: next, updatedAt: nowIso }, true);

          const custom = customMovements.find((m) => m.item_id === itemId);
          const mvId = custom?.movement_id ?? `void_${opId}_${idx}`;
          writeDoc(`${root}/stock_movements/${mvId}`, {
            id: mvId,
            shopId,
            itemId,
            itemName: String(itemDoc.name ?? line.name ?? ''),
            type: 'void',
            delta: restoreQty,
            previousQuantity: prev,
            newQuantity: next,
            reason: custom?.reason ?? `Undo sale ${String(saleDoc.receiptNumber ?? saleId)}`,
            relatedSaleId: saleId,
            createdAt: nowIso,
          });
        });

        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied', saleId });
        return { ok: true, data: { status: 'applied', outcome: 'applied', sale_id: saleId } };
      }

      case 'record_repayment': {
        const paymentId = String(args.p_payment_id ?? '');
        const customerId = String(args.p_customer_id ?? '');
        const amountNgwee = Number(args.p_amount_ngwee ?? 0);
        const custPath = `${root}/customers/${customerId}`;
        const custDoc = bridge.docs.get(custPath);
        if (!custDoc) {
          return {
            ok: false,
            error: makeRpcError(
              'A stock item or customer needed by this entry no longer exists.',
              'P0002',
              'CUSTOMER_NOT_FOUND'
            ),
          };
        }
        const prevNgwee = toNgwee(Number(custDoc.totalOwed ?? 0));
        if (prevNgwee < 0 || !Number.isSafeInteger(amountNgwee) || amountNgwee <= 0) {
          return {
            ok: false,
            error: makeRpcError('Invalid customer balance or queued credit adjustment.', '22023'),
          };
        }
        if (amountNgwee > prevNgwee) {
          return {
            ok: false,
            error: makeRpcError(
              'This repayment conflicts with a newer customer balance and needs review.',
              '23514',
              'CREDIT_BALANCE_CONFLICT'
            ),
          };
        }

        const createdAt = String(args.p_created_at ?? nowIso);
        writeDoc(`${root}/credit_payments/${paymentId}`, {
          id: paymentId,
          shopId,
          customerId,
          customerName: String(custDoc.name ?? 'Customer'),
          amount: fromNgwee(amountNgwee),
          paymentMethod: String(args.p_payment_method ?? 'cash'),
          note: String(args.p_note ?? ''),
          ...(args.p_local_date ? { localDate: String(args.p_local_date) } : {}),
          createdAt,
        });
        writeDoc(
          custPath,
          {
            totalOwed: fromNgwee(prevNgwee - amountNgwee),
            updatedAt: nowIso,
          },
          true
        );
        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied' });
        return { ok: true, data: { status: 'applied', outcome: 'applied', payment_id: paymentId } };
      }

      case 'apply_stock_count': {
        const itemId = String(args.p_item_id ?? '');
        const mode = String(args.p_mode ?? 'delta');
        const qty = Number(args.p_quantity ?? 0);
        const observed =
          typeof args.p_observed_quantity === 'number' ? args.p_observed_quantity : null;
        const itemPath = `${root}/items/${itemId}`;
        const itemDoc = bridge.docs.get(itemPath);
        if (!itemDoc) {
          return {
            ok: false,
            error: makeRpcError(
              'A stock item or customer needed by this entry no longer exists.',
              'P0002',
              'ITEM_NOT_FOUND'
            ),
          };
        }

        const prev = Number(itemDoc.quantity);
        if (!Number.isSafeInteger(prev) || prev < 0 || !Number.isSafeInteger(qty)) {
          return {
            ok: false,
            error: makeRpcError('Invalid stock quantity or queued stock adjustment.', '22023'),
          };
        }

        const meta = (args.p_metadata as Record<string, unknown> | null | undefined) ?? null;
        const metaPatch: Record<string, unknown> = {};
        if (meta) {
          if (meta.name !== undefined) metaPatch.name = meta.name;
          if (meta.unit_label !== undefined) metaPatch.unitLabel = meta.unit_label;
          if (meta.buying_price_known !== undefined)
            metaPatch.buyingPriceKnown = meta.buying_price_known;
          if (typeof meta.buying_price_ngwee === 'number')
            metaPatch.buyingPrice = fromNgwee(meta.buying_price_ngwee);
          if (typeof meta.selling_price_ngwee === 'number')
            metaPatch.sellingPrice = fromNgwee(meta.selling_price_ngwee);
          if (meta.low_stock_threshold !== undefined)
            metaPatch.lowStockThreshold = meta.low_stock_threshold;
        }

        const staleCount = mode === 'set' && observed !== null && observed !== prev;
        const requested = mode === 'set' ? (staleCount ? prev : qty) : prev + qty;
        const next = Math.max(0, requested);
        const shortfall = Math.max(0, -requested);
        const delta = staleCount ? 0 : next - prev;

        writeDoc(
          itemPath,
          {
            ...metaPatch,
            quantity: next,
            updatedAt: nowIso,
          },
          true
        );

        const movementId = String(args.p_movement_id ?? `scmv_${opId}`);
        const baseReason = String(args.p_reason ?? 'Stock adjustment');
        writeDoc(`${root}/stock_movements/${movementId}`, {
          id: movementId,
          shopId,
          itemId,
          itemName: String(metaPatch.name ?? itemDoc.name ?? ''),
          type: String(args.p_movement_type ?? 'adjustment'),
          delta,
          previousQuantity: prev,
          newQuantity: next,
          reason: staleCount ? `${baseReason} (not applied; recount needed)` : baseReason,
          ...(staleCount ? { requestedQuantity: qty, recountNeeded: true } : {}),
          ...(shortfall > 0 ? { requestedQuantity: Math.abs(qty), recountNeeded: true } : {}),
          createdAt: nowIso,
        });

        if (staleCount || shortfall > 0) {
          const conflictId = `${opId}_0`;
          writeDoc(`${root}/stock_conflicts/${conflictId}`, {
            id: conflictId,
            itemId,
            itemName: String(metaPatch.name ?? itemDoc.name ?? ''),
            ...(staleCount ? { kind: 'recount', observed } : { kind: 'shortfall' }),
            requested: staleCount ? qty : Math.abs(qty),
            available: prev,
            shortfall: staleCount ? 0 : shortfall,
            relatedSaleId: '',
            createdAt: nowIso,
            resolved: false,
          });
        }

        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied' });
        return { ok: true, data: { status: 'applied', outcome: 'applied', item_id: itemId } };
      }

      case 'resolve_stock_conflict': {
        const conflictId = String(args.p_conflict_id ?? '');
        writeDoc(`${root}/stock_conflicts/${conflictId}`, { resolved: true }, true);
        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'resolved' });
        return { ok: true, data: { status: 'applied', outcome: 'resolved' } };
      }

      case 'upsert_shop_item': {
        const itemId = String(args.p_item_id ?? '');
        const patch = (args.p_patch as Record<string, unknown> | undefined) ?? {};
        const itemPath = `${root}/items/${itemId}`;
        const existing = bridge.docs.get(itemPath);

        const docPatch: Record<string, unknown> = { updatedAt: nowIso };
        if (patch.name !== undefined) docPatch.name = patch.name;
        if (patch.unit_label !== undefined) docPatch.unitLabel = patch.unit_label;
        if (patch.buying_price_known !== undefined)
          docPatch.buyingPriceKnown = patch.buying_price_known;
        if (typeof patch.buying_price_ngwee === 'number')
          docPatch.buyingPrice = fromNgwee(patch.buying_price_ngwee);
        if (typeof patch.selling_price_ngwee === 'number')
          docPatch.sellingPrice = fromNgwee(patch.selling_price_ngwee);
        if (patch.low_stock_threshold !== undefined)
          docPatch.lowStockThreshold = patch.low_stock_threshold;
        if (patch.is_deleted !== undefined) docPatch.isDeleted = patch.is_deleted;

        if (!existing) {
          const initialQty = Number(patch.quantity ?? 0);
          writeDoc(itemPath, {
            id: itemId,
            shopId,
            quantity: initialQty,
            buyingPrice: 0,
            buyingPriceKnown: true,
            lowStockThreshold: 5,
            createdAt: String(patch.created_at ?? nowIso),
            ...docPatch,
          });
          const initMv = args.p_initial_movement as Record<string, unknown> | null | undefined;
          const mvId = String(initMv?.id ?? `init_${opId}`);
          writeDoc(`${root}/stock_movements/${mvId}`, {
            id: mvId,
            shopId,
            itemId,
            itemName: String(docPatch.name ?? ''),
            type: 'initial',
            delta: initialQty,
            previousQuantity: 0,
            newQuantity: initialQty,
            reason: String(initMv?.reason ?? 'Initial stock'),
            createdAt: String(initMv?.created_at ?? nowIso),
          });
        } else {
          writeDoc(itemPath, docPatch, true);
        }

        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied' });
        return { ok: true, data: { status: 'applied', outcome: 'applied', item_id: itemId } };
      }

      case 'upsert_shop_customer': {
        const customerId = String(args.p_customer_id ?? '');
        const patch = (args.p_patch as Record<string, unknown> | undefined) ?? {};
        const custPath = `${root}/customers/${customerId}`;
        const existing = bridge.docs.get(custPath);
        if (!existing) {
          writeDoc(custPath, {
            id: customerId,
            shopId,
            name: String(patch.name ?? ''),
            phone: String(patch.phone ?? ''),
            notes: String(patch.notes ?? ''),
            totalOwed: 0,
            createdAt: String(patch.created_at ?? nowIso),
            updatedAt: nowIso,
          });
        } else {
          const docPatch: Record<string, unknown> = { updatedAt: nowIso };
          if (patch.name !== undefined) docPatch.name = patch.name;
          if (patch.phone !== undefined) docPatch.phone = patch.phone;
          if (patch.notes !== undefined) docPatch.notes = patch.notes;
          writeDoc(custPath, docPatch, true);
        }
        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied' });
        return {
          ok: true,
          data: { status: 'applied', outcome: 'applied', customer_id: customerId },
        };
      }

      case 'upsert_shop_expense': {
        const expenseId = String(args.p_expense_id ?? '');
        const patch = (args.p_patch as Record<string, unknown> | undefined) ?? {};
        const expPath = `${root}/expenses/${expenseId}`;
        const existing = bridge.docs.get(expPath);
        if (!existing) {
          if (patch.is_deleted === true && typeof patch.amount_ngwee !== 'number') {
            writeDoc(expPath, { isDeleted: true }, true);
          } else {
            writeDoc(expPath, {
              id: expenseId,
              shopId,
              category: String(patch.category ?? 'other'),
              amount: typeof patch.amount_ngwee === 'number' ? fromNgwee(patch.amount_ngwee) : 0,
              note: String(patch.note ?? ''),
              ...(patch.is_deleted !== undefined ? { isDeleted: Boolean(patch.is_deleted) } : {}),
              createdAt: String(patch.created_at ?? nowIso),
            });
          }
        } else {
          const docPatch: Record<string, unknown> = {};
          if (patch.category !== undefined) docPatch.category = patch.category;
          if (typeof patch.amount_ngwee === 'number')
            docPatch.amount = fromNgwee(patch.amount_ngwee);
          if (patch.note !== undefined) docPatch.note = patch.note;
          if (patch.is_deleted !== undefined) docPatch.isDeleted = patch.is_deleted;
          writeDoc(expPath, docPatch, true);
        }
        writeDoc(markerPath, { appliedAt: nowIso, outcome: 'applied' });
        return { ok: true, data: { status: 'applied', outcome: 'applied', expense_id: expenseId } };
      }

      case 'resolve_sync_conflict': {
        if (existingMarker) {
          return {
            ok: true,
            data: {
              status: 'already-processed',
              idempotent: true,
              outcome: String(existingMarker.outcome ?? 'resolved'),
              resolution: existingMarker.resolution ?? null,
            },
          };
        }

        const decision = String(args.p_decision ?? '');
        const resolution = (args.p_resolution as Record<string, unknown> | undefined) ?? {};
        const ctx = (args.p_context as Record<string, unknown> | undefined) ?? {};

        if (decision === 'discard-poison') {
          const resolvedAt = String(resolution.resolvedAt ?? nowIso);
          const finalResolution: Record<string, unknown> = {
            ...resolution,
            kind: 'discard-poison',
            actionId: opId,
            resolvedAt,
          };
          writeDoc(markerPath, {
            appliedAt: resolvedAt,
            outcome: 'resolved',
            hasResolution: true,
            resolution: finalResolution,
          });
          return {
            ok: true,
            data: { status: 'resolved', outcome: 'resolved', resolution: finalResolution },
          };
        }

        const kind = String(ctx.kind ?? (decision === 'keep-sale' ? 'void' : 'payment'));
        const customerId = String(ctx.customer_id ?? resolution.customerId ?? '');
        const expectedBalanceNgwee = Number(ctx.expected_balance_ngwee ?? 0);
        const originalAmountNgwee = Number(ctx.original_amount_ngwee ?? 0);

        const custPath = `${root}/customers/${customerId}`;
        const custDoc = bridge.docs.get(custPath);
        if (!custDoc) {
          return {
            ok: false,
            error: makeRpcError(
              'The customer no longer exists on the server.',
              'P0002',
              'CUSTOMER_NOT_FOUND'
            ),
          };
        }
        const currentBalanceNgwee = toNgwee(Number(custDoc.totalOwed ?? 0));
        if (currentBalanceNgwee < 0) {
          return {
            ok: false,
            error: makeRpcError('The server has an invalid customer balance.', '23514'),
          };
        }

        const saleId = String(ctx.sale_id ?? resolution.saleId ?? '');
        const saleDoc = kind === 'void' ? bridge.docs.get(`${root}/sales/${saleId}`) : undefined;

        if (kind === 'void' && saleDoc?.isDeleted) {
          writeDoc(markerPath, {
            appliedAt: nowIso,
            outcome: 'already-voided',
            saleId,
          });
          return {
            ok: true,
            data: { status: 'already-processed', outcome: 'already-voided', sale_id: saleId },
          };
        }

        if (
          currentBalanceNgwee !== expectedBalanceNgwee ||
          currentBalanceNgwee >= originalAmountNgwee
        ) {
          return {
            ok: false,
            error: makeRpcError(
              'The server balance changed. Close this review and check it again.',
              '23514',
              'SERVER_BALANCE_CHANGED'
            ),
          };
        }

        const paymentId = String(ctx.payment_id ?? '');
        if (
          kind === 'payment' &&
          paymentId &&
          bridge.docs.has(`${root}/credit_payments/${paymentId}`)
        ) {
          return {
            ok: false,
            error: makeRpcError(
              'A payment with this ID already exists. Keep this browser’s data.',
              '23505'
            ),
          };
        }

        if (
          kind === 'void' &&
          (!saleDoc ||
            saleDoc.paymentType !== 'credit' ||
            String(saleDoc.customerId ?? '') !== customerId ||
            toNgwee(Number(saleDoc.totalAmount ?? 0)) !== originalAmountNgwee)
        ) {
          return {
            ok: false,
            error: makeRpcError(
              'The sale or its customer changed. Close this review and check it again.',
              '23514'
            ),
          };
        }

        const resolvedAt = String(resolution.resolvedAt ?? nowIso);
        const finalResolution: Record<string, unknown> = {
          ...resolution,
          customerName: typeof custDoc.name === 'string' ? custDoc.name : resolution.customerName,
          serverBalanceBefore: fromNgwee(currentBalanceNgwee),
          resolvedAt,
          ...(kind === 'void' && saleDoc
            ? {
                receipt: typeof saleDoc.receiptNumber === 'string' ? saleDoc.receiptNumber : saleId,
              }
            : {}),
        };

        if (decision === 'correct-payment') {
          const correctedNgwee = Number(ctx.corrected_amount_ngwee ?? 0);
          writeDoc(`${root}/credit_payments/${paymentId}`, {
            id: paymentId,
            shopId,
            customerId,
            customerName: String(custDoc.name ?? ''),
            amount: fromNgwee(correctedNgwee),
            paymentMethod: String(ctx.payment_method ?? 'cash'),
            note: String(ctx.note ?? ''),
            ...(ctx.local_date ? { localDate: String(ctx.local_date) } : {}),
            createdAt: String(ctx.created_at ?? resolvedAt),
            syncCorrection: {
              actionId: opId,
              originalAmount: fromNgwee(originalAmountNgwee),
              resolvedAt,
            },
          });
          writeDoc(
            custPath,
            {
              totalOwed: fromNgwee(currentBalanceNgwee - correctedNgwee),
              updatedAt: resolvedAt,
            },
            true
          );
          finalResolution.correctedAmount = fromNgwee(correctedNgwee);
        }

        writeDoc(markerPath, {
          appliedAt: resolvedAt,
          outcome: 'resolved',
          hasResolution: true,
          resolution: finalResolution,
        });

        if (bridge.failNextVerification) {
          bridge.failNextVerification = false;
          bridge.transactionError = Object.assign(new Error('Network lost after commit'), {
            code: 'unavailable',
          });
        }

        return {
          ok: true,
          data: { status: 'resolved', outcome: 'resolved', resolution: finalResolution },
        };
      }

      case 'import_shop_backup': {
        const dryRun = Boolean(args.p_dry_run);
        const allowNonEmptyShop = Boolean(args.p_allow_non_empty_shop);
        const fileSha256 = String(args.p_file_sha256 ?? '')
          .trim()
          .toLowerCase();
        const backupObj = args.p_backup;
        if (!backupObj || typeof backupObj !== 'object' || Array.isArray(backupObj)) {
          return {
            ok: false,
            error: makeRpcError('Invalid backup payload.', '22023', 'INVALID_BACKUP'),
          };
        }

        const rawJson = JSON.stringify(backupObj);
        if (new TextEncoder().encode(rawJson).byteLength > 5_000_000) {
          return {
            ok: false,
            error: makeRpcError(
              'Backup file exceeds the 5 MB limit.',
              '22023',
              'BACKUP_FILE_TOO_LARGE'
            ),
          };
        }

        let prepared;
        try {
          prepared = prepareShopBackupImport(rawJson, shopId);
        } catch (err) {
          return {
            ok: false,
            error: makeRpcError(
              err instanceof Error ? err.message : 'Invalid backup payload.',
              '22023',
              'INVALID_BACKUP'
            ),
          };
        }

        let alreadyImported = Boolean(existingMarker);
        if (!alreadyImported && fileSha256) {
          for (const [docPath, docVal] of bridge.docs.entries()) {
            if (docPath.startsWith(`${root}/sync_operations/`)) {
              const res = docVal.resolution as Record<string, unknown> | undefined;
              if (res && String(res.fileSha256 ?? '').toLowerCase() === fileSha256) {
                alreadyImported = true;
                break;
              }
            }
          }
        }

        let shopHasExistingData = false;
        for (const docPath of bridge.docs.keys()) {
          if (
            docPath.startsWith(`${root}/items/`) ||
            docPath.startsWith(`${root}/sales/`) ||
            docPath.startsWith(`${root}/customers/`) ||
            docPath.startsWith(`${root}/expenses/`)
          ) {
            shopHasExistingData = true;
            break;
          }
        }

        const p = prepared.preview;
        const preview = {
          format: p.format,
          source_shop_name: p.sourceShopName,
          items_count: p.itemsCount,
          active_items_count: p.activeItemsCount,
          archived_items_count: p.archivedItemsCount,
          sales_count: p.salesCount,
          customers_count: p.customersCount,
          expenses_count: p.expensesCount,
          credit_payments_count: p.creditPaymentsCount,
          stock_movements_count: p.stockMovementsCount,
          total_records_count: p.totalRecordsCount,
          total_stock_value_ngwee: p.totalStockValueNgwee,
          total_owed_ngwee: p.totalOwedNgwee,
        };

        if (dryRun) {
          return {
            ok: true,
            data: {
              status: 'preview',
              dry_run: true,
              idempotent: false,
              already_imported: alreadyImported,
              shop_has_existing_data: shopHasExistingData,
              file_sha256: fileSha256,
              preview,
            },
          };
        }

        if (alreadyImported) {
          return {
            ok: true,
            data: {
              status: 'duplicate',
              dry_run: false,
              idempotent: true,
              already_imported: true,
              shop_has_existing_data: shopHasExistingData,
              file_sha256: fileSha256,
              preview,
            },
          };
        }

        if (shopHasExistingData && !allowNonEmptyShop) {
          return {
            ok: false,
            error: makeRpcError(
              'This shop already contains records. Confirm importing into a non-empty shop to continue.',
              '23514',
              'SHOP_NOT_EMPTY'
            ),
          };
        }

        const plannedWrites: Array<{ path: string; data: Record<string, unknown> }> = [
          ...prepared.items.map((item) => ({
            path: `${root}/items/${item.id}`,
            data: item as unknown as Record<string, unknown>,
          })),
          ...prepared.customers.map((cust) => ({
            path: `${root}/customers/${cust.id}`,
            data: cust as unknown as Record<string, unknown>,
          })),
          ...prepared.sales.map((sale) => ({
            path: `${root}/sales/${sale.id}`,
            data: sale as unknown as Record<string, unknown>,
          })),
          ...prepared.creditPayments.map((pmt) => ({
            path: `${root}/credit_payments/${pmt.id}`,
            data: pmt as unknown as Record<string, unknown>,
          })),
          ...prepared.expenses.map((exp) => ({
            path: `${root}/expenses/${exp.id}`,
            data: exp as unknown as Record<string, unknown>,
          })),
          ...prepared.stockMovements.map((mv) => ({
            path: `${root}/stock_movements/${mv.id}`,
            data: mv as unknown as Record<string, unknown>,
          })),
        ];

        if (plannedWrites.some((w) => bridge.docs.has(w.path))) {
          return {
            ok: false,
            error: makeRpcError(
              'Some of these records are already in this shop. Nothing was imported.',
              '23505',
              'BACKUP_ID_CONFLICT'
            ),
          };
        }

        for (const w of plannedWrites) {
          writeDoc(w.path, w.data);
        }
        writeDoc(markerPath, {
          appliedAt: nowIso,
          outcome: 'applied',
          resolution: {
            kind: 'backup-import',
            fileSha256,
            format: p.format,
            totalRecords: p.totalRecordsCount,
          },
        });

        return {
          ok: true,
          data: {
            status: 'imported',
            dry_run: false,
            idempotent: false,
            already_imported: false,
            shop_has_existing_data: shopHasExistingData,
            file_sha256: fileSha256,
            preview,
          },
        };
      }

      default:
        return { ok: false, error: makeRpcError(`Unsupported RPC ${fnName}`, '22023') };
    }
  }

  return {
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      let orderCol: string | null = null;
      let orderAsc = true;

      const executeSelect = async () => {
        if (bridge.transactionError) {
          return { data: null, error: bridge.transactionError };
        }
        const rows = collectTableRows(bridge.docs, table, filters);
        if (orderCol) {
          rows.sort((a, b) => {
            const av = a[orderCol!];
            const bv = b[orderCol!];
            if (typeof av === 'number' && typeof bv === 'number') {
              return orderAsc ? av - bv : bv - av;
            }
            return orderAsc
              ? String(av ?? '').localeCompare(String(bv ?? ''))
              : String(bv ?? '').localeCompare(String(av ?? ''));
          });
        }
        return { data: rows, error: null };
      };

      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        order(column: string, opts?: { ascending?: boolean }) {
          orderCol = column;
          orderAsc = opts?.ascending !== false;
          return builder;
        },
        async maybeSingle() {
          const res = await executeSelect();
          if (res.error) return { data: null, error: res.error };
          return { data: res.data?.[0] ?? null, error: null };
        },
        then(
          onFulfilled?: (val: { data: unknown; error: unknown }) => unknown,
          onRejected?: (err: unknown) => unknown
        ) {
          return executeSelect().then(onFulfilled, onRejected);
        },
      };
      return builder as unknown as ReturnType<ShopRpcQueryClient['from']>;
    },

    async rpc(fnName: string, args: Record<string, unknown> = {}) {
      bridge.transactionAttempts++;
      if (bridge.transactionError) {
        return { data: null, error: bridge.transactionError } as unknown as ReturnType<
          ShopRpcQueryClient['rpc']
        >;
      }

      if (fnName === 'reconcile_shop_ledger') {
        return {
          data: {
            checked_at: new Date().toISOString(),
            shops_checked: 1,
            total_differences: 0,
            sale_line_mismatch_count: 0,
            sale_profit_mismatch_count: 0,
            customer_balance_mismatch_count: 0,
            stock_movement_mismatch_count: 0,
            sale_line_mismatches: [],
            sale_profit_mismatches: [],
            customer_balance_mismatches: [],
            stock_movement_mismatches: [],
          },
          error: null,
        } as unknown as ReturnType<ShopRpcQueryClient['rpc']>;
      }

      if (fnName === 'apply_sync_batch') {
        const shopId = String(args.p_shop_id ?? '');
        const ops = (args.p_operations as Array<Record<string, unknown>> | undefined) ?? [];
        const results: Array<Record<string, unknown>> = [];

        for (const op of ops) {
          const rpcName = String(op.rpc ?? '');
          const opId = String(op.operation_id ?? '');
          let mappedArgs: Record<string, unknown> = { p_shop_id: shopId, p_operation_id: opId };

          switch (rpcName) {
            case 'record_sale':
              mappedArgs = {
                ...mappedArgs,
                p_sale_id: op.sale_id,
                p_lines: op.lines,
                p_payment_type: op.payment_type,
                p_receipt_number: op.receipt_number,
                p_momo_operator: op.momo_operator,
                p_customer_id: op.customer_id,
                p_customer_name: op.customer_name,
                p_customer_phone: op.customer_phone,
                p_payment_reference: op.payment_reference,
                p_note: op.note,
                p_local_date: op.local_date,
                p_cash_tendered_ngwee: op.cash_tendered_ngwee,
                p_change_given_ngwee: op.change_given_ngwee,
                p_client_created_at: op.client_created_at,
                p_is_offline_sync: op.is_offline_sync,
                p_offline_window_seconds: op.offline_window_seconds,
              };
              break;
            case 'undo_sale':
              mappedArgs = {
                ...mappedArgs,
                p_sale_id: op.sale_id,
                p_movements: op.movements,
                p_expected_checks: op.expected_checks,
              };
              break;
            case 'record_repayment':
              mappedArgs = {
                ...mappedArgs,
                p_payment_id: op.payment_id,
                p_customer_id: op.customer_id,
                p_amount_ngwee: op.amount_ngwee,
                p_payment_method: op.payment_method,
                p_note: op.note,
                p_local_date: op.local_date,
                p_created_at: op.created_at,
              };
              break;
            case 'apply_stock_count':
              mappedArgs = {
                ...mappedArgs,
                p_item_id: op.item_id,
                p_mode: op.mode,
                p_quantity: op.quantity,
                p_observed_quantity: op.observed_quantity,
                p_movement_id: op.movement_id,
                p_movement_type: op.movement_type,
                p_reason: op.reason,
                p_metadata: op.metadata,
              };
              break;
            case 'resolve_stock_conflict':
              mappedArgs = {
                ...mappedArgs,
                p_conflict_id: op.conflict_id,
              };
              break;
            case 'upsert_shop_item':
              mappedArgs = {
                ...mappedArgs,
                p_item_id: op.item_id,
                p_patch: op.patch,
                p_initial_movement: op.initial_movement,
              };
              break;
            case 'upsert_shop_customer':
              mappedArgs = {
                ...mappedArgs,
                p_customer_id: op.customer_id,
                p_patch: op.patch,
              };
              break;
            case 'upsert_shop_expense':
              mappedArgs = {
                ...mappedArgs,
                p_expense_id: op.expense_id,
                p_patch: op.patch,
              };
              break;
          }

          const outcome = executeSingle(rpcName, mappedArgs);
          if ('error' in outcome) {
            results.push({
              operation_id: opId,
              ok: false,
              error_code: outcome.error.code,
              error_detail: outcome.error.detail,
              error_message: outcome.error.message,
            });
            break;
          }
          results.push({
            operation_id: opId,
            ok: true,
            result: outcome.data,
          });
        }

        bridge.emit();
        return { data: { results }, error: null };
      }

      const single = executeSingle(fnName, args);
      if ('error' in single) {
        return { data: null, error: single.error };
      }
      bridge.emit();
      return { data: single.data, error: null };
    },
  };
}

export function createFakeDocsReadSyncOverride(
  docs: Map<string, Record<string, unknown>>,
  subscribeChange: (fn: () => void) => () => void
): ShopReadSyncTestOverride {
  const buildDomainSnapshot = (shopId: string): ShopDomainCacheSnapshot => {
    const root = `shops/${shopId}/`;
    const items: Item[] = [];
    const archivedItems: Item[] = [];
    const sales: Sale[] = [];
    const customers: Customer[] = [];
    const creditPayments: CreditPayment[] = [];
    const expenses: Expense[] = [];
    const stockMovements: StockMovement[] = [];
    const stockConflicts: StockConflict[] = [];

    for (const [docPath, raw] of docs.entries()) {
      if (!docPath.startsWith(root)) continue;
      const rest = docPath.slice(root.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx <= 0) continue;
      const subcol = rest.slice(0, slashIdx);
      const clone = structuredClone(raw);
      switch (subcol) {
        case 'items': {
          const item = clone as unknown as Item;
          if (item.isDeleted) archivedItems.push(item);
          else items.push(item);
          break;
        }
        case 'sales':
          sales.push(clone as unknown as Sale);
          break;
        case 'customers':
          customers.push(clone as unknown as Customer);
          break;
        case 'credit_payments':
          creditPayments.push(clone as unknown as CreditPayment);
          break;
        case 'expenses':
          expenses.push(clone as unknown as Expense);
          break;
        case 'stock_movements':
          stockMovements.push(clone as unknown as StockMovement);
          break;
        case 'stock_conflicts':
          stockConflicts.push(clone as unknown as StockConflict);
          break;
      }
    }

    return {
      items,
      archivedItems,
      sales,
      customers,
      creditPayments,
      expenses,
      stockMovements,
      stockConflicts,
      subscriptionPayments: [],
      cursors: {},
    };
  };

  return {
    subscribeShop(shopId, callbacks) {
      const push = () => {
        const rawShop = docs.get(`shops/${shopId}`);
        if (rawShop) {
          callbacks.onShopSnapshot(structuredClone(rawShop) as unknown as Shop);
        }
        callbacks.onDomainSnapshot(buildDomainSnapshot(shopId));
      };
      push();
      const unsub = subscribeChange(push);
      return {
        async triggerNow() {
          push();
        },
        dispose() {
          unsub();
        },
      };
    },

    subscribeAdminShops(onShops) {
      const push = () => {
        const list: Shop[] = [];
        for (const [docPath, raw] of docs.entries()) {
          if (docPath.startsWith('shops/') && docPath.split('/').length === 2) {
            list.push(structuredClone(raw) as unknown as Shop);
          }
        }
        onShops(list);
      };
      push();
      return subscribeChange(push);
    },

    subscribeSubscriptionPayments(params, onPayments) {
      const push = () => {
        const list: SubscriptionPayment[] = [];
        for (const [docPath, raw] of docs.entries()) {
          if (!docPath.startsWith('subscriptionPayments/')) continue;
          const record = structuredClone(raw) as unknown as SubscriptionPayment;
          if (params.isAdmin || record.ownerUid === params.userId) {
            list.push(record);
          }
        }
        list.sort((a, b) => b.submittedAtMs - a.submittedAtMs);
        onPayments(list);
      };
      push();
      return subscribeChange(push);
    },
  };
}
