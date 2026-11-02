-- Rollback 0001. Tables in later migrations that reference these types/functions are
-- dropped by 0006 -> 0002 down scripts BEFORE this file runs.

DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS system_config;

DROP FUNCTION IF EXISTS deny_mutation();
DROP FUNCTION IF EXISTS set_local_date();
DROP FUNCTION IF EXISTS set_updated_at();

DROP TYPE IF EXISTS identity_kind;
DROP TYPE IF EXISTS shop_role;
DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS user_role;
