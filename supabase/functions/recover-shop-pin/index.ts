import { handleRecoverShopPin } from '../../../shared/edgeAuthDomain.ts';
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
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : '';
    const newPin = typeof body.newPin === 'string' ? body.newPin : '';

    const repo = createSupabaseEdgeAuthRepository(caller.adminClient);
    const smsProvider = resolveSmsProvider();
    const result = await handleRecoverShopPin(repo, {
      userId: caller.user.id,
      sessionId: caller.sessionId,
      recoveryCode,
      newPin,
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
      smsPolicy: readSmsRateLimitPolicyFromEnv(),
      sendSms: ({ toE164, message }) => smsProvider.send({ toE164, message }),
    });

    return jsonResponse(
      200,
      {
        shop: result.shop,
        recoveryCode: result.recoveryCode,
      },
      headers
    );
  } catch (err) {
    return errorResponse(err, headers);
  }
});
