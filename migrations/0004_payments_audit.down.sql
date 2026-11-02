-- Rollback 0004.

DROP TABLE IF EXISTS provider_events;
DROP TABLE IF EXISTS platform_audit;
DROP TABLE IF EXISTS payment_proofs;
DROP TABLE IF EXISTS payment_reference_locks;
DROP TABLE IF EXISTS subscription_payments;

DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS payment_network;
