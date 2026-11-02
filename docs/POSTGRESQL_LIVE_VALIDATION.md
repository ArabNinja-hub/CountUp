# COUNTUP — Live PostgreSQL Validation (Phase A)

**Date:** 2026-11-02 (Africa/Lusaka)
**Branch:** `arena/cb51ea07-countup`
**Gate result:** **PASS** — M2 was not started until this suite passed.
**This is a real native PostgreSQL server test, NOT a PGlite test.** PGlite is WASM
PostgreSQL running in-process; the suite below connects over TCP with the `pg` driver
to a separate `postgres` backend process.

---

## 1. PostgreSQL version and environment

| Item | Value |
| --- | --- |
| Server | `PostgreSQL 18.6 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit` |
| `current_setting('server_version')` | `18.6` |
| Server encoding / checksums | `UTF8` / `on` |
| Listen address / port | `127.0.0.1` / `55432` |
| Host OS | Debian GNU/Linux 12 (bookworm), sandbox user `user` (non-root) |
| Runtime | Node `v22.22.3`, npm `10.9.8` |
| Driver | `pg@8.23.1` (the actual runtime driver, not PGlite) |
| Vitest | `3.2.7` |

**How the server was obtained.** Docker, `podman`, `postgres`, `initdb`, `pg_ctl`,
`psql` and `pg_config` are all absent in this sandbox (`command -v` returned
`NOT_FOUND`; `docker info` → `docker: command not found`), so Testcontainers was not
possible. Instead, native PostgreSQL 18.6 binaries were taken from the npm package
`@embedded-postgres/linux-x64@18.6.0-beta.19` (23.7 MB tarball / 59.2 MB unpacked),
which ships real `bin/postgres`, `bin/initdb`, `bin/pg_ctl` ELF binaries plus shared
libraries. Missing SONAME symlinks (`libicu*.so.60`, `libpq.so.5`, …) were created and
`LD_LIBRARY_PATH` set to the bundled `lib/`. This is a **genuine PostgreSQL server
process**, not an emulation.

```
initdb -D /tmp/pgdata -U postgres --auth=trust --encoding=UTF8 --locale=C --no-instructions
pg_ctl -D /tmp/pgdata -l /tmp/pglog.log \
  -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/pgsock -c fsync=off -c full_page_writes=off" start
```

Server log confirmed: `starting PostgreSQL 18.6 ... listening on IPv4 address
"127.0.0.1", port 55432 ... database system is ready to accept connections`.

**Isolation / safety.** Every validation run creates a brand-new database named
`countup_validation_<random hex>` from an empty template using `CREATE DATABASE`, and
drops it in `afterAll` with `DROP DATABASE ... WITH (FORCE)`. All fixtures are synthetic
(`shop-liveA`, `shop-liveB`, etc.); no CountUp customer or shop data was used. The
helper `apps/api/test/live/live-database.ts` refuses non-loopback hosts unless
`COUNTUP_ALLOW_REMOTE_TEST_DB=1` is set, and refuses `TEST_DATABASE_URL ===
DATABASE_URL`. Only `127.0.0.1:55432` was used. No production database was contacted.

---

## 2. Commands executed

```bash
# A1 inspection (read-only)
git log -3 --format='%h %s'
cat apps/api/src/db/query-executor.ts apps/api/src/db/migrations.ts ...
cat apps/api/src/db/migrate-cli.ts apps/api/src/config/env.ts
cat apps/api/src/app.ts apps/api/src/server.ts apps/api/src/http/validate.ts
cat apps/api/vitest.config.ts .github/workflows/backend-db.yml package.json
for f in migrations/*.sql; do wc -l "$f"; done

# A2 — driver connectivity probe against the real server
npx tsx --tsconfig apps/api/tsconfig.json - <<'JS'   # pg Client -> SELECT version()
# -> "pg driver connected: PostgreSQL 18.6 ...", "REAL_PG_OK"

# A2 — full live validation suite (13 tests)
export TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres'
npm run test:db:live

# A2 — migration CLI against the same real server (uses a real pg Client)
node --input-type=module - <<'JS'   # CREATE DATABASE countup_cli_probe
export DATABASE_URL='postgresql://postgres@127.0.0.1:55432/countup_cli_probe'
export NODE_ENV=development
npm run db:status
npm run db:migrate
npm run db:migrate          # idempotency
npm run db:status
npm run db:migrate:down
npm run db:migrate
node --input-type=module - <<'JS'   # count tables + ledger rows

# Regression: default PGlite suite still passes after config changes
npm run test:db
npm run typecheck:api
npm run lint
npm run format:check
```

### Reproducible PowerShell procedure (for a local Windows machine)

A ready-to-run script is committed at
**`scripts/live-postgres-validation.ps1`**. Two supported paths:

```powershell
# Path 1 — Docker (isolated disposable PostgreSQL 18 container on port 55432)
cd C:\path\to\CountUp
powershell -ExecutionPolicy Bypass -File .\scripts\live-postgres-validation.ps1 -UseDocker

# Path 2 — locally installed PostgreSQL 18 (psql on PATH, trust auth on 127.0.0.1:55432)
powershell -ExecutionPolicy Bypass -File .\scripts\live-postgres-validation.ps1 `
  -AdminUrl 'postgresql://postgres@127.0.0.1:55432/postgres'
```

Equivalent manual commands (Path 2):

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/postgres'
$env:NODE_ENV         = 'test'
npm ci --no-audit --no-fund
npm run test:db:live            # MUST report real PostgreSQL 18; no PGlite fallback

psql $env:TEST_DATABASE_URL -c "CREATE DATABASE countup_cli_validation"
$env:DATABASE_URL = 'postgresql://postgres@127.0.0.1:55432/countup_cli_validation'
$env:NODE_ENV     = 'development'
npm run db:status
npm run db:migrate
npm run db:migrate
npm run db:migrate:down
npm run db:migrate
```

If `TEST_DATABASE_URL` is unset or points to a non-loopback host, the suite **fails**
rather than silently substituting PGlite.

---

## 3. Migration results (real PostgreSQL 18.6)

| Step | Result |
| --- | --- |
| Empty database | `count(*) FROM pg_tables WHERE schemaname='public'` = **0** |
| `migrateUp` via `createPgClientExecutor(real pg Client)` | applied `0001_foundation`, `0002_identity`, `0003_shops_business`, `0004_payments_audit`, `0005_sync`, `0006_ops_migration` |
| Public tables after up | **37** (36 blueprint + `schema_migrations`) |
| `schema_migrations` rows | **6**, one per version |
| Checksums | all 6 ledger checksums equal `sha256(up.sql)` from `loadMigrations()`; format `^[a-f0-9]{64}$`; `getMigrationStatus()` reports `applied && checksumMatches` for all |
| Second `migrateUp` | returned `[]`; table count 37, index count 113, ledger 6, `plans` 3 — **unchanged** (no duplicate/corrupt schema) |
| `migrateDown` ×6 | returned `0006, 0005, 0004, 0003, 0002, 0001` in exact reverse order; 7th call returned `undefined` |
| State after full down | 1 table (`schema_migrations`), 0 ledger rows, 0 enum types |
| `migrateUp` again | all 6 re-applied; 37 tables; `plans.price_ngwee` = 49900 / 9900 / 26900 (text comparison) |
| CLI `db:status` on empty DB | 6 × `pending` |
| CLI `db:migrate` | 6 applied |
| CLI `db:migrate` again | `already up to date` |
| CLI `db:status` after apply | 6 × `applied` |
| CLI `db:migrate:down` | `rolled back 0006_ops_migration` |
| CLI `db:migrate` re-apply | `applied 0006_ops_migration`; final 37 tables / 6 ledger rows |

Multi-statement `exec()` (migration SQL with plpgsql `$$ … $$` bodies, enum types and
triggers) works through `pg`'s simple query protocol inside `BEGIN … COMMIT` on real
PostgreSQL 18. Transactional DDL rollback was also confirmed (see §5).

---

## 4. Database objects / constraints verified on the live server

Queried from PostgreSQL catalogs after migration:

| Object type | Count | Verification |
| --- | --- | --- |
| Tables | 37 | every one of the 36 blueprint table names checked with `to_regclass($1)` |
| Enum types | 18 | exact name set compared (`user_role` … `cutover_mode`) |
| Foreign keys | 60 | `pg_constraint contype='f'` |
| Composite tenant FKs | 13 | `pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (shop_id,%'` |
| CHECK constraints | 51 | `pg_constraint contype='c'` |
| Indexes | 113 | `pg_indexes` in `public` |
| Triggers | 12 | non-internal `pg_trigger` rows |
| Trigger functions | 3 | `deny_mutation`, `set_local_date`, `set_updated_at` |
| RLS policies | 0 | `pg_policies` (ADR-11 still provisional; RLS not enabled) |

These counts are **identical** to the M1 PGlite results, i.e. the schema is portable
between the two engines.

**Behavioural constraints (live server):**

- Cross-shop `sale_items → sales` and `sale_items → items` inserts rejected with
  SQLSTATE **`23503`**; the same-shop control insert succeeded and returned a UUID.
- `UPDATE` / `DELETE` on `platform_audit` and `change_log` rejected with SQLSTATE
  **`P0001`**; row counts stayed at 1 (append-only triggers fire on real PG).
- Seeded plan values and `system_config` rows present after a full down/up cycle.

---

## 5. Transaction and connection-pool results

| Check | Result |
| --- | --- |
| Failed transaction with `INSERT platform_audit` + invalid FK `INSERT shops` | whole transaction rolled back; `platform_audit` count unchanged at 1 |
| Failed transaction with `CREATE TABLE live_rollback_probe` + DML + invalid insert | table **not** created (`to_regclass IS NULL`); connection still usable (`SELECT 1` returns 1) |
| Pool `max: 2` before any query | `totalCount = 0` |
| `pool.connect()` | `totalCount = 1`, `idleCount = 0`; after `release()` `idleCount = 1` |
| `createPgPoolExecutor().transaction(...)` | returned `current_database()` = the disposable DB name, proving the transaction ran on the borrowed real-server client; `waitingCount = 0` afterwards |
| Failed transaction through the **pool** adapter | rolled back correctly; no leaked/checked-out clients |
| `pool.end()` | `totalCount = 0`; subsequent `poolExecutor.query('SELECT 1')` rejects — clean shutdown |
| `createApp({ db: createPgPoolExecutor(pool) })` over real HTTP | `/health/live` → 200; `/health/ready?verbose=1` → 200 `{status:'ready',environment:'test'}`; `current_database()` matched the disposable DB and `inet_server_port() > 0` |

---

## 6. Test results

```
$ TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' npm run test:db:live

 RUN  v3.2.7 /home/user/CountUp/apps/api
 ✓ test/live/postgres-live.test.ts (13 tests) 437ms

 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  953ms
```

The 13 tests map 1:1 to A2 items 1–12 plus one additional compatibility test (7b).
Regression checks after the config change: `npm run test:db` → **5 files / 44 tests
passed** (PGlite M1 suite), `typecheck:api` / `lint` / `format:check` → exit 0.

---

## 7. Exact failures encountered (and resolution)

**One failure occurred on the first live run.** It was a defect in the *new validation
test's expectation*, not in M1 schema or runtime code.

```
FAIL  test/live/postgres-live.test.ts > 7. all up migrations execute again ...
AssertionError: expected [ '49900', '9900', '26900' ] to deeply equal [ 49900, 9900, 26900 ]
```

**Root cause:** `node-postgres` returns `int8`/`BIGINT` as a **string** (to avoid
precision loss), whereas PGlite returned a JS `number`. The assertion had been written
against PGlite's behaviour. This is precisely the class of incompatibility live
validation is meant to expose.

**Was M1 code broken?** No. No M1 production code reads a `BIGINT` column:
`migrations.ts` reads `TEXT` version/checksum, `app.ts` reads `SELECT 1` (int4), and
`fetchApplied`/`getMigrationStatus` read `TEXT`. The migration runner, schema and
constraints all passed on real PostgreSQL.

**Fix applied (minimal, no M1 rewrite):** the assertion now compares
`price_ngwee::text`, and a dedicated test (`7b`) documents and asserts the real `pg`
int8 parser difference. **No M1 source file was modified.** The finding is carried
forward as a known limitation below and is handled explicitly in M2 code.

Per gate A4, the **complete** validation was rerun after the fix: 13/13 passed, plus
the CLI path and the default PGlite regression suite. M2 was started only after that.

No other failures. No critical live-PostgreSQL test failed after the rerun.

---

## 8. Known limitations

1. **Engine binary source:** the server came from `@embedded-postgres/linux-x64@18.6.0-beta.19`
   (a beta-labelled packaging of PostgreSQL 18.6). It is a native, unmodified PostgreSQL
   backend, but a *managed* PostgreSQL service (Render/Cloudflare/rds) may differ in
   extensions, roles, TLS, `pg_hba`, connection pooling and parameter defaults.
   Validation was against a local `trust`-auth server, not a managed service.
2. **No Docker / Testcontainers in this sandbox.** A reproducible Docker path is provided
   in `scripts/live-postgres-validation.ps1` (`-UseDocker`) but was **not executed here**
   (Docker absent). Do not claim it was.
3. **`BIGINT` is a string in `pg`.** Any M2+ code reading `*_ngwee`, `BIGSERIAL` ids or
   `sales_access_until_ms` must parse explicitly (`Number`/`BigInt`) with safe-integer
   checks; arithmetic on the raw string would concatenate. No automatic type parser was
   added to M1, so this remains a documented consumer responsibility.
4. **Hosted CI:** the live suite is not yet wired into a hosted GitHub Actions job with
   a `services: postgres` container; workflow dispatch was blocked by `403 Resource not
   accessible by integration` in earlier phases. CI currently runs the PGlite suite only.
5. **Not covered:** concurrency/lock contention, replication, `LISTEN/NOTIFY`, TLS,
   connection-pool sizing under load, PgBouncer, and performance. Single-connection and
   `max: 2` pool behaviour were verified.
6. **`fsync=off` / `full_page_writes=off`** were used for speed on the disposable cluster;
   these are not production settings and do not affect schema/constraint correctness.
7. **No production data** was used, and no production database was contacted. The
   migration CLI's `NODE_ENV=production` refusal remains in force.
8. `psql`/`pg_isready`/`pg_config` are not bundled with the npm binary package, so
   catalog verification was done through the `pg` driver rather than `psql`.

---

## 9. Gate decision

**PASS.** All 12 A2 requirements verified against a real PostgreSQL 18.6 server via
the actual `pg` driver, with reproducible commands and a PowerShell procedure. Phase B
(M2) was permitted to proceed.

---

## 10. Addendum — re-validation after M2 migration `0007_m2_auth`

Phase A originally ran against the six M1 migrations (sections 1–9 above, commit
`47325d2`). M2 then added a **seventh** versioned migration (`0007_m2_auth`) with a
matching down script. To ensure the gate still holds on the final schema, the complete
live suite and CLI path were **re-run against the same real PostgreSQL 18.6 server**
after `0007` was added. This is a second real-server run, not a PGlite result.

```
$ TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' npm run test:db:live
 ✓ test/live/postgres-live.test.ts (13 tests)
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

Updated catalog expectations (measured on the live server after all seven up
migrations, and asserted by the suite):

| Object | M1 (six migrations) | M1+M2 (seven migrations) |
| --- | --- | --- |
| Versions in ledger | 6 | **7** |
| Public tables | 37 | **38** (`+ identity_verifications`) |
| Enum types | 18 | **19** (`+ identity_verification_status`) |
| Foreign keys | 60 | **64** |
| Composite tenant FKs | 13 | **13** (unchanged) |
| CHECK constraints | 51 | **55** |
| Indexes | 113 | **115** |
| Triggers | 12 | **13** |
| RLS policies | 0 | **0** |
| Tables with `shop_id` | 22 | **22** (unchanged) |

All seven down migrations still execute in exact reverse order on the real server,
leaving only `schema_migrations`, and all seven up migrations re-apply cleanly.
Cross-shop `23503`, append-only `P0001`, transactional DDL/DML rollback, pool
acquisition/release/shutdown and the API-on-`pg` checks were all re-executed and
passed. The int8/BIGINT-as-string finding and all limitations in §8 remain in force.

**Final live run after M2 was implemented** (24 authentication integration tests
added to the same real-server suite, plus 8 unit tests):

```
$ TEST_DATABASE_URL='postgresql://postgres@127.0.0.1:55432/postgres' npm run test:db:live
 ✓ test/auth/authentication.test.ts (24 tests)
 ✓ test/live/postgres-live.test.ts (13 tests)
 ✓ test/auth/security-unit.test.ts (8 tests)
 Test Files  3 passed (3)
      Tests  45 passed (45)
```

Every authentication test that touches the database ran against a freshly created,
isolated database on the real PostgreSQL 18.6 server via `pg@8.23.1` — not PGlite.
See `docs/M2_AUTHENTICATION_IMPLEMENTATION.md` §9.
