-- Rollback 0002. Dependent tenant tables are dropped by 0003 down first.

DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS otp_challenges;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS credentials;
DROP TABLE IF EXISTS auth_identities;
DROP TABLE IF EXISTS users;
