/**
 * =====================================================================
 * SUPPORT & PAYMENT CONTACT DETAILS
 * =====================================================================
 * Single source of truth for the contact details shown in the app
 * (Plan screen top-ups, legal pages, WhatsApp / call / email links).
 *
 * These are real, monitored channels — change them here, never inline.
 * `whatsapp` and `phone` must be full international numbers without
 * spaces or punctuation so they can be dropped straight into wa.me and
 * tel: links.
 */
export const SUPPORT_CONTACT = {
  /** WhatsApp number in international format, digits only (e.g. 260977123456). */
  whatsapp: '260977123456',
  /** Human-readable version of the same number, shown in the UI. */
  phoneDisplay: '+260 97 712 3456',
  /** Dialable number for tel: links (E.164). */
  phoneDial: '+260977123456',
  supportEmail: 'support@countup.app',
  paymentsEmail: 'payments@countup.app',
  legalEmail: 'legal@countup.app',
} as const;

/** Platform owner account allowed into the admin console. Must match firestore.rules. */
export const PLATFORM_ADMIN_EMAIL = 'ronisherbwalya@gmail.com';
