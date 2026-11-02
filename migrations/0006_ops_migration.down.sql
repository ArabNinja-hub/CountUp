-- Rollback 0006.

DROP TABLE IF EXISTS export_jobs;
DROP TABLE IF EXISTS restore_drills;
DROP TABLE IF EXISTS backup_runs;
DROP TABLE IF EXISTS cutover_config;
DROP TABLE IF EXISTS legacy_id_map;
DROP TABLE IF EXISTS migration_shop_results;
DROP TABLE IF EXISTS migration_runs;

DROP TYPE IF EXISTS cutover_mode;
DROP TYPE IF EXISTS migration_status;
