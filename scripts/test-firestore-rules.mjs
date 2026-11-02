// Local-only Firestore authorization checks. No production project or credentials.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  runTransaction,
  setDoc,
  setLogLevel,
  terminate,
  updateDoc,
  where,
} from 'firebase/firestore';

const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint) throw new Error('Set FIRESTORE_EMULATOR_HOST to the local emulator host and port.');
const [host, rawPort] = endpoint.split(':');
const port = Number(rawPort);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1)
  throw new Error('For safety, rule tests only connect to a local Firestore emulator.');
const projectId = process.env.GCLOUD_PROJECT || 'demo-countup';
if (!projectId.startsWith('demo-')) throw new Error('Use a demo-* project ID for rule tests.');
const databaseId = 'ai-studio-6763e195-ebd5-4984-ba25-2f9dabfe7719';
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shopId = `shop_rules_${suffix}`;
const ownerId = `owner_${suffix}`;
const otherId = `other_${suffix}`;
const adminId = `admin_${suffix}`;
const paymentId = `payment_${suffix}`;
const referenceLockId = `lock_${suffix}`;
const apps = [];
setLogLevel('silent');

function client(uid, claims = {}) {
  const app = initializeApp(
    { projectId, apiKey: 'emulator-only', appId: 'rules-test' },
    `${uid || 'guest'}_${apps.length}`
  );
  apps.push(app);
  const db = getFirestore(app, databaseId);
  connectFirestoreEmulator(
    db,
    host,
    port,
    uid ? { mockUserToken: { sub: uid, user_id: uid, ...claims } } : undefined
  );
  return db;
}
async function denied(label, action) {
  await assert.rejects(action, (error) => error.code === 'permission-denied', label);
  console.log(`PASS denied: ${label}`);
}
async function allowed(label, action) {
  await action;
  console.log(`PASS allowed: ${label}`);
}
async function seedDocument(collectionName, documentId, fields) {
  const url = `http://${host}:${port}/v1/projects/${projectId}/databases/${databaseId}/documents/${collectionName}/${documentId}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer emulator-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!response.ok)
    throw new Error(`Emulator seed failed: ${response.status} ${await response.text()}`);
}
async function removeSeed(collectionName, documentId) {
  const url = `http://${host}:${port}/v1/projects/${projectId}/databases/${databaseId}/documents/${collectionName}/${documentId}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: 'Bearer emulator-admin' } });
}

const owner = client(ownerId);
const other = client(otherId);
const emailOnly = client(`email_only_${suffix}`, {
  email: 'platform-admin@example.test',
  email_verified: true,
});
const guest = client();
const admin = client(adminId, { platformAdmin: true });
const ownerShop = doc(owner, 'shops', shopId);
const otherShop = doc(other, 'shops', shopId);
const adminShop = doc(admin, 'shops', shopId);
const now = new Date();
const trialEndsAt = new Date(now.getTime() + 30 * 86400000);
const shop = {
  id: shopId,
  name: 'Emulator test shop',
  ownerPhone: '0977000000',
  ownerUid: ownerId,
  pin: '1234',
  planStatus: 'trial',
  planType: 'trial',
  isDeactivated: false,
  trialEndsAt: trialEndsAt.toISOString(),
  planExpiryDate: trialEndsAt.toISOString(),
  trialEndsAtMs: trialEndsAt.getTime(),
  planExpiryAtMs: trialEndsAt.getTime(),
  salesAccessUntilMs: trialEndsAt.getTime() + 3 * 86400000,
  createdAt: now.toISOString(),
  currency: 'ZMW',
};
const subcollections = [
  'items',
  'sales',
  'customers',
  'credit_payments',
  'expenses',
  'stock_movements',
  'stock_conflicts',
  'sync_operations',
];
let seeded = false;
try {
  await denied(
    'ordinary user cannot create a paid shop',
    setDoc(doc(other, 'shops', `${shopId}_paid`), {
      ...shop,
      ownerUid: otherId,
      planStatus: 'active',
    })
  );
  const excessiveTrialExpiry = Date.now() + 365 * 86400000;
  await denied(
    'ordinary user cannot grant an excessive free trial',
    setDoc(doc(other, 'shops', `${shopId}_long_trial`), {
      ...shop,
      ownerUid: otherId,
      trialEndsAt: new Date(excessiveTrialExpiry).toISOString(),
      planExpiryDate: new Date(excessiveTrialExpiry).toISOString(),
      trialEndsAtMs: excessiveTrialExpiry,
      planExpiryAtMs: excessiveTrialExpiry,
      salesAccessUntilMs: excessiveTrialExpiry + 3 * 86400000,
    })
  );
  await denied(
    'ordinary user cannot extend the free-trial grace window',
    setDoc(doc(other, 'shops', `${shopId}_long_grace`), {
      ...shop,
      ownerUid: otherId,
      salesAccessUntilMs: shop.salesAccessUntilMs + 365 * 86400000,
    })
  );
  await allowed('owner creates a free trial shop', setDoc(ownerShop, shop));
  await allowed('owner reads own shop', getDoc(ownerShop));
  await denied('other user reads shop', getDoc(otherShop));
  await denied(
    'email alone does not grant platform admin',
    getDocs(collection(emailOnly, 'shops'))
  );
  await denied('unauthenticated user reads shop', getDoc(doc(guest, 'shops', shopId)));
  await allowed(
    'owner queries own shops',
    getDocs(query(collection(owner, 'shops'), where('ownerUid', '==', ownerId)))
  );
  await denied('other user lists all shops', getDocs(collection(other, 'shops')));
  await denied('owner changes subscription status', updateDoc(ownerShop, { planStatus: 'active' }));
  await denied('owner changes deactivation status', updateDoc(ownerShop, { isDeactivated: true }));
  await denied('other user changes plan', updateDoc(otherShop, { planStatus: 'active' }));
  await denied('owner changes ownership', updateDoc(ownerShop, { ownerUid: otherId }));
  await denied('owner changes PIN to an invalid value', updateDoc(ownerShop, { pin: 'abc' }));
  await allowed('owner changes PIN', updateDoc(ownerShop, { pin: '4321' }));

  for (const name of subcollections) {
    await allowed(
      `owner writes ${name}`,
      setDoc(doc(owner, 'shops', shopId, name, 'example'), { id: 'example', quantity: 3 })
    );
    await denied(`other user reads ${name}`, getDoc(doc(other, 'shops', shopId, name, 'example')));
    await denied(
      `other user writes ${name}`,
      setDoc(doc(other, 'shops', shopId, name, 'example'), { id: 'bad' })
    );
  }
  await allowed(
    'owner atomically updates stock and an operation marker',
    runTransaction(owner, async (transaction) => {
      const item = doc(owner, 'shops', shopId, 'items', 'example');
      const before = await transaction.get(item);
      transaction.update(item, { quantity: before.data().quantity - 1 });
      transaction.set(doc(owner, 'shops', shopId, 'sync_operations', 'transaction'), {
        applied: true,
      });
    })
  );

  await denied('client cannot read retired admin registry', getDoc(doc(owner, 'admins', ownerId)));
  await denied(
    'client cannot self-promote through admin registry',
    setDoc(doc(owner, 'admins', ownerId), {})
  );
  await seedDocument('subscriptionPayments', paymentId, {
    ownerUid: { stringValue: ownerId },
    shopId: { stringValue: shopId },
    status: { stringValue: 'pending' },
    transactionReference: { stringValue: 'TEST-REF-12345' },
  });
  await seedDocument('paymentReferenceLocks', referenceLockId, {
    paymentId: { stringValue: paymentId },
  });
  await seedDocument('platformAudit', `audit_${suffix}`, { action: { stringValue: 'test' } });
  seeded = true;

  await allowed(
    'shop owner reads own payment record',
    getDoc(doc(owner, 'subscriptionPayments', paymentId))
  );
  await allowed(
    'shop owner queries own payment history',
    getDocs(query(collection(owner, 'subscriptionPayments'), where('ownerUid', '==', ownerId)))
  );
  await denied(
    'shop owner cannot query all payment records',
    getDocs(collection(owner, 'subscriptionPayments'))
  );
  await denied(
    'another shop cannot read payment record',
    getDoc(doc(other, 'subscriptionPayments', paymentId))
  );
  await denied(
    'client cannot create payment records directly',
    setDoc(doc(owner, 'subscriptionPayments', `client_${suffix}`), { ownerUid: ownerId })
  );
  await denied(
    'client cannot alter payment review state',
    updateDoc(doc(owner, 'subscriptionPayments', paymentId), { status: 'approved' })
  );
  await denied(
    'reference locks are private',
    getDoc(doc(admin, 'paymentReferenceLocks', referenceLockId))
  );
  await denied(
    'owner cannot read platform audit trail',
    getDocs(collection(owner, 'platformAudit'))
  );
  await allowed(
    'platform administrator reads audit trail',
    getDocs(collection(admin, 'platformAudit'))
  );
  await denied(
    'admin operations cannot be faked with a client audit write',
    setDoc(doc(admin, 'platformAudit', `fake_${suffix}`), { action: 'fake' })
  );

  await allowed('platform admin lists shops', getDocs(collection(admin, 'shops')));
  await allowed('platform admin reads a shop', getDoc(adminShop));
  await allowed(
    'platform admin changes a shop plan',
    updateDoc(adminShop, { planStatus: 'active' })
  );
  await allowed('platform admin can suspend a shop', updateDoc(adminShop, { isDeactivated: true }));
  await denied(
    'owner cannot reactivate a suspended shop',
    updateDoc(ownerShop, { isDeactivated: false })
  );
  await allowed(
    'platform admin reads all payment records',
    getDocs(collection(admin, 'subscriptionPayments'))
  );
  await allowed(
    'platform admin reads payment review history',
    getDoc(doc(admin, 'subscriptionPayments', paymentId))
  );
  await denied('other user deletes a shop', deleteDoc(otherShop));
  for (const name of subcollections) await deleteDoc(doc(owner, 'shops', shopId, name, 'example'));
  await deleteDoc(doc(owner, 'shops', shopId, 'sync_operations', 'transaction'));
  await allowed('owner deletes own shop', deleteDoc(ownerShop));
  console.log('Firestore rule checks passed against local demo emulator.');
} finally {
  for (const db of [owner, other, emailOnly, guest, admin]) await terminate(db);
  for (const app of apps) await deleteApp(app);
  if (seeded) {
    await removeSeed('subscriptionPayments', paymentId);
    await removeSeed('paymentReferenceLocks', referenceLockId);
    await removeSeed('platformAudit', `audit_${suffix}`);
  }
}
