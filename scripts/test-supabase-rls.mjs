// End-to-end RLS, Session Binding, TOTP MFA (aal2) & Phase 3a Overlap Sync
// verification against a REAL local Supabase stack (`supabase start`).
// Never connects to remote hosts.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.API_URL || 'http://127.0.0.1:54321';
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;

const parsedUrl = new URL(supabaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname)) {
  throw new Error(`Refusing to run RLS tests against non-local host: ${parsedUrl.hostname}`);
}
if (!anonKey || !serviceRoleKey) {
  throw new Error(
    'Set SUPABASE_ANON_KEY (or ANON_KEY) and SUPABASE_SERVICE_ROLE_KEY (or SERVICE_ROLE_KEY) from `supabase status -o env`.'
  );
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'Expected a 3-part JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// RFC 6238 / RFC 4648 Base32 TOTP generator for real GoTrue MFA aal2 verification
function decodeBase32(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    assert.ok(idx >= 0, `Invalid base32 character: ${ch}`);
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotpCode(secretBase32, timestampMs = Date.now()) {
  const key = decodeBase32(secretBase32);
  const counter = BigInt(Math.floor(timestampMs / 1000 / 30));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter, 0);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function makeAnonClient() {
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const adminDb = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const password = `TestPass!${suffix}`;
const shopAId = randomUUID();
const shopBId = randomUUID();
const shopCId = randomUUID();
const createdUserIds = [];

try {
  // 1. Create real GoTrue users via service_role
  const { data: userARes, error: errA } = await adminDb.auth.admin.createUser({
    email: `owner_a_${suffix}@countup.local`,
    phone: `+26097${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`,
    password,
    email_confirm: true,
    phone_confirm: true,
  });
  assert.ifError(errA);
  createdUserIds.push(userARes.user.id);

  const { data: userBRes, error: errB } = await adminDb.auth.admin.createUser({
    email: `owner_b_${suffix}@countup.local`,
    phone: `+26096${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`,
    password,
    email_confirm: true,
    phone_confirm: true,
  });
  assert.ifError(errB);
  createdUserIds.push(userBRes.user.id);

  const { data: adminRes, error: errAdmin } = await adminDb.auth.admin.createUser({
    email: `platform_admin_${suffix}@countup.local`,
    password,
    email_confirm: true,
    app_metadata: { platform_admin: true },
  });
  assert.ifError(errAdmin);
  createdUserIds.push(adminRes.user.id);

  // 2. Seed Shop A & Shop B + platform_audit + platform_alerts via service_role
  const now = Date.now();
  const trialEnds = new Date(now + 30 * 86_400_000).toISOString();
  const accessUntil = new Date(now + 33 * 86_400_000).toISOString();

  for (const [shopId, user, name, phone] of [
    [shopAId, userARes.user, 'Lusaka Shop A', '+260977111222'],
    [shopBId, userBRes.user, 'Ndola Shop B', '+260966333444'],
  ]) {
    assert.ifError(
      (
        await adminDb.from('shops').insert({
          id: shopId,
          owner_user_id: user.id,
          name,
          owner_phone: phone,
          plan_status: 'trial',
          plan_type: 'trial',
          trial_ends_at: trialEnds,
          plan_expiry_at: trialEnds,
          sales_access_until: accessUntil,
        })
      ).error
    );

    assert.ifError(
      (
        await adminDb.from('shop_pin_credentials').insert({
          shop_id: shopId,
          pin_salt: 'a'.repeat(32),
          pin_hash: 'b'.repeat(64),
          recovery_salt: 'c'.repeat(32),
          recovery_hash: 'd'.repeat(64),
        })
      ).error
    );

    assert.ifError(
      (
        await adminDb.from('items').insert({
          shop_id: shopId,
          id: 'item_1',
          name: 'Sugar 2kg',
          buying_price_ngwee: 4500,
          selling_price_ngwee: 5500,
          quantity: 12,
        })
      ).error
    );
    assert.ifError(
      (
        await adminDb.from('customers').insert({
          shop_id: shopId,
          id: 'cust_1',
          name: 'Mutale',
          total_owed_ngwee: 5500,
        })
      ).error
    );
    assert.ifError(
      (
        await adminDb.from('sales').insert({
          shop_id: shopId,
          id: 'sale_1',
          items_count: 1,
          total_amount_ngwee: 5500,
          total_cost_ngwee: 4500,
          profit_ngwee: 1000,
          missing_cost_revenue_ngwee: 0,
          payment_type: 'credit',
          customer_id: 'cust_1',
          receipt_number: 'CU-TEST-001',
        })
      ).error
    );
    assert.ifError(
      (
        await adminDb.from('sale_lines').insert({
          shop_id: shopId,
          id: 'line_1',
          sale_id: 'sale_1',
          item_id: 'item_1',
          item_name: 'Sugar 2kg',
          quantity: 1,
          buying_price_ngwee: 4500,
          selling_price_ngwee: 5500,
          line_total_ngwee: 5500,
        })
      ).error
    );
    assert.ifError(
      (
        await adminDb.from('stock_movements').insert([
          {
            shop_id: shopId,
            id: 'mv_init_1',
            item_id: 'item_1',
            item_name: 'Sugar 2kg',
            type: 'initial',
            delta: 13,
            previous_quantity: 0,
            new_quantity: 13,
            reason: 'Initial stock',
          },
          {
            shop_id: shopId,
            id: 'mv_sale_1',
            item_id: 'item_1',
            item_name: 'Sugar 2kg',
            type: 'sale',
            delta: -1,
            previous_quantity: 13,
            new_quantity: 12,
            reason: 'Sale CU-TEST-001',
            related_sale_id: 'sale_1',
          },
        ])
      ).error
    );
    assert.ifError(
      (
        await adminDb.from('subscription_payments').insert({
          shop_id: shopId,
          shop_name_snapshot: name,
          owner_user_id: user.id,
          network: 'mtn',
          plan_id: 'monthly',
          transaction_reference: `REF-${shopId.slice(0, 8).toUpperCase()}`,
          payer_phone: phone,
          payment_date: '2026-11-20',
          amount_ngwee: 9900,
          status: 'pending',
        })
      ).error
    );
  }

  assert.ifError(
    (
      await adminDb.from('platform_audit').insert({
        action: 'rls_ci_seed',
        actor_user_id: adminRes.user.id,
        shop_id: shopAId,
      })
    ).error
  );
  assert.ifError(
    (
      await adminDb.from('platform_alerts').insert({
        alert_key: `ci_sms_alert_${suffix}`,
        severity: 'critical',
        category: 'sms_cap',
        title: 'Daily SMS cap reached (CI test)',
        detail: 'Simulated cap alert for MFA aal2 verification',
      })
    ).error
  );

  // 3. Follow-up #2: End-to-end GoTrue session_id binding (concurrent sessions + refresh)
  const clientA1 = makeAnonClient();
  const { data: signInA1, error: signInA1Err } = await clientA1.auth.signInWithPassword({
    email: `owner_a_${suffix}@countup.local`,
    password,
  });
  assert.ifError(signInA1Err);

  const clientA2 = makeAnonClient();
  const { data: signInA2, error: signInA2Err } = await clientA2.auth.signInWithPassword({
    email: `owner_a_${suffix}@countup.local`,
    password,
  });
  assert.ifError(signInA2Err);

  const initialClaimsA1 = decodeJwtPayload(signInA1.session.access_token);
  const initialClaimsA2 = decodeJwtPayload(signInA2.session.access_token);
  assert.notEqual(
    initialClaimsA1.session_id,
    initialClaimsA2.session_id,
    'Two separate sign-ins for the same user must get distinct GoTrue session_ids'
  );
  assert.equal(initialClaimsA1.app_metadata?.shop_id, undefined);
  assert.equal(initialClaimsA1.app_metadata?.pending_pin_verification, true);

  // Unverified session cannot read shops or items
  assert.deepEqual((await clientA1.from('shops').select('id')).data, []);
  assert.deepEqual((await clientA1.from('items').select('id')).data, []);

  // Verify ONLY session A1 (simulating PIN unlock on Phone 1)
  assert.ifError(
    (
      await adminDb.from('shop_verified_sessions').insert({
        shop_id: shopAId,
        session_id: initialClaimsA1.session_id,
        user_id: userARes.user.id,
      })
    ).error
  );

  // Refreshing A1 injects shop_id AND subsequent refresh preserves binding!
  const { data: refreshedA1, error: refreshErrA1 } = await clientA1.auth.refreshSession();
  assert.ifError(refreshErrA1);
  assert.equal(decodeJwtPayload(refreshedA1.session.access_token).app_metadata?.shop_id, shopAId);

  const { data: refreshedA1Again, error: refreshErrA1Again } = await clientA1.auth.refreshSession();
  assert.ifError(refreshErrA1Again);
  assert.equal(
    decodeJwtPayload(refreshedA1Again.session.access_token).app_metadata?.shop_id,
    shopAId,
    'Token refresh on verified session must preserve session_id PIN binding'
  );

  // Refreshing A2 (same user, DIFFERENT session_id!) MUST NOT inherit A1's PIN verification!
  const { data: refreshedA2, error: refreshErrA2 } = await clientA2.auth.refreshSession();
  assert.ifError(refreshErrA2);
  const claimsA2After = decodeJwtPayload(refreshedA2.session.access_token);
  assert.equal(
    claimsA2After.app_metadata?.shop_id,
    undefined,
    'Concurrent session A2 for the same user must NOT inherit A1 PIN verification'
  );
  assert.deepEqual((await clientA2.from('items').select('id')).data, []);
  console.log(
    'PASS: PIN verification is strictly bound to GoTrue session_id across concurrent sessions and refreshes'
  );

  // Verify User B as well for tenant isolation checks
  const clientB = makeAnonClient();
  const { data: signInB, error: signInBErr } = await clientB.auth.signInWithPassword({
    email: `owner_b_${suffix}@countup.local`,
    password,
  });
  assert.ifError(signInBErr);
  const claimsB = decodeJwtPayload(signInB.session.access_token);
  assert.ifError(
    (
      await adminDb.from('shop_verified_sessions').insert({
        shop_id: shopBId,
        session_id: claimsB.session_id,
        user_id: userBRes.user.id,
      })
    ).error
  );
  await clientB.auth.refreshSession();

  // 4. Tenant Isolation: Shop A sees Shop A only, never Shop B
  for (const tbl of ['items', 'customers', 'sales', 'sale_lines', 'subscription_payments']) {
    const { data: rows, error } = await clientA1.from(tbl).select('shop_id');
    assert.ifError(error);
    assert.deepEqual(rows, [{ shop_id: shopAId }], `Shop A should only see its own ${tbl}`);

    const { data: crossRows, error: crossErr } = await clientA1
      .from(tbl)
      .select('shop_id')
      .eq('shop_id', shopBId);
    assert.ifError(crossErr);
    assert.deepEqual(crossRows, [], `Shop A must not read Shop B in ${tbl}`);
  }
  console.log('PASS: Shop A is strictly isolated from Shop B across reads and writes');

  // 5. Phase 3a Overlap Cursor Query Check (`updated_at >= cursor - 120s`)
  const { data: initialItems, error: initItemsErr } = await clientA1
    .from('items')
    .select('id, updated_at, selling_price_ngwee')
    .eq('shop_id', shopAId)
    .order('updated_at', { ascending: true });
  assert.ifError(initItemsErr);
  assert.equal(initialItems.length, 1);
  assert.equal(typeof initialItems[0].selling_price_ngwee, 'number');

  const cursorIso = initialItems[0].updated_at;
  const overlapStartIso = new Date(Date.parse(cursorIso) - 120_000).toISOString();
  const { data: overlapItems, error: overlapErr } = await clientA1
    .from('items')
    .select('id, updated_at')
    .eq('shop_id', shopAId)
    .gte('updated_at', overlapStartIso)
    .order('updated_at', { ascending: true });
  assert.ifError(overlapErr);
  assert.equal(overlapItems.length, 1);
  console.log('PASS: Phase 3a PostgREST (cursor - 120s) overlap query verified');

  // 6. Anon has zero table access & clients cannot mutate invariant columns
  const anon = makeAnonClient();
  assert.ok((await anon.from('shops').select('id')).error, 'anon must be denied on shops');
  assert.ok(
    (await clientA1.from('shops').update({ plan_status: 'active' }).eq('id', shopAId)).error,
    'Client must not change plan_status'
  );
  assert.ok(
    (
      await clientA1
        .from('items')
        .update({ quantity: 999 })
        .eq('shop_id', shopAId)
        .eq('id', 'item_1')
    ).error,
    'Client must not directly change items.quantity'
  );

  // 7. Follow-up #5: Real GoTrue TOTP MFA (`aal1` denied -> enroll & verify TOTP -> `aal2` granted!)
  const adminClient = makeAnonClient();
  const { data: adminSignIn, error: adminLoginErr } = await adminClient.auth.signInWithPassword({
    email: `platform_admin_${suffix}@countup.local`,
    password,
  });
  assert.ifError(adminLoginErr);
  assert.equal(decodeJwtPayload(adminSignIn.session.access_token).aal, 'aal1');

  // At aal1, platform_admin MUST see ZERO rows in platform_audit, platform_alerts, and shops!
  assert.deepEqual(
    (await adminClient.from('platform_audit').select('action').eq('shop_id', shopAId)).data,
    [],
    'platform_admin at aal1 MUST be blocked from reading platform_audit'
  );
  assert.deepEqual(
    (
      await adminClient
        .from('platform_alerts')
        .select('alert_key')
        .eq('alert_key', `ci_sms_alert_${suffix}`)
    ).data,
    [],
    'platform_admin at aal1 MUST be blocked from reading platform_alerts'
  );

  // At aal1, platform_admin MUST ALSO be rejected by reconcile_shop_ledger!
  const { error: reconAal1Err } = await adminClient.rpc('reconcile_shop_ledger', {
    p_shop_id: null,
  });
  assert.ok(reconAal1Err, 'platform_admin at aal1 MUST be blocked from reconcile_shop_ledger');

  // Enroll real TOTP factor in GoTrue and verify a 6-digit code to elevate session to aal2!
  const { data: enrolled, error: enrollErr } = await adminClient.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'CI Admin Authenticator',
  });
  assert.ifError(enrollErr);

  const totpCode = generateTotpCode(enrolled.totp.secret);
  const { data: mfaVerified, error: mfaVerifyErr } = await adminClient.auth.mfa.challengeAndVerify({
    factorId: enrolled.id,
    code: totpCode,
  });
  assert.ifError(mfaVerifyErr);
  assert.equal(
    decodeJwtPayload(mfaVerified.access_token).aal,
    'aal2',
    'GoTrue session must upgrade to aal2 after TOTP verification'
  );

  // Now at aal2, platform_admin CAN read platform_audit and platform_alerts (while direct client writes stay blocked)
  const { data: adminAuditsAal2, error: adminAuditErr } = await adminClient
    .from('platform_audit')
    .select('action')
    .eq('shop_id', shopAId);
  assert.ifError(adminAuditErr);
  assert.deepEqual(adminAuditsAal2, [{ action: 'rls_ci_seed' }]);

  const { data: adminAlertsAal2, error: adminAlertErr } = await adminClient
    .from('platform_alerts')
    .select('alert_key')
    .eq('alert_key', `ci_sms_alert_${suffix}`);
  assert.ifError(adminAlertErr);
  assert.deepEqual(adminAlertsAal2, [{ alert_key: `ci_sms_alert_${suffix}` }]);

  const { error: adminPlanWriteErr } = await adminClient
    .from('shops')
    .update({ is_deactivated: true })
    .eq('id', shopAId);
  assert.ok(adminPlanWriteErr, 'Even platform_admin aal2 client session must use Edge Functions');
  console.log('PASS: GoTrue TOTP MFA (aal2) strictly enforced for platform_admin');

  // 8. Phase 3b Live PostgREST Write RPCs, Idempotency, Last-Unit Shortfall & Ledger Reconciliation
  assert.ok(
    (
      await clientA2.rpc('record_sale', {
        p_shop_id: shopAId,
        p_operation_id: 'ci_unverified_sale',
        p_sale_id: 'sale_unverified',
        p_lines: [
          {
            item_id: 'item_1',
            item_name: 'Sugar 2kg',
            quantity: 1,
            selling_price_ngwee: 5500,
            buying_price_ngwee: 4500,
            buying_price_known: true,
          },
        ],
        p_payment_type: 'cash',
        p_receipt_number: 'CU-UNV',
      })
    ).error,
    'OTP-only unverified session must be rejected by record_sale RPC'
  );

  assert.ok(
    (
      await clientB.rpc('record_sale', {
        p_shop_id: shopAId,
        p_operation_id: 'ci_cross_shop_sale',
        p_sale_id: 'sale_cross',
        p_lines: [
          {
            item_id: 'item_1',
            item_name: 'Sugar 2kg',
            quantity: 1,
            selling_price_ngwee: 5500,
            buying_price_ngwee: 4500,
            buying_price_known: true,
          },
        ],
        p_payment_type: 'cash',
        p_receipt_number: 'CU-CROSS',
      })
    ).error,
    'Shop B verified session must be rejected by record_sale RPC on Shop A'
  );

  // Verified Shop A session executes atomic batch: create 1-unit item -> two 1-unit sales (oversell!) -> repayment -> undo twice
  const { data: batchRes, error: batchErr } = await clientA1.rpc('apply_sync_batch', {
    p_shop_id: shopAId,
    p_operations: [
      {
        rpc: 'upsert_shop_item',
        operation_id: 'ci_op_item_2',
        item_id: 'item_2',
        patch: {
          name: 'Bread Loaf',
          buying_price_ngwee: 1800,
          buying_price_known: true,
          selling_price_ngwee: 2500,
          quantity: 1,
        },
        initial_movement: { id: 'mv_ci_init_2', reason: 'Initial stock' },
      },
      {
        rpc: 'record_sale',
        operation_id: 'ci_op_sale_a',
        sale_id: 'ci_sale_a',
        lines: [
          {
            item_id: 'item_2',
            item_name: 'Bread Loaf',
            quantity: 1,
            selling_price_ngwee: 2500,
            buying_price_ngwee: 1800,
            buying_price_known: true,
          },
        ],
        payment_type: 'cash',
        receipt_number: 'CU-CI-A',
        is_offline_sync: true,
      },
      {
        rpc: 'record_sale',
        operation_id: 'ci_op_sale_b',
        sale_id: 'ci_sale_b',
        lines: [
          {
            item_id: 'item_2',
            item_name: 'Bread Loaf',
            quantity: 1,
            selling_price_ngwee: 2500,
            buying_price_ngwee: 1800,
            buying_price_known: true,
          },
        ],
        payment_type: 'cash',
        receipt_number: 'CU-CI-B',
        is_offline_sync: true,
      },
      {
        rpc: 'record_repayment',
        operation_id: 'ci_op_repay_1',
        payment_id: 'ci_pay_1',
        customer_id: 'cust_1',
        amount_ngwee: 2000,
        payment_method: 'momo',
        note: 'Partial repayment',
      },
    ],
  });
  assert.ifError(batchErr);
  assert.equal(batchRes.results.length, 4);
  assert.ok(batchRes.results.every((r) => r.ok === true));
  assert.equal(batchRes.results[2].result.stock_conflicts_created, 1);

  // Replay ci_op_repay_1 -> idempotent duplicate, customer balance stays 3500 ngwee!
  const { data: dupRepay, error: dupRepayErr } = await clientA1.rpc('record_repayment', {
    p_shop_id: shopAId,
    p_operation_id: 'ci_op_repay_1',
    p_payment_id: 'ci_pay_1',
    p_customer_id: 'cust_1',
    p_amount_ngwee: 2000,
    p_payment_method: 'momo',
    p_note: 'Partial repayment',
  });
  assert.ifError(dupRepayErr);
  assert.equal(dupRepay.idempotent, true);

  // Resolve the shortfall conflict via resolve_stock_conflict
  const { error: resConfErr } = await clientA1.rpc('resolve_stock_conflict', {
    p_shop_id: shopAId,
    p_operation_id: 'ci_op_resolve_sc',
    p_conflict_id: 'ci_op_sale_b_0',
  });
  assert.ifError(resConfErr);

  // Verify ledger reconciliation for Shop A (as shop owner) and across ALL shops (as aal2 platform_admin) === 0 differences!
  const { data: shopARecon, error: shopAReconErr } = await clientA1.rpc('reconcile_shop_ledger', {
    p_shop_id: shopAId,
  });
  assert.ifError(shopAReconErr);
  assert.equal(
    shopARecon.total_differences,
    0,
    'Shop A ledger reconciliation must have 0 differences'
  );

  const { data: globalRecon, error: globalReconErr } = await adminClient.rpc(
    'reconcile_shop_ledger',
    {
      p_shop_id: null,
    }
  );
  assert.ifError(globalReconErr);
  assert.equal(
    globalRecon.total_differences,
    0,
    'Global multi-shop ledger reconciliation under aal2 admin must have 0 differences'
  );
  assert.ok(globalRecon.shops_checked >= 2);
  console.log(
    'PASS: Phase 3b atomic write RPCs, idempotency, conflict flagging & reconciliation verified'
  );

  // 9. Phase 3c: import_shop_backup (dry-run, decimal edge cases, empty-shop restore,
  //    duplicate idempotency, non-empty shop guard, platform_audit, reconciliation),
  //    receive-time 72h offline window, and discard-poison audit!
  const { data: userCRes, error: errC } = await adminDb.auth.admin.createUser({
    email: `owner_c_${suffix}@countup.local`,
    phone: `+26095${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`,
    password,
    email_confirm: true,
    phone_confirm: true,
  });
  assert.ifError(errC);
  createdUserIds.push(userCRes.user.id);

  const nowPlus30d = new Date(Date.now() + 30 * 86_400_000).toISOString();
  assert.ifError(
    (
      await adminDb.from('shops').insert({
        id: shopCId,
        owner_user_id: userCRes.user.id,
        name: 'Phase 3c Restore Shop',
        owner_phone: userCRes.user.phone,
        plan_status: 'active',
        plan_type: 'monthly',
        trial_ends_at: nowPlus30d,
        plan_expiry_at: nowPlus30d,
        sales_access_until: nowPlus30d,
      })
    ).error
  );

  const clientC = makeAnonClient();
  const { data: signInC, error: signInCErr } = await clientC.auth.signInWithPassword({
    email: `owner_c_${suffix}@countup.local`,
    password,
  });
  assert.ifError(signInCErr);
  const claimsC = decodeJwtPayload(signInC.session.access_token);
  assert.ifError(
    (
      await adminDb.from('shop_verified_sessions').insert({
        shop_id: shopCId,
        session_id: claimsC.session_id,
        user_id: userCRes.user.id,
      })
    ).error
  );
  await clientC.auth.refreshSession();

  // 9a. Reject > 2 decimal places (`12.505`) inside PostgREST/PostgreSQL `import_shop_backup`
  const badDecimalBackup = {
    format: 'countup-backup-v2',
    exportedAt: '2026-11-20T08:00:00.000Z',
    items: [
      {
        id: 'bad_dec_item',
        name: 'Bad Price',
        buyingPrice: 10,
        buyingPriceKnown: true,
        sellingPrice: 12.505,
        quantity: 2,
        lowStockThreshold: 1,
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-20T08:00:00.000Z',
      },
    ],
    sales: [],
    customers: [],
    creditPayments: [],
    expenses: [],
  };
  const { error: badDecErr } = await clientC.rpc('import_shop_backup', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_bad_dec',
    p_file_sha256: createHash('sha256').update(JSON.stringify(badDecimalBackup)).digest('hex'),
    p_backup: badDecimalBackup,
    p_dry_run: true,
    p_allow_non_empty_shop: false,
  });
  assert.ok(badDecErr, 'import_shop_backup must reject > 2 decimal places (12.505)');

  // 9b. Dry-run preview then real restore of valid `countup-backup-v2` into empty Shop C
  const validV2Backup = {
    format: 'countup-backup-v2',
    version: '2.0',
    exportedAt: '2026-11-20T08:30:00.000Z',
    shop: { id: 'legacy-c', name: 'Chelstone Corner' },
    items: [
      {
        id: 'ci_v2_bread',
        name: 'Bread Loaf',
        buyingPrice: 10,
        buyingPriceKnown: true,
        sellingPrice: 12.5,
        quantity: 6,
        lowStockThreshold: 2,
        isDeleted: false,
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-20T08:00:00.000Z',
      },
    ],
    archivedItems: [],
    customers: [
      {
        id: 'ci_v2_cust',
        name: 'Mutale',
        phone: '+260977999888',
        notes: '',
        totalOwed: 25,
        createdAt: '2026-11-20T08:00:00.000Z',
        updatedAt: '2026-11-20T08:00:00.000Z',
      },
    ],
    sales: [
      {
        id: 'ci_v2_sale',
        items: [
          {
            itemId: 'ci_v2_bread',
            name: 'Bread Loaf',
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
        customerId: 'ci_v2_cust',
        receiptNumber: 'CI-V2-001',
        createdAt: '2026-11-20T08:15:00.000Z',
      },
    ],
    creditPayments: [],
    expenses: [
      {
        id: 'ci_v2_exp',
        category: 'transport',
        amount: 20,
        note: 'Delivery',
        createdAt: '2026-11-20T08:20:00.000Z',
      },
    ],
    stockMovements: [],
  };
  const validSha = createHash('sha256').update(JSON.stringify(validV2Backup)).digest('hex');

  const { data: previewData, error: previewErr } = await clientC.rpc('import_shop_backup', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_preview',
    p_file_sha256: validSha,
    p_backup: validV2Backup,
    p_dry_run: true,
    p_allow_non_empty_shop: false,
  });
  assert.ifError(previewErr);
  assert.equal(previewData.status, 'preview');
  assert.equal(previewData.shop_has_existing_data, false);
  assert.equal(previewData.preview.total_stock_value_ngwee, 7500); // 6 * 1250 ngwee
  assert.equal(previewData.preview.total_owed_ngwee, 2500);

  const { data: restoreData, error: restoreErr } = await clientC.rpc('import_shop_backup', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_commit',
    p_file_sha256: validSha,
    p_backup: validV2Backup,
    p_dry_run: false,
    p_allow_non_empty_shop: false,
  });
  assert.ifError(restoreErr);
  assert.equal(restoreData.status, 'imported');
  assert.equal(restoreData.reconciliation.total_differences, 0);

  // Duplicate restore with same SHA-256 & new operation_id is idempotent
  const { data: dupRestore, error: dupRestoreErr } = await clientC.rpc('import_shop_backup', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_commit_retry',
    p_file_sha256: validSha,
    p_backup: validV2Backup,
    p_dry_run: false,
    p_allow_non_empty_shop: false,
  });
  assert.ifError(dupRestoreErr);
  assert.equal(dupRestore.status, 'duplicate');
  assert.equal(dupRestore.already_imported, true);

  // Non-empty shop refuses a distinct backup unless p_allow_non_empty_shop = true
  const secondBackup = {
    ...validV2Backup,
    items: [
      {
        ...validV2Backup.items[0],
        id: 'ci_v2_salt',
        name: 'Salt',
      },
    ],
    sales: [],
    customers: [],
    expenses: [],
  };
  const { error: nonEmptyErr } = await clientC.rpc('import_shop_backup', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_nonempty',
    p_file_sha256: createHash('sha256').update(JSON.stringify(secondBackup)).digest('hex'),
    p_backup: secondBackup,
    p_dry_run: false,
    p_allow_non_empty_shop: false,
  });
  assert.ok(nonEmptyErr, 'Non-empty shop must refuse restore when p_allow_non_empty_shop is false');

  // Platform admin (aal2) sees platform_audit entry for shop_backup_imported
  const { data: backupAuditRows, error: backupAuditErr } = await adminClient
    .from('platform_audit')
    .select('action, shop_id')
    .eq('shop_id', shopCId)
    .eq('action', 'shop_backup_imported');
  assert.ifError(backupAuditErr);
  assert.equal(backupAuditRows.length, 1);

  // 9c. Receive-time 72h offline window check & discard-poison audit
  const staleClientIso = new Date(Date.now() - 73 * 3_600_000).toISOString();
  const { data: staleSale, error: staleSaleErr } = await clientC.rpc('record_sale', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_stale_sale',
    p_sale_id: 'ci_sale_73h',
    p_lines: [
      {
        item_id: 'ci_v2_bread',
        item_name: 'Bread Loaf',
        quantity: 1,
        selling_price_ngwee: 1250,
        buying_price_ngwee: 1000,
        buying_price_known: true,
      },
    ],
    p_payment_type: 'cash',
    p_receipt_number: 'CI-73H',
    p_client_created_at: staleClientIso,
    p_is_offline_sync: true,
    p_offline_window_seconds: 259200,
  });
  assert.ifError(staleSaleErr);
  assert.equal(staleSale.offline_window_flagged, true);
  assert.equal(staleSale.outcome, 'flagged');

  const { data: poisonRes, error: poisonErr } = await clientC.rpc('resolve_sync_conflict', {
    p_shop_id: shopCId,
    p_operation_id: 'ci_3c_poison_op',
    p_decision: 'discard-poison',
    p_resolution: {
      kind: 'discard-poison',
      actionId: 'ci_3c_poison_op',
      poisonActionType: 'stock_update',
      poisonSummary: 'Stock update for deleted item',
      poisonReason: 'Item not found',
      queuedAt: '2026-11-20T08:00:00.000Z',
      resolvedAt: '2026-11-20T09:00:00.000Z',
    },
    p_context: null,
  });
  assert.ifError(poisonErr);
  assert.equal(poisonRes.status, 'resolved');

  // Final reconciliation across all shops (including restored Shop C) === 0 differences!
  const { data: finalGlobalRecon, error: finalGlobalReconErr } = await adminClient.rpc(
    'reconcile_shop_ledger',
    { p_shop_id: null }
  );
  assert.ifError(finalGlobalReconErr);
  assert.equal(finalGlobalRecon.total_differences, 0);
  console.log(
    'PASS: Phase 3c import_shop_backup, 72h receive-time window, poison-op audit & reconciliation verified'
  );

  console.log(
    'ALL REAL-SUPABASE RLS, SESSION BINDING, MFA (AAL2), OVERLAP SYNC, PHASE 3B & PHASE 3C CHECKS PASSED.'
  );
} finally {
  await adminDb.from('shops').delete().in('id', [shopAId, shopBId, shopCId]);
  await adminDb.from('platform_audit').delete().in('shop_id', [shopAId, shopCId]);
  await adminDb
    .from('platform_alerts')
    .delete()
    .in('alert_key', [`ci_sms_alert_${suffix}`, `offline_window:${shopCId}:ci_sale_73h`]);
  for (const uid of createdUserIds) {
    await adminDb.auth.admin.deleteUser(uid);
  }
}
