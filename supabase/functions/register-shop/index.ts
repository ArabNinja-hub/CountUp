import { handleRegisterShop } from '../../../shared/edgeAuthDomain.ts';
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
    const shopName = typeof body.name === 'string' ? body.name : '';
    const pin = typeof body.pin === 'string' ? body.pin : '';
    const verifiedPhone = caller.user.phone_confirmed_at ? caller.user.phone : null;

    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);
    const result = await handleRegisterShop(repo, {
      userId: caller.user.id,
      verifiedPhone,
      sessionId: caller.sessionId,
      shopName,
      pin,
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
      phoneHashSalt: Deno.env.get('COUNTUP_PHONE_HASH_SALT') ?? undefined,
    });

    return jsonResponse(
      200,
      {
        shop: result.shop,
        recoveryCode: result.recoveryCode,
        trialGranted: result.trialGranted,
      },
      headers
    );
  } catch (err) {
    return errorResponse(err, headers);
  }
});
