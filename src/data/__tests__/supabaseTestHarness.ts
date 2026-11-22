import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite, Transaction } from '@electric-sql/pglite';

export interface TestIdentity {
  id: string;
  sessionId?: string;
  phone?: string;
  email?: string;
  emailVerified?: boolean;
  aal?: 'aal1' | 'aal2';
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

const SUPABASE_AUTH_BOOTSTRAP_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT;
  END IF;
END;
$$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  phone text UNIQUE,
  email text UNIQUE,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  sub_claim text;
BEGIN
  sub_claim := NULLIF(
    btrim(
      COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        auth.jwt() ->> 'sub',
        ''
      )
    ),
    ''
  );
  IF sub_claim IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN sub_claim::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
    COALESCE(
      NULLIF(current_setting('request.jwt.claim.role', true), ''),
      auth.jwt() ->> 'role',
      ''
    ),
    ''
  );
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, supabase_auth_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role, supabase_auth_admin;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO service_role, supabase_auth_admin;
`;

export function buildJwtClaims(
  role: 'anon' | 'authenticated' | 'service_role',
  identity?: TestIdentity
): Record<string, unknown> {
  if (!identity) {
    return { role };
  }
  return {
    aud: role,
    role,
    sub: identity.id,
    aal: identity.aal ?? 'aal1',
    ...(identity.sessionId ? { session_id: identity.sessionId } : {}),
    ...(identity.phone ? { phone: identity.phone } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    email_verified: Boolean(identity.emailVerified),
    app_metadata: identity.appMetadata ?? {},
    user_metadata: identity.userMetadata ?? {},
  };
}

export async function createTestSupabaseDb() {
  const db = new PGlite();
  await db.exec(SUPABASE_AUTH_BOOTSTRAP_SQL);

  const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
  const entries = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of entries) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
  }

  async function createAuthUser(input: Partial<TestIdentity> = {}): Promise<TestIdentity> {
    const identity: TestIdentity = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      phone: input.phone,
      email: input.email,
      emailVerified: input.emailVerified ?? false,
      aal: input.aal ?? 'aal1',
      appMetadata: input.appMetadata ?? {},
      userMetadata: input.userMetadata ?? {},
    };
    await db.query(
      `INSERT INTO auth.users (
         id,
         phone,
         email,
         email_confirmed_at,
         phone_confirmed_at,
         raw_app_meta_data,
         raw_user_meta_data
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [
        identity.id,
        identity.phone ?? null,
        identity.email ?? null,
        identity.email && identity.emailVerified ? new Date().toISOString() : null,
        identity.phone ? new Date().toISOString() : null,
        JSON.stringify(identity.appMetadata),
        JSON.stringify(identity.userMetadata),
      ]
    );
    return identity;
  }

  async function runWithRole<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    identity: TestIdentity | undefined,
    fn: (tx: Transaction) => Promise<T>
  ): Promise<T> {
    const claims = JSON.stringify(buildJwtClaims(role, identity));
    return db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [identity?.id ?? '']);
      await tx.exec(`SET LOCAL ROLE ${role}`);
      return fn(tx);
    });
  }

  return {
    db,
    createAuthUser,
    asAnon: <T>(fn: (tx: Transaction) => Promise<T>) => runWithRole('anon', undefined, fn),
    asUser: <T>(identity: TestIdentity, fn: (tx: Transaction) => Promise<T>) =>
      runWithRole('authenticated', identity, fn),
    asServiceRole: <T>(fn: (tx: Transaction) => Promise<T>) =>
      runWithRole('service_role', undefined, fn),
    close: () => db.close(),
  };
}
