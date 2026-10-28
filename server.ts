import express, { Request, Response } from 'express';
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
interface PendingTransaction {
  referenceId: string;
  shopId: string;
  planId: string;
  phone: string;
  operator: string;
  amount: number;
  status: 'Pending' | 'Completed' | 'Failed' | 'Cancelled';
  createdAt: string;
  verifiedAt?: string;
}

const transactionsStore = new Map<string, PendingTransaction>();

// Subscription plans reference
const PLAN_PRICES: Record<string, { name: string; months: number; priceKwacha: number }> = {
  monthly: { name: '1 Month', months: 1, priceKwacha: 99 },
  quarterly: { name: '3 Months', months: 3, priceKwacha: 269 },
  biannual: { name: '6 Months', months: 6, priceKwacha: 499 },
};

function getLipilaBaseUrl(): string {
  const env = (process.env.LIPILA_ENVIRONMENT || 'sandbox').toLowerCase();
  return env === 'production'
    ? 'https://blz.lipila.io/api/v1'
    : 'https://api.lipila.dev/api/v1';
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

// -------------------------------------------------------------
// LIPILA OFFICIAL PAYMENT API ROUTES
// -------------------------------------------------------------

/**
 * GET /api/lipila/config
 * Returns current configuration status without exposing private secrets
 */
app.get('/api/lipila/config', (_req: Request, res: Response) => {
  const apiKey = process.env.LIPILA_API_KEY?.trim() || '';
  const walletId = process.env.LIPILA_WALLET_ID?.trim() || '';
  const environment = (process.env.LIPILA_ENVIRONMENT || 'sandbox').toLowerCase();

  const missingVariables: string[] = [];
  if (!apiKey) missingVariables.push('LIPILA_API_KEY');
  if (!walletId) missingVariables.push('LIPILA_WALLET_ID');

  const isConfigured = missingVariables.length === 0;

  res.json({
    isConfigured,
    environment,
    baseUrl: getLipilaBaseUrl(),
    walletIdConfigured: Boolean(walletId),
    apiKeyConfigured: Boolean(apiKey),
    missingVariables,
    documentationUrl: 'https://docs.lipila.io/',
    supportedOperators: ['airtel', 'mtn', 'zamtel'],
    currency: 'ZMW',
  });
});

/**
 * POST /api/lipila/initiate
 * Secure server-to-server request to Lipila Mobile Money Collection API
 */
app.post('/api/lipila/initiate', async (req: Request, res: Response) => {
  try {
    const { shopId, planId, phone, operator } = req.body;
    const apiKey = process.env.LIPILA_API_KEY?.trim();
    const walletId = process.env.LIPILA_WALLET_ID?.trim();

    // Check configuration
    const missing: string[] = [];
    if (!apiKey) missing.push('LIPILA_API_KEY');
    if (!walletId) missing.push('LIPILA_WALLET_ID');

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'CONFIGURATION_REQUIRED',
        message: 'Lipila API credentials are not yet configured in environment variables.',
        missingVariables: missing,
        requiredSteps: [
          'Create a Sandbox account on https://dashboard.lipila.dev or https://dashboard.lipila.io',
          'Obtain your sandbox API Key (starts with "lsk_") and set LIPILA_API_KEY',
          'Obtain your merchant Wallet / Till ID and set LIPILA_WALLET_ID in your environment (.env)',
        ],
      });
    }

    if (!shopId || !planId || !phone || !operator) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_PARAMETERS',
        message: 'Missing required parameters: shopId, planId, phone, and operator.',
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
    const referenceId = `countup_${shopId.replace(/\D/g, '') || 'shop'}_${Date.now()}`;
    const baseUrl = getLipilaBaseUrl();
    const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const callbackUrl = `${appUrl}/api/lipila/webhook`;

    // Lipila Mobile Money Collection Payload
    const payload = {
      amount: plan.priceKwacha,
      currency: 'ZMW',
      reference: referenceId,
      phoneNumber: formattedPhone,
      provider: operator.toLowerCase(),
      walletId: walletId,
      description: `Countup Subscription: ${plan.name} (K ${plan.priceKwacha})`,
      callbackUrl,
    };

    console.log(`[Lipila] Initiating collection at ${baseUrl}/collections/mobile-money:`, {
      referenceId,
      amount: plan.priceKwacha,
      operator,
      phone: formattedPhone,
    });

    const lipilaResponse = await fetch(`${baseUrl}/collections/mobile-money`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'x-api-key': apiKey!,
      },
      body: JSON.stringify(payload),
    });

    const responseBody = await lipilaResponse.json().catch(() => ({}));

    if (!lipilaResponse.ok) {
      console.error('[Lipila Error] API response not OK:', lipilaResponse.status, responseBody);
      return res.status(lipilaResponse.status).json({
        success: false,
        error: 'LIPILA_API_ERROR',
        status: lipilaResponse.status,
        message: responseBody.message || 'Lipila rejected the collection request.',
        details: responseBody,
      });
    }

    // Save pending transaction in store
    const txn: PendingTransaction = {
      referenceId,
      shopId,
      planId,
      phone: formattedPhone,
      operator,
      amount: plan.priceKwacha,
      status: 'Pending',
      createdAt: new Date().toISOString(),
    };
    transactionsStore.set(referenceId, txn);

    return res.json({
      success: true,
      referenceId,
      status: 'Pending',
      amount: plan.priceKwacha,
      currency: 'ZMW',
      message: 'Mobile money prompt sent to customer phone. Awaiting PIN authorization.',
      lipilaResponse: responseBody,
    });
  } catch (error) {
    console.error('[Lipila] Exception in /api/lipila/initiate:', error);
    return res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: error instanceof Error ? error.message : 'Unknown server error',
    });
  }
});

/**
 * GET /api/lipila/verify/:referenceId
 * Server-side payment status verification against Lipila check-status endpoint
 */
app.get('/api/lipila/verify/:referenceId', async (req: Request, res: Response) => {
  try {
    const { referenceId } = req.params;
    const apiKey = process.env.LIPILA_API_KEY?.trim();

    if (!apiKey) {
      return res.status(400).json({
        success: false,
        verified: false,
        error: 'CONFIGURATION_REQUIRED',
        message: 'LIPILA_API_KEY is not configured on the server.',
      });
    }

    const baseUrl = getLipilaBaseUrl();
    const checkUrl = `${baseUrl}/collections/check-status?referenceId=${encodeURIComponent(referenceId)}`;

    console.log(`[Lipila] Verifying transaction status: ${checkUrl}`);

    const statusResponse = await fetch(checkUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
      },
    });

    const statusData = await statusResponse.json().catch(() => ({}));

    if (!statusResponse.ok) {
      return res.status(statusResponse.status).json({
        success: false,
        verified: false,
        message: 'Failed to verify transaction status with Lipila.',
        details: statusData,
      });
    }

    // Parse status from Lipila response (e.g. 'Completed', 'Successful', 'Pending', 'Failed')
    const rawStatus = (
      statusData.status ||
      statusData.transactionStatus ||
      statusData.data?.status ||
      'Pending'
    ).toString();

    const isSuccessful =
      rawStatus.toLowerCase() === 'completed' ||
      rawStatus.toLowerCase() === 'successful' ||
      rawStatus.toLowerCase() === 'success';

    const isFailed =
      rawStatus.toLowerCase() === 'failed' ||
      rawStatus.toLowerCase() === 'cancelled' ||
      rawStatus.toLowerCase() === 'rejected';

    // Update in-memory record
    const existingTxn = transactionsStore.get(referenceId);
    if (existingTxn) {
      if (isSuccessful) {
        existingTxn.status = 'Completed';
        existingTxn.verifiedAt = new Date().toISOString();
      } else if (isFailed) {
        existingTxn.status = 'Failed';
      }
      transactionsStore.set(referenceId, existingTxn);
    }

    return res.json({
      success: true,
      referenceId,
      verified: isSuccessful,
      status: isSuccessful ? 'Completed' : isFailed ? 'Failed' : 'Pending',
      planId: existingTxn?.planId,
      shopId: existingTxn?.shopId,
      rawResponse: statusData,
    });
  } catch (error) {
    console.error('[Lipila] Exception in /api/lipila/verify:', error);
    return res.status(500).json({
      success: false,
      verified: false,
      error: 'SERVER_ERROR',
      message: error instanceof Error ? error.message : 'Unknown server error',
    });
  }
});

/**
 * POST /api/lipila/webhook
 * Receives real-time asynchronous callbacks from Lipila
 */
app.post('/api/lipila/webhook', (req: Request, res: Response) => {
  try {
    const event = req.body;
    console.log('[Lipila Webhook Received]:', JSON.stringify(event));

    const referenceId =
      event.reference ||
      event.referenceId ||
      event.data?.reference ||
      event.data?.referenceId;

    const status = (
      event.status ||
      event.transactionStatus ||
      event.data?.status ||
      ''
    ).toString();

    if (referenceId) {
      const existingTxn = transactionsStore.get(referenceId);
      if (existingTxn) {
        const isCompleted =
          status.toLowerCase() === 'completed' ||
          status.toLowerCase() === 'successful' ||
          status.toLowerCase() === 'success';

        if (isCompleted) {
          existingTxn.status = 'Completed';
          existingTxn.verifiedAt = new Date().toISOString();
        } else if (status.toLowerCase() === 'failed' || status.toLowerCase() === 'cancelled') {
          existingTxn.status = 'Failed';
        }
        transactionsStore.set(referenceId, existingTxn);
      }
    }

    // Acknowledge receipt to Lipila
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[Lipila Webhook Error]:', error);
    return res.status(200).json({ received: true, note: 'Error processed' });
  }
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
