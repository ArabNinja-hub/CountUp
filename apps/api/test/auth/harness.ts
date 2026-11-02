import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import type { Server } from 'node:http';
import { createApp } from '../../src/app';
import { AuthService } from '../../src/auth/auth-service';
import { CSRF_HEADER, DEV_PEPPER } from '../../src/auth/constants';
import { AdminAssistedIdentityVerifier } from '../../src/auth/identity-verifier';
import { PasswordHasher } from '../../src/auth/password';
import { createSecurityOptions, type SecurityOverrides } from '../../src/auth/security';
import { loadEnv } from '../../src/config/env';
import { migrateUp } from '../../src/db/migrations';
import {
  createPgClientExecutor,
  type QueryExecutor,
  type QueryResultRow,
} from '../../src/db/query-executor';
import { createMigratedDatabase, type IsolatedDatabase } from '../isolated-database';
import { createLiveDatabase, type LiveDatabase } from '../live/live-database';

export interface CallResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export class TestClient {
  private readonly cookies = new Map<string, string>();
  csrfToken = '';

  constructor(private readonly baseUrl: string) {}

  async bootstrapCsrf(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/auth/csrf`);
    this.absorbCookies(response.headers);
    this.csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  private absorbCookies(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair] = line.split(';');
      if (pair === undefined) {
        continue;
      }
      const [name, value] = pair.split('=');
      if (name === undefined || value === undefined) {
        continue;
      }
      if (value.length === 0 || /max-age=0/i.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  getCookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  async call(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      withCsrf?: boolean;
      sendCookies?: boolean;
    } = {}
  ): Promise<CallResult> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.sendCookies !== false) {
      const cookieHeader = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      if (cookieHeader.length > 0) {
        headers.cookie = cookieHeader;
      }
    }
    if (method.toUpperCase() !== 'GET') {
      headers.origin = this.baseUrl;
      headers['sec-fetch-site'] = 'same-origin';
      if (options.withCsrf !== false) {
        headers[CSRF_HEADER] = this.csrfToken;
      }
    }
    // Explicit per-call headers win, so tests can forge Origin or CSRF values.
    Object.assign(headers, options.headers);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    this.absorbCookies(response.headers);
    const text = await response.text();
    let body: unknown = text;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, headers: response.headers };
  }
}

export interface AuthHarness {
  executor: QueryExecutor;
  service: AuthService;
  verifier: AdminAssistedIdentityVerifier;
  pepper: string;
  baseUrl: string;
  client: TestClient;
  isLivePostgres: boolean;
  newClient(): Promise<TestClient>;
  query<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<Row[]>;
  provisionUser(role: 'platform_admin' | 'staff', email: string, password: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * Prefers a real PostgreSQL server when TEST_DATABASE_URL is set; otherwise falls
 * back to PGlite. The live suite always sets the variable, so `test:db:live` can
 * never silently downgrade to PGlite.
 */
export async function createAuthHarness(overrides: SecurityOverrides = {}): Promise<AuthHarness> {
  const liveUrl = process.env.TEST_DATABASE_URL;
  let live: LiveDatabase | undefined;
  let pglite: IsolatedDatabase | undefined;
  let pgClient: Client | undefined;
  let executor: QueryExecutor;

  if (liveUrl !== undefined && liveUrl.length > 0) {
    live = await createLiveDatabase('auth');
    pgClient = new Client({ connectionString: live.url });
    await pgClient.connect();
    executor = createPgClientExecutor(pgClient);
    await migrateUp(executor);
  } else {
    pglite = await createMigratedDatabase();
    executor = pglite.executor;
  }

  const env = loadEnv({ NODE_ENV: 'test' });
  const security = createSecurityOptions(env, overrides);
  const verifier = new AdminAssistedIdentityVerifier();
  const service = new AuthService({
    executor,
    passwordHasher: new PasswordHasher(security.pepper),
    verifier,
  });
  const app = createApp({ env, db: executor, auth: service, security: overrides });
  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error('failed to bind test server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const newClient = async (): Promise<TestClient> => {
    const client = new TestClient(baseUrl);
    await client.bootstrapCsrf();
    return client;
  };

  return {
    executor,
    service,
    verifier,
    pepper: security.pepper ?? DEV_PEPPER,
    baseUrl,
    client: await newClient(),
    isLivePostgres: live !== undefined,
    newClient,
    async query<Row extends QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      const { rows } = await executor.query<Row>(sql, values);
      return rows;
    },
    async provisionUser(role, email, password) {
      const hasher = new PasswordHasher(security.pepper);
      const passwordHash = await hasher.hashPassword(password);
      return executor.transaction(async (tx) => {
        const created = await tx.query<{ id: string }>(
          `INSERT INTO users (primary_email, display_name, role, status, identity_status)
           VALUES ($1, $2, $3, 'active', 'verified') RETURNING id`,
          [email.toLowerCase(), `seeded-${role}`, role]
        );
        const id = created.rows[0]?.id;
        if (id === undefined) {
          throw new Error('provisionUser returned no id');
        }
        await tx.query(
          `INSERT INTO auth_identities (user_id, kind, identifier, is_primary, verified_at)
           VALUES ($1, 'email', $2, true, now())`,
          [id, email.toLowerCase()]
        );
        await tx.query(
          'INSERT INTO credentials (user_id, password_hash, password_algo) VALUES ($1, $2, $3)',
          [id, passwordHash, 'argon2id']
        );
        return id;
      });
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pgClient?.end();
      await live?.close();
      await pglite?.close();
    },
  };
}
