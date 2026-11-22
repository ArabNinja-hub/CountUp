import { handleVerifyPlatformAdmin } from '../../../shared/edgeAuthDomain.ts';
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

    const result = await handleVerifyPlatformAdmin(repo, {
      userId: caller.user.id,
      email: caller.user.email,
      emailVerified: Boolean(caller.user.email_confirmed_at),
      aal: caller.aal,
      alreadyAdmin: caller.hasAdminClaim,
      configuredAdminEmail:
        Deno.env.get('COUNTUP_PLATFORM_ADMIN_EMAILS') ??
        Deno.env.get('COUNTUP_PLATFORM_ADMIN_EMAIL') ??
        '',
    });

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
