// Run against a local Firestore emulator with this repository's rules loaded.
// No production project or credentials are used. See README for setup.
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
if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1) {
  throw new Error('For safety, rule tests only connect to a local Firestore emulator.');
}
const projectId = process.env.GCLOUD_PROJECT || 'demo-countup';
if (!projectId.startsWith('demo-')) throw new Error('Use a demo-* project ID for rule tests.');
const databaseId = 'ai-studio-6763e195-ebd5-4984-ba25-2f9dabfe7719';
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const shopId = `shop_rules_${suffix}`;
const ownerId = `owner_${suffix}`;
const otherId = `other_${suffix}`;
const adminId = `admin_${suffix}`;
const apps = [];
setLogLevel('silent');

function client(uid) {
  const app = initializeApp(
    { projectId, apiKey: 'emulator-only', appId: 'rules-test' },
    uid || 'guest'
  );
  apps.push(app);
  const db = getFirestore(app, databaseId);
  connectFirestoreEmulator(
    db,
    host,
    port,
    uid ? { mockUserToken: { sub: uid, user_id: uid } } : undefined
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
async function seedAdmin(method) {
  const url = `http://${host}:${port}/v1/projects/${projectId}/databases/${databaseId}/documents/admins/${adminId}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    ...(method === 'PATCH'
      ? { body: JSON.stringify({ fields: { active: { booleanValue: true } } }) }
      : {}),
  });
  if (!response.ok)
    throw new Error(`Emulator admin seed failed: ${response.status} ${await response.text()}`);
}

const owner = client(ownerId);
const other = client(otherId);
const guest = client();
const admin = client(adminId);
const ownerShop = doc(owner, 'shops', shopId);
const otherShop = doc(other, 'shops', shopId);
const adminShop = doc(admin, 'shops', shopId);
const now = new Date().toISOString();
const shop = {
  id: shopId,
  name: 'Emulator test shop',
  ownerPhone: '0977000000',
  ownerUid: ownerId,
  pin: '1234',
  planStatus: 'trial',
  planType: 'trial',
  isDeactivated: false,
  trialEndsAt: now,
  planExpiryDate: now,
  createdAt: now,
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
let seededAdmin = false;
try {
  await denied(
    'cannot create a paid shop',
    setDoc(doc(other, 'shops', `${shopId}_paid`), {
      ...shop,
      ownerUid: otherId,
      planStatus: 'active',
    })
  );
  await allowed('owner creates a trial shop', setDoc(ownerShop, shop));
  await allowed('owner reads own shop', getDoc(ownerShop));
  await denied('other user reads shop', getDoc(otherShop));
  await denied('unauthenticated user reads shop', getDoc(doc(guest, 'shops', shopId)));
  await allowed(
    'owner queries own shops',
    getDocs(query(collection(owner, 'shops'), where('ownerUid', '==', ownerId)))
  );
  await denied('other user lists all shops', getDocs(collection(other, 'shops')));
  await denied('owner changes plan', updateDoc(ownerShop, { planStatus: 'active' }));
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
    'owner can atomically update stock and an operation marker',
    runTransaction(owner, async (transaction) => {
      const item = doc(owner, 'shops', shopId, 'items', 'example');
      const before = await transaction.get(item);
      transaction.update(item, { quantity: before.data().quantity - 1 });
      transaction.set(doc(owner, 'shops', shopId, 'sync_operations', 'transaction'), {
        applied: true,
      });
    })
  );
  await denied(
    'user cannot grant their own admin access',
    setDoc(doc(other, 'admins', otherId), {})
  );
  await seedAdmin('PATCH');
  seededAdmin = true;
  await allowed('platform admin reads a shop', getDoc(adminShop));
  await allowed('platform admin changes its plan', updateDoc(adminShop, { planStatus: 'active' }));
  await denied('other user deletes a shop', deleteDoc(otherShop));
  for (const name of subcollections) await deleteDoc(doc(owner, 'shops', shopId, name, 'example'));
  await deleteDoc(doc(owner, 'shops', shopId, 'sync_operations', 'transaction'));
  await allowed('owner deletes own shop', deleteDoc(ownerShop));
  console.log(
    'Firestore rule checks passed. Repeat against the official emulator before deployment.'
  );
} finally {
  if (seededAdmin) await seedAdmin('DELETE');
  for (const db of [owner, other, guest, admin]) await terminate(db);
  for (const app of apps) await deleteApp(app);
}
