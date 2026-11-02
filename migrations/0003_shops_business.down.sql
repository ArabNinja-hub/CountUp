-- Rollback 0003: reverse dependency order (0004-0006 down scripts run first).

DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS stock_conflicts;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS credit_ledger_entries;
DROP TABLE IF EXISTS sale_items;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS credit_payments;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS entitlement_snapshots;
DROP TABLE IF EXISTS shop_members;
DROP TABLE IF EXISTS shops;

DROP TYPE IF EXISTS expense_category;
DROP TYPE IF EXISTS stock_conflict_kind;
DROP TYPE IF EXISTS stock_movement_type;
DROP TYPE IF EXISTS payment_method;
DROP TYPE IF EXISTS momo_operator;
DROP TYPE IF EXISTS payment_type;
DROP TYPE IF EXISTS plan_type;
DROP TYPE IF EXISTS plan_status;
