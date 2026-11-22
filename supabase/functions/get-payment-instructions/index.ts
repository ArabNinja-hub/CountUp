import { handleGetPaymentInstructions } from '../../../shared/subscriptionPaymentDomain.ts';
import {
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
    const shopId = typeof body.shopId === 'string' ? body.shopId : '';

    const result = await handleGetPaymentInstructions(
      {
        async findShopOwnerAndSession({ shopId: targetShopId, userId, sessionId }) {
          const { data: shopRow, error: shopErr } = await caller.adminClient
            .from('shops')
            .select('id, owner_user_id')
            .eq('id', targetShopId)
            .maybeSingle();
          if (shopErr) throw new Error(shopErr.message);
          if (!shopRow) {
            return {
              exists: false,
              ownerMatches: false,
              hasPinCredentials: false,
              sessionVerified: false,
            };
          }

          const { data: pinCred, error: pinErr } = await caller.adminClient
            .from('shop_pin_credentials')
            .select('shop_id')
            .eq('shop_id', targetShopId)
            .maybeSingle();
          if (pinErr) throw new Error(pinErr.message);

          let sessionVerified = false;
          if (sessionId) {
            const { data: verifiedRow, error: sessErr } = await caller.adminClient
              .from('shop_verified_sessions')
              .select('shop_id')
              .eq('shop_id', targetShopId)
              .eq('session_id', sessionId)
              .eq('user_id', userId)
              .maybeSingle();
            if (sessErr) throw new Error(sessErr.message);
            sessionVerified = Boolean(verifiedRow);
          }

          return {
            exists: true,
            ownerMatches: shopRow.owner_user_id === userId,
            hasPinCredentials: Boolean(pinCred),
            sessionVerified,
          };
        },
      },
      {
        userId: caller.user.id,
        sessionId: caller.sessionId,
        shopId,
        // Read strictly from server secrets — never exposed in client bundles or public DB tables
        mtnNumber: Deno.env.get('COUNTUP_MTN_PAYMENT_NUMBER'),
        airtelNumber: Deno.env.get('COUNTUP_AIRTEL_PAYMENT_NUMBER'),
      }
    );

    return jsonResponse(200, result, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
});
