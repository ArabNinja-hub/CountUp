import { constantTimeEqualHex } from '../../../shared/authSecurity.ts';
import {
  EdgeDomainError,
  handleCheckAndRecordSmsAllowance,
} from '../../../shared/edgeAuthDomain.ts';
import { createServiceRoleClient, createSupabaseEdgeAuthRepository } from '../_shared/http.ts';
import { readSmsRateLimitPolicyFromEnv, resolveSmsProvider } from '../_shared/sms.ts';

async function hmacSha256Hex(keyBytes: Uint8Array, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyWebhookSignature(req: Request, rawBody: string): Promise<boolean> {
  const rawSecret = (Deno.env.get('SEND_SMS_HOOK_SECRET') ?? '').trim();
  if (!rawSecret) return false;

  const cleanedSecret = rawSecret.replace(/^v1,whsec_/, '');
  let keyBytes: Uint8Array;
  try {
    const bin = atob(cleanedSecret);
    keyBytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    keyBytes = new TextEncoder().encode(cleanedSecret);
  }

  const webhookId = req.headers.get('webhook-id') ?? '';
  const webhookTimestamp = req.headers.get('webhook-timestamp') ?? '';
  const webhookSignature = req.headers.get('webhook-signature') ?? '';
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const tsSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return false;
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expectedHex = await hmacSha256Hex(keyBytes, signedContent);

  const candidates = webhookSignature.split(' ').map((part) => part.trim());
  for (const candidate of candidates) {
    const [, sigB64] = candidate.split(',');
    if (!sigB64) continue;
    try {
      const bin = atob(sigB64);
      const actualHex = Array.from(bin)
        .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('');
      if (constantTimeEqualHex(actualHex, expectedHex)) {
        return true;
      }
    } catch {
      // Ignore malformed signature entry
    }
  }
  return false;
}

Deno.serve(async (req) => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers,
    });
  }

  const rawBody = await req.text();
  const verified = await verifyWebhookSignature(req, rawBody);
  if (!verified) {
    return new Response(JSON.stringify({ error: 'Invalid webhook signature' }), {
      status: 401,
      headers,
    });
  }

  let parsed: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    parsed = JSON.parse(rawBody) as { user?: { phone?: string }; sms?: { otp?: string } };
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed JSON body' }), {
      status: 400,
      headers,
    });
  }

  const rawPhone = parsed.user?.phone ?? '';
  const otp = (parsed.sms?.otp ?? '').trim();
  if (!/^\d{6}$/.test(otp)) {
    return new Response(JSON.stringify({ error: 'Invalid OTP payload' }), {
      status: 400,
      headers,
    });
  }

  // Enforce per-phone OTP limits & fail-safe global daily SMS cap BEFORE calling SMS provider.
  let toE164: string;
  try {
    const adminClient = createServiceRoleClient();
    const repo = createSupabaseEdgeAuthRepository(adminClient);
    const allowance = await handleCheckAndRecordSmsAllowance(repo, {
      phone: rawPhone,
      purpose: 'otp',
      stage: 'dispatch',
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
      policy: readSmsRateLimitPolicyFromEnv(),
    });
    toE164 = allowance.canonicalPhone;
  } catch (err) {
    if (err instanceof EdgeDomainError) {
      return new Response(JSON.stringify({ error: err.message, code: err.code }), {
        status: err.status,
        headers,
      });
    }
    console.error('SMS rate-limit fail-safe error:', err);
    return new Response(
      JSON.stringify({
        error: 'SMS verification is temporarily paused for safety.',
        code: 'sms_failsafe_unavailable',
      }),
      { status: 503, headers }
    );
  }

  try {
    const provider = resolveSmsProvider();
    await provider.send({
      toE164,
      message: `Your CountUp code is ${otp}. Never share this code with anyone.`,
    });
    return new Response(JSON.stringify({ sent: true, provider: provider.name }), {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('SMS provider error:', err);
    return new Response(JSON.stringify({ error: 'Failed to deliver SMS verification code.' }), {
      status: 502,
      headers,
    });
  }
});
