import { handleAdminInitiatePinReset72h } from '../../../shared/edgeAuthDomain.ts';
import {
  createSupabaseEdgeAuthRepository,
  errorResponse,
  handlePreflightOrRejectOrigin,
  jsonResponse,
  parseJsonObject,
  requireAuthenticatedCaller,
} from '../_shared/http.ts';
import { readSmsRateLimitPolicyFromEnv, resolveSmsProvider } from '../_shared/sms.ts';

Deno.serve(async (req) => {
  const { earlyResponse, headers } = handlePreflightOrRejectOrigin(req);
  if (earlyResponse) return earlyResponse;

  try {
    const caller = await requireAuthenticatedCaller(req);
    const body = await parseJsonObject(req);
    const shopId = typeof body.shopId === 'string' ? body.shopId : '';
    const identityCheckNote =
      typeof body.identityCheckNote === 'string' ? body.identityCheckNote : '';

    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);
    const smsProvider = resolveSmsProvider();

    const result = await handleAdminInitiatePinReset72h(repo, {
      adminUserId: caller.user.id,
      isPlatformAdmin: caller.isPlatformAdmin,
      aal: caller.aal,
      shopId,
      identityCheckNote,
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
      smsPolicy: readSmsRateLimitPolicyFromEnv(),
      sendSms: ({ toE164, message }) => smsProvider.send({ toE164, message }),
    });

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
