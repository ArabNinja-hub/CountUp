import { EdgeDomainError } from '../../../shared/edgeAuthDomain.ts';
import {
  assertPlatformAdminMfaCaller,
  parseSetSuspendedPayload,
} from '../../../shared/subscriptionPaymentDomain.ts';
import {
  createCallerScopedClient,
  errorResponse,
  handlePreflightOrRejectOrigin,
  jsonResponse,
  parseJsonObject,
  requireAuthenticatedCaller,
} from '../_shared/http.ts';

Deno.serve(async (req) => {
  const { earlyResponse, headers } = handlePreflightOrRejectOrigin(req);
  if (earlyResponse) return earlyResponse;

  try {
    const caller = await requireAuthenticatedCaller(req);
    assertPlatformAdminMfaCaller(caller);

    const parsed = parseSetSuspendedPayload(await parseJsonObject(req));

    const userClient = createCallerScopedClient(caller.bearerToken);
    const { data, error } = await userClient.rpc('admin_set_shop_suspended', {
      p_shop_id: parsed.shopId,
      p_suspended: parsed.suspended,
      p_operation_id: parsed.operationId,
      p_reason: parsed.reason,
    });

    if (error) {
      const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 400;
      throw new EdgeDomainError(
        status,
        String(error.details || 'suspension_rejected'),
        error.message
      );
    }

    return jsonResponse(200, (data as Record<string, unknown>) ?? {}, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
