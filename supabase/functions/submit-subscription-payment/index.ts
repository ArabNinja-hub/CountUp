import { EdgeDomainError } from '../../../shared/edgeAuthDomain.ts';
import { parseSubmitPaymentPayload } from '../../../shared/subscriptionPaymentDomain.ts';
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
    const body = await parseJsonObject(req);
    const parsed = parseSubmitPaymentPayload(body);

    const userClient = createCallerScopedClient(caller.bearerToken);
    const { data, error } = await userClient.rpc('submit_subscription_payment', {
      p_shop_id: parsed.shopId,
      p_plan_id: parsed.planId,
      p_network: parsed.network,
      p_transaction_reference: parsed.transactionReference,
      p_payer_phone: parsed.payerPhone,
      p_payment_date: parsed.paymentDate,
      p_operation_id: parsed.operationId,
      p_expected_amount_ngwee: parsed.expectedAmountNgwee,
    });

    if (error) {
      const status =
        error.code === '42501'
          ? 403
          : error.code === 'P0001'
            ? 429
            : error.code === '23505'
              ? 409
              : 400;
      throw new EdgeDomainError(status, String(error.details || 'payment_rejected'), error.message);
    }

    return jsonResponse(200, (data as Record<string, unknown>) ?? {}, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
