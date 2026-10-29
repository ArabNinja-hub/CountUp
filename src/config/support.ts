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
  /** WhatsApp number in international format, digits only (e.g. 260962838581). */
  whatsapp: '260962838581',
  /** Human-readable version of the same number, shown in the UI. */
  phoneDisplay: '+260 96 283 8581',
  /** Dialable number for tel: links (E.164). */
  phoneDial: '+260962838581',
  supportEmail: 'ronisherbwalya@gmail.com',
  paymentsEmail: 'ronisherbwalya@gmail.com',
  legalEmail: 'ronisherbwalya@gmail.com',
} as const;

/*
 * Platform-owner access is NOT configured here on purpose.
 *
 * Countup signs users in with a phone number + PIN only (backed by an anonymous
 * Firebase session), so there is no email address to key ownership on. The
 * platform owner is whoever has a document in the `admins` collection:
 *
 *   1. Sign in to Countup (or the Firebase console) as the owner account.
 *   2. Copy that account's UID from Firebase console -> Authentication -> Users.
 *   3. Create the document `admins/<uid>` in Firestore.
 *
 * `firestore.rules` gates every admin read/write on that document, and the app
 * shows the admin console when it can read `admins/<own uid>`. Remove the
 * document to revoke access.
 */
