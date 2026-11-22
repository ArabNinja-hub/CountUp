import { handleRevokeOtherShopSessions } from '../../../shared/edgeAuthDomain.ts';
import {
  createSupabaseEdgeAuthRepository,
  errorResponse,
  handlePreflightOrRejectOrigin,
  jsonResponse,
  requireAuthenticatedCaller,
} from '../_shared/http.ts';

Deno.serve(async (req) => {
  const { earlyResponse, headers } = handlePreflightOrRejectOrigin(req);
  if (earlyResponse) return earlyResponse;

  try {
    const caller = await requireAuthenticatedCaller(req);
    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);

    const result = await handleRevokeOtherShopSessions(repo, {
      userId: caller.user.id,
      sessionId: caller.sessionId,
    });

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
