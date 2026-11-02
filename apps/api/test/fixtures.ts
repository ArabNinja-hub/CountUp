import type { QueryExecutor, QueryResultRow } from '../src/db/query-executor';
import { firstRow } from './isolated-database';

interface IdRow extends QueryResultRow {
  id: string;
}

/** Every INSERT uses bind parameters. No fixture concatenates values into SQL. */
async function insertReturningId(
  executor: QueryExecutor,
  sql: string,
  values: readonly unknown[],
  label: string
): Promise<string> {
  const { rows } = await executor.query<IdRow>(sql, values);
  return firstRow(rows, label).id;
}

export function createUser(executor: QueryExecutor, name: string): Promise<string> {
  return insertReturningId(
    executor,
    'INSERT INTO users (display_name) VALUES ($1) RETURNING id',
    [name],
    'createUser'
  );
}

export function createShop(
  executor: QueryExecutor,
  ownerUserId: string,
  name: string
): Promise<string> {
  return insertReturningId(
    executor,
    'INSERT INTO shops (owner_user_id, name) VALUES ($1, $2) RETURNING id',
    [ownerUserId, name],
    'createShop'
  );
}

export function createItem(
  executor: QueryExecutor,
  shopId: string,
  name: string,
  sellPriceNgwee = 1000
): Promise<string> {
  return insertReturningId(
    executor,
    `INSERT INTO items (shop_id, name, sell_price_ngwee, quantity)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [shopId, name, sellPriceNgwee, 10],
    'createItem'
  );
}

export function createCustomer(
  executor: QueryExecutor,
  shopId: string,
  name: string
): Promise<string> {
  return insertReturningId(
    executor,
    'INSERT INTO customers (shop_id, name) VALUES ($1, $2) RETURNING id',
    [shopId, name],
    'createCustomer'
  );
}

export function createSale(
  executor: QueryExecutor,
  shopId: string,
  customerId: string | null,
  totalNgwee = 1000
): Promise<string> {
  return insertReturningId(
    executor,
    `INSERT INTO sales (shop_id, customer_id, total_ngwee) VALUES ($1, $2, $3) RETURNING id`,
    [shopId, customerId, totalNgwee],
    'createSale'
  );
}

export interface Tenant {
  userId: string;
  shopId: string;
  itemId: string;
  customerId: string;
  saleId: string;
}

export async function seedTenant(executor: QueryExecutor, label: string): Promise<Tenant> {
  const userId = await createUser(executor, `owner-${label}`);
  const shopId = await createShop(executor, userId, `shop-${label}`);
  const itemId = await createItem(executor, shopId, `item-${label}`);
  const customerId = await createCustomer(executor, shopId, `customer-${label}`);
  const saleId = await createSale(executor, shopId, null);
  return { userId, shopId, itemId, customerId, saleId };
}
