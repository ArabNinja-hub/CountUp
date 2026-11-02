import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAuthHarness, type AuthHarness } from './harness';

const PASSWORD = 'Str0ngPassw0rd!2026';
let emailCounter = 0;

function signupBody(): Record<string, unknown> {
  emailCounter += 1;
  return {
    email: `origin-${emailCounter}@example.test`,
    password: PASSWORD,
    displayName: 'Origin Test',
  };
}

function csrfHeaders(h: AuthHarness, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    cookie: `countup_csrf=${h.client.getCookie('countup_csrf') ?? ''}`,
    'x-csrf-token': h.client.csrfToken,
    ...extra,
  };
}

async function post(h: AuthHarness, headers: Record<string, string>): Promise<number> {
  const response = await fetch(`${h.baseUrl}/auth/signup`, {
    method: 'POST',
    headers: csrfHeaders(h, headers),
    body: JSON.stringify(signupBody()),
  });
  return response.status;
}

/** Raw TCP request so the Host header can actually be spoofed (fetch overrides it). */
function rawPost(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(data));
    socket.on('connect', () => {
      const body = JSON.stringify(signupBody());
      const lines = [
        'POST /auth/signup HTTP/1.1',
        `Host: ${headers.host ?? '127.0.0.1'}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...Object.entries(headers)
          .filter(([key]) => key !== 'host')
          .map(([key, value]) => `${key}: ${value}`),
        'Connection: close',
        '',
        body,
      ];
      socket.write(lines.join('\r\n'));
      socket.end();
    });
  });
}

describe('C-07 — strict Origin validation for state-changing requests', () => {
  it('rejects missing, empty, malformed, mismatched and hostile Origin evidence', async () => {
    const h = await createAuthHarness();
    try {
      // A valid request first, to prove CSRF + allowlist are otherwise working.
      expect(await post(h, { origin: h.baseUrl, 'sec-fetch-site': 'same-origin' })).toBe(201);

      const cases: Array<[string, Record<string, string>]> = [
        ['no Origin and no Sec-Fetch-Site', {}],
        ['no Origin + Sec-Fetch-Site: none', { 'sec-fetch-site': 'none' }],
        ['empty Origin', { origin: '' }],
        ['Origin: null', { origin: 'null' }],
        ['non-URL Origin', { origin: 'not-a-url' }],
        ['Origin with a path', { origin: `${h.baseUrl}/evil` }],
        ['Origin with credentials', { origin: 'https://user:pass@app.example.com' }],
        ['explicit default port', { origin: `${h.baseUrl}:80` }],
        ['hostile cross-site origin', { origin: 'https://evil.example' }],
        [
          'hostile origin with same-origin claim',
          { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
        ],
        [
          'hostile origin with Sec-Fetch-Site: none',
          { origin: 'https://evil.example', 'sec-fetch-site': 'none' },
        ],
        ['mismatched loopback port', { origin: 'http://127.0.0.1:1' }],
        [
          'cross-site fetch metadata with a valid origin',
          { origin: h.baseUrl, 'sec-fetch-site': 'cross-site' },
        ],
      ];
      for (const [label, headers] of cases) {
        const status = await post(h, headers);
        expect(status, label).toBe(403);
      }

      // Sec-Fetch-Site is not proof of origin, but a valid explicit Origin is.
      expect(await post(h, { origin: h.baseUrl, 'sec-fetch-site': 'none' })).toBe(201);

      const users = await h.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
      // Only the two deliberately accepted signups exist.
      expect(users[0]?.count).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('rejects a spoofed Host header sent over a raw socket', async () => {
    const h = await createAuthHarness();
    try {
      const port = Number(new URL(h.baseUrl).port);
      const response = await rawPost(port, {
        host: 'evil.example',
        origin: 'http://evil.example',
        'sec-fetch-site': 'none',
        cookie: `countup_csrf=${h.client.getCookie('countup_csrf') ?? ''}`,
        'x-csrf-token': h.client.csrfToken,
      });
      expect(response).toContain('403');
      expect(response).toContain('cross_origin');
      const users = await h.query<{ count: number }>('SELECT count(*)::int AS count FROM users');
      expect(users[0]?.count).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('honours an explicit validated allowlist and nothing else', async () => {
    const h = await createAuthHarness({ allowedOrigins: ['https://trusted.example'] });
    try {
      expect(
        await post(h, { origin: 'https://trusted.example', 'sec-fetch-site': 'same-origin' })
      ).toBe(201);
      expect(await post(h, { origin: h.baseUrl, 'sec-fetch-site': 'same-origin' })).toBe(403);
    } finally {
      await h.close();
    }
  });
});
