import { handleCheckAndRecordSmsAllowance } from '../../../shared/edgeAuthDomain.ts';
import {
  createServiceRoleClient,
  createSupabaseEdgeAuthRepository,
  errorResponse,
  extractClientIp,
  handlePreflightOrRejectOrigin,
  jsonResponse,
  parseJsonObject,
} from '../_shared/http.ts';
import { readSmsRateLimitPolicyFromEnv } from '../_shared/sms.ts';

Deno.serve(async (req) => {
  const { earlyResponse, headers } = handlePreflightOrRejectOrigin(req);
  if (earlyResponse) return earlyResponse;

  try {
    const body = await parseJsonObject(req);
    const phone = typeof body.phone === 'string' ? body.phone : '';
    const clientIp = extractClientIp(req);

    const adminClient = createServiceRoleClient();
    const repo = createSupabaseEdgeAuthRepository(adminClient);

    const result = await handleCheckAndRecordSmsAllowance(repo, {
      phone,
      clientIp,
      purpose: 'otp',
      stage: 'precheck',
      pepper: Deno.env.get('COUNTUP_PIN_PEPPER') ?? '',
      policy: readSmsRateLimitPolicyFromEnv(),
    });

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
