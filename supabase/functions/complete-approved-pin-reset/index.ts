import { handleCompleteApprovedPinReset } from '../../../shared/edgeAuthDomain.ts';
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
    const newPin = typeof body.newPin === 'string' ? body.newPin : '';

    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);
    const result = await handleCompleteApprovedPinReset(repo, {
      userId: caller.user.id,
      sessionId: caller.sessionId,
      newPin,
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
    });

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
