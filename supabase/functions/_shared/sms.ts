import {
  DEFAULT_SMS_RATE_LIMIT_POLICY,
  SmsRateLimitPolicy,
} from '../../../shared/edgeAuthDomain.ts';

export interface SmsDispatchInput {
  toE164: string;
  message: string;
}

export interface SmsProviderAdapter {
  readonly name: string;
  send(input: SmsDispatchInput): Promise<void>;
}

function createAfricasTalkingAdapter(): SmsProviderAdapter {
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY') ?? '';
  const username = Deno.env.get('AFRICASTALKING_USERNAME') ?? '';
  const senderId = Deno.env.get('AFRICASTALKING_SENDER_ID') ?? '';
  const endpoint =
    username === 'sandbox'
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging';

  return {
    name: 'africastalking',
    async send({ toE164, message }) {
      if (!apiKey || !username) {
        throw new Error('Africa’s Talking SMS secrets are not configured.');
      }
      const form = new URLSearchParams({
        username,
        to: toE164,
        message,
      });
      if (senderId) form.set('from', senderId);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          apiKey,
        },
        body: form.toString(),
      });
      if (!res.ok) {
        throw new Error(`Africa’s Talking SMS failed with HTTP ${res.status}`);
      }
    },
  };
}

function createTwilioAdapter(): SmsProviderAdapter {
  const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
  const authToken = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
  const fromOrMessagingService =
    Deno.env.get('TWILIO_FROM_OR_MESSAGING_SID') ?? Deno.env.get('TWILIO_FROM') ?? '';

  return {
    name: 'twilio',
    async send({ toE164, message }) {
      if (!accountSid || !authToken || !fromOrMessagingService) {
        throw new Error('Twilio SMS secrets are not configured.');
      }
      const form = new URLSearchParams({
        To: toE164,
        Body: message,
      });
      if (fromOrMessagingService.startsWith('MG')) {
        form.set('MessagingServiceSid', fromOrMessagingService);
      } else {
        form.set('From', fromOrMessagingService);
      }
      const basicAuth = btoa(`${accountSid}:${authToken}`);
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        }
      );
      if (!res.ok) {
        throw new Error(`Twilio SMS failed with HTTP ${res.status}`);
      }
    },
  };
}

function createGenericHttpGatewayAdapter(): SmsProviderAdapter {
  const gatewayUrl = Deno.env.get('GENERIC_SMS_WEBHOOK_URL') ?? '';
  const gatewayToken = Deno.env.get('GENERIC_SMS_BEARER_TOKEN') ?? '';
  const senderId = Deno.env.get('GENERIC_SMS_SENDER_ID') ?? 'CountUp';

  return {
    name: 'generic_http',
    async send({ toE164, message }) {
      if (!gatewayUrl) {
        throw new Error('Generic SMS gateway URL secret is not configured.');
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (gatewayToken) {
        headers.Authorization = `Bearer ${gatewayToken}`;
      }
      const res = await fetch(gatewayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: toE164,
          sender: senderId,
          message,
        }),
      });
      if (!res.ok) {
        throw new Error(`Generic SMS gateway failed with HTTP ${res.status}`);
      }
    },
  };
}

export function resolveSmsProvider(): SmsProviderAdapter {
  const selected = (Deno.env.get('SMS_PROVIDER') ?? 'africastalking').trim().toLowerCase();
  if (selected === 'twilio') return createTwilioAdapter();
  if (selected === 'generic_http') return createGenericHttpGatewayAdapter();
  return createAfricasTalkingAdapter();
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function readSmsRateLimitPolicyFromEnv(): SmsRateLimitPolicy {
  return {
    maxPerPhone15m: readPositiveIntEnv(
      'SMS_MAX_PER_PHONE_15M',
      DEFAULT_SMS_RATE_LIMIT_POLICY.maxPerPhone15m
    ),
    maxPerPhone24h: readPositiveIntEnv(
      'SMS_MAX_PER_PHONE_24H',
      DEFAULT_SMS_RATE_LIMIT_POLICY.maxPerPhone24h
    ),
    maxPerIp15m: readPositiveIntEnv(
      'SMS_MAX_PER_IP_15M',
      DEFAULT_SMS_RATE_LIMIT_POLICY.maxPerIp15m
    ),
    maxPerIp24h: readPositiveIntEnv(
      'SMS_MAX_PER_IP_24H',
      DEFAULT_SMS_RATE_LIMIT_POLICY.maxPerIp24h
    ),
    globalDailyCap: readPositiveIntEnv(
      'SMS_GLOBAL_DAILY_CAP',
      DEFAULT_SMS_RATE_LIMIT_POLICY.globalDailyCap
    ),
  };
}
