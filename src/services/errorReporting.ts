import { reportClientSyncAlertOnServer } from '../auth/authService';
import { isSupabaseConfigured } from '../supabase/client';

/**
 * Scrubs bearer tokens, recovery codes (`CU-XXXX-XXXX-XXXX`), 6-digit OTPs,
 * and 4-digit PIN patterns from client error text before reporting to
 * `public.platform_alerts` so sensitive secrets never leave the device.
 */
export function redactSensitiveErrorText(raw: string): string {
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/\bCU-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, 'CU-[REDACTED]')
    .replace(/\b(pin|otp|code)\s*[:=]\s*["']?\d{4,8}["']?/gi, '$1=[REDACTED]')
    .trim()
    .slice(0, 420);
}

const reportedAlertKeys = new Set<string>();

export async function reportSyncBatchFailure(input: {
  shopId: string;
  actionId: string;
  actionType: string;
  reason: string;
}): Promise<void> {
  if (!isSupabaseConfigured() || !navigator.onLine) return;
  const dedupeKey = `sync_failure:${input.shopId}:${input.actionId}`;
  if (reportedAlertKeys.has(dedupeKey)) return;
  reportedAlertKeys.add(dedupeKey);

  try {
    await reportClientSyncAlertOnServer({
      shopId: input.shopId,
      category: 'sync_failure',
      keySuffix: input.actionId.slice(0, 60),
      title: `Failed sync entry (${input.actionType})`,
      detail: redactSensitiveErrorText(
        `Entry ${input.actionId} (${input.actionType}) halted queue: ${input.reason}`
      ),
      metadata: {
        operation_id: input.actionId,
        action_type: input.actionType,
      },
    });
  } catch {
    // Telemetry is strictly best-effort and must never block shopkeeper operations.
  }
}

export async function reportUnexpectedClientError(input: {
  shopId: string;
  source: string;
  error: unknown;
}): Promise<void> {
  if (!isSupabaseConfigured() || !navigator.onLine) return;
  const message =
    input.error instanceof Error
      ? `${input.error.name}: ${input.error.message}`
      : String(input.error ?? 'Unknown client error');
  const safeDetail = redactSensitiveErrorText(message);
  if (safeDetail.length < 3) return;

  const keySuffix = `${input.source}:${safeDetail.slice(0, 32)}`.replace(/[^A-Za-z0-9_.:-]/g, '_');
  const dedupeKey = `client_error:${input.shopId}:${keySuffix}`;
  if (reportedAlertKeys.has(dedupeKey)) return;
  reportedAlertKeys.add(dedupeKey);

  try {
    await reportClientSyncAlertOnServer({
      shopId: input.shopId,
      category: 'client_error',
      keySuffix,
      title: `Client runtime error (${input.source})`,
      detail: safeDetail,
      metadata: { source: input.source },
    });
  } catch {
    // Best-effort telemetry only.
  }
}

export function resetReportedAlertDedupeForTests(): void {
  reportedAlertKeys.clear();
}
