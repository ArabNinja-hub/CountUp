import { EdgeDomainError } from '../../../shared/edgeAuthDomain.ts';
import {
  assertPlatformAdminMfaCaller,
  parseReviewPaymentPayload,
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

    const parsed = parseReviewPaymentPayload(await parseJsonObject(req));

    const userClient = createCallerScopedClient(caller.bearerToken);
    const { data, error } = await userClient.rpc('review_subscription_payment', {
      p_payment_id: parsed.paymentId,
      p_decision: parsed.decision,
      p_reason: parsed.reason,
      p_operation_id: parsed.operationId,
    });

    if (error) {
      const status =
        error.code === '42501'
          ? 403
          : error.code === 'P0002'
            ? 404
            : error.code === '23514'
              ? 409
              : 400;
      throw new EdgeDomainError(status, String(error.details || 'review_rejected'), error.message);
    }

    return jsonResponse(200, (data as Record<string, unknown>) ?? {}, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
