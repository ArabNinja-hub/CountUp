/**
 * =====================================================================
 * PESAPAL PAYMENT GATEWAY INTEGRATION CONFIG (ZAMBIA & EAST AFRICA)
 * =====================================================================
 * Countup supports mobile money and digital card payments via Pesapal:
 * - Airtel Money Zambia (*115#)
 * - MTN MoMo Zambia (*303#)
 * - Zamtel Kwacha (*115#)
 * - Visa / Mastercard
 *
 * Integrated via Pesapal API 3.0 (https://developer.pesapal.com)
 */

export interface ZambianMobileMoneyOperator {
  id: 'airtel' | 'mtn' | 'zamtel';
  name: string;
  brandColor: string;
  ussdPromptCode: string;
  prefixExample: string;
  prefixes: string[]; // 097/077 for Airtel, 096/076 for MTN, 095 for Zamtel
}

export const ZAMBIAN_OPERATORS: ZambianMobileMoneyOperator[] = [
  {
    id: 'airtel',
    name: 'Airtel Money',
    brandColor: '#dc2626',
    ussdPromptCode: '*115#',
    prefixExample: '097 / 077',
    prefixes: ['097', '077', '26097', '26077'],
  },
  {
    id: 'mtn',
    name: 'MTN MoMo',
    brandColor: '#ca8a04',
    ussdPromptCode: '*303#',
    prefixExample: '096 / 076',
    prefixes: ['096', '076', '26096', '26076'],
  },
  {
    id: 'zamtel',
    name: 'Zamtel Kwacha',
    brandColor: '#16a34a',
    ussdPromptCode: '*115#',
    prefixExample: '095',
    prefixes: ['095', '26095'],
  },
];

/**
 * Pesapal Payment Gateway Configuration
 * https://developer.pesapal.com
 */
export const PESAPAL_PAYMENT_CONFIG = {
  providerName: 'Pesapal 3.0 (Zambia & East Africa)',
  providerWebsite: 'https://www.pesapal.com',
  documentationUrl: 'https://developer.pesapal.com',
  currency: 'ZMW', // Zambian Kwacha

  // Credentials are kept in .env / server environment
  consumerKeyPlaceholder: 'YOUR_PESAPAL_CONSUMER_KEY',
  consumerSecretPlaceholder: 'YOUR_PESAPAL_CONSUMER_SECRET',

  // Pesapal v3 API Endpoints
  endpoints: {
    sandbox: 'https://cybqa.pesapal.com/pesapalv3',
    production: 'https://pay.pesapal.com/v3',
  },

  supportedPaymentMethods: [
    'Airtel Money Zambia',
    'MTN MoMo Zambia',
    'Zamtel Kwacha',
    'Visa & Mastercard Cards',
  ],
};

/**
 * Standardize Zambian phone number to 260XXXXXXXXX
 */
export function formatZambianPhone(phone: string): string {
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

/**
 * Detect Zambian operator from phone number
 */
export function detectZambianOperator(phone: string): ZambianMobileMoneyOperator['id'] {
  const clean = phone.replace(/\D/g, '');
  if (
    clean.startsWith('26097') ||
    clean.startsWith('26077') ||
    clean.startsWith('097') ||
    clean.startsWith('077') ||
    clean.startsWith('97') ||
    clean.startsWith('77')
  ) {
    return 'airtel';
  }
  if (
    clean.startsWith('26096') ||
    clean.startsWith('26076') ||
    clean.startsWith('096') ||
    clean.startsWith('076') ||
    clean.startsWith('96') ||
    clean.startsWith('76')
  ) {
    return 'mtn';
  }
  if (clean.startsWith('26095') || clean.startsWith('095') || clean.startsWith('95')) {
    return 'zamtel';
  }
  return 'airtel';
}
