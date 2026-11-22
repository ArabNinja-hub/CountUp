import {
  handleCheckShopUnlockStatus,
  handleUnlockShopSession,
} from '../../../shared/edgeAuthDomain.ts';
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
    const action = body.action === 'status' ? 'status' : 'unlock';
    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);

    if (action === 'status') {
      const status = await handleCheckShopUnlockStatus(repo, {
        userId: caller.user.id,
        sessionId: caller.sessionId,
      });
      return jsonResponse(200, status, headers);
    }

    const pin = typeof body.pin === 'string' ? body.pin : '';
    const unlocked = await handleUnlockShopSession(repo, {
      userId: caller.user.id,
      sessionId: caller.sessionId,
      pin,
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
    });

    return jsonResponse(200, { shop: unlocked.shop }, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
