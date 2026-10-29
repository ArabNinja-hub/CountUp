import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());

// In-memory payment transactions tracking store
interface PesapalTransaction {
  referenceId: string;
  orderTrackingId?: string;
  shopId: string;
  planId: string;
  phone: string;
  operator: string;
  amount: number;
  currency: string;
  status: 'Pending' | 'Completed' | 'Failed' | 'Cancelled';
  redirectUrl?: string;
  createdAt: string;
  verifiedAt?: string;
  isSimulated?: boolean;
}

const transactionsStore = new Map<string, PesapalTransaction>();

// Subscription plans reference
const PLAN_PRICES: Record<string, { name: string; months: number; priceKwacha: number }> = {
  monthly: { name: '1 Month', months: 1, priceKwacha: 99 },
  quarterly: { name: '3 Months', months: 3, priceKwacha: 269 },
  biannual: { name: '6 Months', months: 6, priceKwacha: 499 },
};

// -------------------------------------------------------------
// PESAPAL API 3.0 CONFIGURATION & HELPERS
// -------------------------------------------------------------

function getPesapalBaseUrl(): string {
  const env = (process.env.PESAPAL_ENVIRONMENT || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://pay.pesapal.com/v3'
    : 'https://cybqa.pesapal.com/pesapalv3';
}

function formatZambianMsisdn(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) {
    return '260' + digits.slice(1);
  }
  if (digits.startsWith('260') && digits.length === 12) {
    return digits;
  }
  if (digits.length === 9) {
    return '260' + digits;
  }
  return digits;
}

// Token cache to avoid hitting Pesapal Auth rate limits
let cachedToken: { token: string; expiresAt: number } | null = null;
let cachedIpnId: string | null = process.env.PESAPAL_IPN_ID?.trim() || null;

async function getPesapalAuthToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.token;
  }

  const consumerKey = process.env.PESAPAL_CONSUMER_KEY?.trim();
  const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

  if (!consumerKey || !consumerSecret) {
    throw new Error('MISSING_PESAPAL_CREDENTIALS');
  }

  const baseUrl = getPesapalBaseUrl();
  const tokenUrl = `${baseUrl}/api/Auth/RequestToken`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      consumer_key: consumerKey,
      consumer_secret: consumerSecret,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.token) {
    console.error('[Pesapal Auth Failed]:', response.status, data);
    throw new Error(data.message || 'Failed to authenticate with Pesapal API 3.0');
  }

  // Pesapal tokens typically expire in 5 minutes
  const expiryTime = data.expiryDate ? new Date(data.expiryDate).getTime() : now + 4 * 60 * 1000;
  cachedToken = {
    token: data.token,
    expiresAt: expiryTime,
  };

  return data.token;
}

/**
 * Register IPN URL with Pesapal if not yet registered
 */
async function getOrCreateIpnId(token: string, appUrl: string): Promise<string> {
  if (cachedIpnId) {
    return cachedIpnId;
  }

  const baseUrl = getPesapalBaseUrl();
  const ipnRegistrationUrl = `${baseUrl}/api/URLSetup/RegisterIPN`;
  const ipnCallbackUrl = `${appUrl}/api/pesapal/ipn`;

  try {
    const response = await fetch(ipnRegistrationUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        url: ipnCallbackUrl,
        ipn_notification_type: 'GET',
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (response.ok && data.ipn_id) {
      cachedIpnId = data.ipn_id;
      return data.ipn_id;
    }
  } catch (err) {
    console.warn('[Pesapal IPN Registration Note]:', err);
  }

  return 'default_ipn';
}

// -------------------------------------------------------------
// PESAPAL 3.0 OFFICIAL PAYMENT API ROUTES
// -------------------------------------------------------------

/**
 * GET /api/pesapal/config
 * Returns current configuration status without exposing private secrets
 */
app.get('/api/pesapal/config', (_req: Request, res: Response) => {
  const consumerKey = process.env.PESAPAL_CONSUMER_KEY?.trim() || '';
  const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim() || '';
  const ipnId = process.env.PESAPAL_IPN_ID?.trim() || cachedIpnId || '';
  const environment = (process.env.PESAPAL_ENVIRONMENT || 'sandbox').toLowerCase();

  const missingVariables: string[] = [];
  if (!consumerKey) missingVariables.push('PESAPAL_CONSUMER_KEY');
  if (!consumerSecret) missingVariables.push('PESAPAL_CONSUMER_SECRET');

  const isConfigured = missingVariables.length === 0;

  res.json({
    isConfigured,
    environment,
    baseUrl: getPesapalBaseUrl(),
    consumerKeyConfigured: Boolean(consumerKey),
    consumerSecretConfigured: Boolean(consumerSecret),
    ipnIdConfigured: Boolean(ipnId),
    missingVariables,
    documentationUrl: 'https://developer.pesapal.com/',
    supportedPaymentMethods: [
      'Airtel Money Zambia',
      'MTN MoMo Zambia',
      'Zamtel Kwacha',
      'Visa / Mastercard',
    ],
    currency: 'ZMW',
  });
});

/**
 * POST /api/pesapal/initiate
 * Secure server-to-server request to Pesapal v3 SubmitOrderRequest
 */
app.post('/api/pesapal/initiate', async (req: Request, res: Response) => {
  try {
    const { shopId, planId, phone, operator, simulateDev } = req.body;
    const consumerKey = process.env.PESAPAL_CONSUMER_KEY?.trim();
    const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

    if (!shopId || !planId || !phone) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PARAMETERS',
        message: 'Missing required parameters: shopId, planId, and phone.',
      });
    }

    const plan = PLAN_PRICES[planId];
    if (!plan) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PLAN',
        message: `Plan ${planId} is invalid.`,
      });
    }

    const formattedPhone = formatZambianMsisdn(phone);
    const referenceId = `countup_pesapal_${shopId.replace(/\D/g, '') || 'shop'}_${Date.now()}`;
    const baseUrl = getPesapalBaseUrl();
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;

    // If credentials are not yet configured:
    const missing: string[] = [];
    if (!consumerKey) missing.push('PESAPAL_CONSUMER_KEY');
    if (!consumerSecret) missing.push('PESAPAL_CONSUMER_SECRET');

    if (missing.length > 0) {
      // In dev mode when credentials are not yet supplied, allow simulated sandbox testing if requested
      if (simulateDev === true) {
        const simulatedTrackingId = `pesapal_dev_track_${Date.now()}`;
        const txn: PesapalTransaction = {
          referenceId,
          orderTrackingId: simulatedTrackingId,
          shopId,
          planId,
          phone: formattedPhone,
          operator: operator || 'airtel',
          amount: plan.priceKwacha,
          currency: 'ZMW',
          status: 'Pending',
          createdAt: new Date().toISOString(),
          isSimulated: true,
        };
        transactionsStore.set(referenceId, txn);
        transactionsStore.set(simulatedTrackingId, txn);

        return res.json({
          success: true,
          referenceId,
          orderTrackingId: simulatedTrackingId,
          status: 'Pending',
          amount: plan.priceKwacha,
          currency: 'ZMW',
          message: 'Pesapal Sandbox test initiated (Simulation Mode). Awaiting authorization.',
          isSimulated: true,
        });
      }

      return res.status(400).json({
        success: false,
        error: 'CONFIGURATION_REQUIRED',
        message: 'Pesapal API credentials are not yet configured in environment variables.',
        missingVariables: missing,
        requiredSteps: [
          'Create a developer sandbox account on https://developer.pesapal.com',
          'Register your application to get Consumer Key and Consumer Secret',
          'Add PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET to your environment (.env)',
        ],
      });
    }

    // Live / Real Sandbox flow: Authenticate with Pesapal v3
    const token = await getPesapalAuthToken();
    const ipnId = await getOrCreateIpnId(token, appUrl);

    const submitOrderUrl = `${baseUrl}/api/Transactions/SubmitOrderRequest`;
    const callbackUrl = `${appUrl}/api/pesapal/callback?reference=${referenceId}`;

    const orderPayload = {
      id: referenceId,
      currency: 'ZMW',
      amount: plan.priceKwacha,
      description: `Countup Subscription: ${plan.name} (K ${plan.priceKwacha})`,
      callback_url: callbackUrl,
      notification_id: ipnId,
      billing_address: {
        phone_number: formattedPhone,
        email_address: `${formattedPhone}@countup.app`,
        country_code: 'ZM',
        first_name: 'Shop',
        last_name: shopId,
        line_1: 'Lusaka Zambia',
        city: 'Lusaka',
      },
    };

    console.log(`[Pesapal] Submitting order request to ${submitOrderUrl}:`, {
      referenceId,
      amount: plan.priceKwacha,
      currency: 'ZMW',
    });

    const pesapalResponse = await fetch(submitOrderUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    const responseBody = await pesapalResponse.json().catch(() => ({}));

    if (!pesapalResponse.ok || responseBody.error) {
      console.error('[Pesapal Error] SubmitOrderRequest failed:', pesapalResponse.status, responseBody);
      return res.status(pesapalResponse.status || 500).json({
        success: false,
        error: 'PESAPAL_API_ERROR',
        status: pesapalResponse.status,
        message: responseBody.message || responseBody.error?.message || 'Pesapal rejected the order request.',
        details: responseBody,
      });
    }

    const orderTrackingId = responseBody.order_tracking_id;
    const redirectUrl = responseBody.redirect_url;

    // Save transaction in memory
    const txn: PesapalTransaction = {
      referenceId,
      orderTrackingId,
      shopId,
      planId,
      phone: formattedPhone,
      operator: operator || 'airtel',
      amount: plan.priceKwacha,
      currency: 'ZMW',
      status: 'Pending',
      redirectUrl,
      createdAt: new Date().toISOString(),
    };

    transactionsStore.set(referenceId, txn);
    if (orderTrackingId) {
      transactionsStore.set(orderTrackingId, txn);
    }

    return res.json({
      success: true,
      referenceId,
      orderTrackingId,
      redirectUrl,
      status: 'Pending',
      amount: plan.priceKwacha,
      currency: 'ZMW',
      message: 'Pesapal payment order registered successfully.',
      pesapalResponse: responseBody,
    });
  } catch (error) {
    console.error('[Pesapal] Exception in /api/pesapal/initiate:', error);
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: error instanceof Error ? error.message : 'Unknown server error',
    });
  }
});

/**
 * GET /api/pesapal/verify/:referenceOrTrackingId
 * Verifies transaction status against Pesapal GetTransactionStatus API
 */
app.get('/api/pesapal/verify/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const consumerKey = process.env.PESAPAL_CONSUMER_KEY?.trim();
    const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

    const existingTxn = transactionsStore.get(id);

    // If transaction is in simulated dev mode
    if (existingTxn?.isSimulated) {
      // In simulated dev mode, check if client requested simulation completion
      const simulateSuccess = req.query.complete === 'true';
      if (simulateSuccess) {
        existingTxn.status = 'Completed';
        existingTxn.verifiedAt = new Date().toISOString();
        transactionsStore.set(existingTxn.referenceId, existingTxn);
        if (existingTxn.orderTrackingId) {
          transactionsStore.set(existingTxn.orderTrackingId, existingTxn);
        }
      }

      const isDone = existingTxn.status === 'Completed';
      return res.json({
        success: true,
        referenceId: existingTxn.referenceId,
        orderTrackingId: existingTxn.orderTrackingId,
        verified: isDone,
        status: existingTxn.status,
        planId: existingTxn.planId,
        shopId: existingTxn.shopId,
        isSimulated: true,
        message: isDone ? 'Simulated payment completed!' : 'Awaiting simulation confirmation.',
      });
    }

    if (!consumerKey || !consumerSecret) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'CONFIGURATION_REQUIRED',
        message: 'PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET are not configured.',
      });
    }

    const token = await getPesapalAuthToken();
    const orderTrackingId = existingTxn?.orderTrackingId || id;
    const baseUrl = getPesapalBaseUrl();
    const statusUrl = `${baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`;

    console.log(`[Pesapal] Checking status at ${statusUrl}`);

    const statusResponse = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    const statusData = await statusResponse.json().catch(() => ({}));

    if (!statusResponse.ok) {
      return res.status(statusResponse.status).json({
        success: false,
        verified: false,
        message: 'Failed to query transaction status from Pesapal.',
        details: statusData,
      });
    }

    /**
     * Pesapal status codes:
     * 1 = Completed / Success
     * 2 = Failed
     * 0 = Invalid
     * 3 = Reversed
     */
    const statusCode = statusData.status_code;
    const desc = (statusData.payment_status_description || '').toLowerCase();

    const isSuccessful = statusCode === 1 || desc === 'completed';
    const isFailed = statusCode === 2 || desc === 'failed';

    if (existingTxn) {
      if (isSuccessful) {
        existingTxn.status = 'Completed';
        existingTxn.verifiedAt = new Date().toISOString();
      } else if (isFailed) {
        existingTxn.status = 'Failed';
      }
      transactionsStore.set(existingTxn.referenceId, existingTxn);
      if (existingTxn.orderTrackingId) {
        transactionsStore.set(existingTxn.orderTrackingId, existingTxn);
      }
    }

    return res.json({
      success: true,
      referenceId: existingTxn?.referenceId || id,
      orderTrackingId,
      verified: isSuccessful,
      status: isSuccessful ? 'Completed' : isFailed ? 'Failed' : 'Pending',
      planId: existingTxn?.planId,
      shopId: existingTxn?.shopId,
      rawResponse: statusData,
    });
  } catch (error) {
    console.error('[Pesapal] Exception in /api/pesapal/verify:', error);
    return res.status(500).json({
      success: false,
      verified: false,
      error: 'SERVER_ERROR',
      message: error instanceof Error ? error.message : 'Unknown server error',
    });
  }
});

/**
 * IPN Webhook Listener (Pesapal v3)
 * GET and POST supported per Pesapal specification
 */
const handlePesapalIpn = async (req: Request, res: Response) => {
  try {
    const orderTrackingId = (req.query.OrderTrackingId || req.body?.OrderTrackingId || '').toString();
    const orderMerchantReference = (req.query.OrderMerchantReference || req.body?.OrderMerchantReference || '').toString();
    const orderNotificationType = (req.query.OrderNotificationType || req.body?.OrderNotificationType || 'IPNCHANGE').toString();

    console.log('[Pesapal IPN Received]:', { orderTrackingId, orderMerchantReference, orderNotificationType });

    if (orderTrackingId) {
      try {
        const consumerKey = process.env.PESAPAL_CONSUMER_KEY?.trim();
        const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

        if (consumerKey && consumerSecret) {
          const token = await getPesapalAuthToken();
          const baseUrl = getPesapalBaseUrl();
          const statusUrl = `${baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`;

          const statusRes = await fetch(statusUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
            },
          });
          const statusData = await statusRes.json().catch(() => ({}));
          const isSuccessful = statusData.status_code === 1 || (statusData.payment_status_description || '').toLowerCase() === 'completed';

          const existing = transactionsStore.get(orderTrackingId) || transactionsStore.get(orderMerchantReference);
          if (existing) {
            existing.status = isSuccessful ? 'Completed' : 'Failed';
            if (isSuccessful) existing.verifiedAt = new Date().toISOString();
            transactionsStore.set(existing.referenceId, existing);
          }
        }
      } catch (e) {
        console.warn('[Pesapal IPN verification note]:', e);
      }
    }

    // Required Pesapal IPN Acknowledgment Response Format
    return res.status(200).json({
      orderNotificationType,
      orderTrackingId,
      orderMerchantReference,
      status: '200',
    });
  } catch (err) {
    console.error('[Pesapal IPN Error]:', err);
    return res.status(200).json({ received: true, note: 'Error logged' });
  }
};

app.get('/api/pesapal/ipn', handlePesapalIpn);
app.post('/api/pesapal/ipn', handlePesapalIpn);

/**
 * User Return / Callback URL after Pesapal Checkout
 */
app.get('/api/pesapal/callback', (req: Request, res: Response) => {
  const { OrderTrackingId, OrderMerchantReference, reference } = req.query;
  const ref = OrderMerchantReference || reference || '';
  res.redirect(`/?payment_result=pending&tracking_id=${encodeURIComponent((OrderTrackingId || '').toString())}&ref=${encodeURIComponent(ref.toString())}`);
});

// -------------------------------------------------------------
// VITE DEV SERVER / STATIC ASSETS MOUNT
// -------------------------------------------------------------

async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Countup Server] Running on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
