import { handleDeleteShop } from '../../../shared/edgeAuthDomain.ts';
import {
  createSupabaseEdgeAuthRepository,
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
    const confirmationName = typeof body.confirmationName === 'string' ? body.confirmationName : '';
    const pin = typeof body.pin === 'string' ? body.pin : '';

    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);
    const result = await handleDeleteShop(repo, {
      userId: caller.user.id,
      sessionId: caller.sessionId,
      confirmationName,
      pin,
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
      phoneHashSalt: Deno.env.get('COUNTUP_PHONE_HASH_SALT') ?? undefined,
    });

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
