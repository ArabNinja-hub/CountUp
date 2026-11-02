-- Rollback 0005.

DROP TABLE IF EXISTS change_log;
DROP TABLE IF EXISTS sync_conflict_reviews;
DROP TABLE IF EXISTS sync_operations;
DROP TABLE IF EXISTS idempotency_keys;

DROP TYPE IF EXISTS idempotency_status;
DROP TYPE IF EXISTS sync_decision;
