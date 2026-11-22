# CountUp User Guide

Open **Help** on the sign-in screen or tap the **?** button at the top of your shop anytime for the built-in offline guide.

---

## 1. Create Your Shop & Save Your Recovery Code

1. Open CountUp, choose **New shop**, enter your Zambian mobile number (`096/076`, `097/077`, or `095/075`), complete the security check, and tap **Send 6-Digit SMS Code**.
2. Enter the 6-digit SMS code sent to your phone, type your **Shop Name**, choose a secret **4-digit PIN** (avoid easy numbers like `1234` or `0000`), and tap **Create Shop**.
3. **Important — Save Your One-Time Recovery Code**:
   - CountUp immediately shows a **One-Time Recovery Code** formatted like `CU-XXXX-XXXX-XXXX`.
   - Write this code down on paper and keep it somewhere safe away from your phone, tick the confirmation box, and tap **I Have Saved My Recovery Code**.
   - Eligible new phone numbers start with a **30-day Free Trial**.

### Install CountUp on Your Android Phone

1. Open CountUp in **Google Chrome** on Android and let the page finish loading.
2. Tap the **⋮** menu in Chrome and choose **Install app** (or **Add to Home screen**).
3. CountUp installs on your home screen like a native app and can reopen even when mobile data or power is out.

---

## 2. Daily Unlock & Signing In on a New Phone

### Unlocking on Your Current Shop Phone (Works Offline)
- When you lock the screen using the **Lock** button in the top bar—or reopen CountUp on the same phone—simply enter your **4-digit PIN**. Same-device unlock works **100% offline** without needing SMS or mobile data.

### Signing In on a New or Replacement Phone
If you buy a new phone, lose your old phone, or open CountUp in a new browser:

1. Open CountUp on the new phone while connected to the internet and tap **Log In**.
2. Enter your registered `+260` / `09...` shop phone number and tap **Send 6-Digit SMS Code**.
3. Enter the **6-digit SMS code**.
4. Enter your **4-digit shop PIN** when prompted.
   - *Why both SMS and PIN?* Even if someone steals or swaps your SIM card, they cannot open your shop or read your records without your 4-digit PIN.
5. Once verified, CountUp downloads and syncs your shop profile, stock, sales, customer credit book, and expenses automatically.
   - *Note*: Any offline entries that had **not yet synced** from your old phone remain only in that old phone's browser until it reconnects and finishes syncing.

### Signing Out Other Phones
- If you ever signed in on a borrowed device or replaced a lost phone, open **Settings → Account & Access → Sign Out All Other Devices** to immediately revoke every other phone's session while keeping your current phone signed in.

---

## 3. Recovery Code & PIN Reset (Forgot PIN)

### Option A — You Have Your One-Time Recovery Code (Instant)
1. Sign in with your phone number and 6-digit SMS code on the sign-in screen.
2. On the 4-digit PIN prompt, choose **Use Recovery Code** (this also appears automatically if 5 wrong PIN guesses trigger a temporary lockout).
3. Enter your saved code (`CU-XXXX-XXXX-XXXX`) and choose a **new 4-digit PIN**.
4. **Write down your brand-new Recovery Code**: Every time a recovery code is used, the old code is retired and CountUp gives you a fresh one-time code. Your other signed-in shop phone will also show a security notice confirming the recovery code was used.

### Option B — You Know Your Current PIN and Want to Change It
1. Open **Settings → Account & Access → Change Shop PIN**.
2. Enter your **current 4-digit PIN** and your **new 4-digit PIN** twice, then confirm. Changing your PIN signs out any other devices for safety.

### Option C — You Lost Both Your PIN and Your Recovery Code (72-Hour Safety Reset)
If both your PIN and your paper recovery code are lost:
1. Contact CountUp support so an administrator can verify your identity and initiate an **Approved 72-Hour PIN Reset**.
2. **Anti-SIM-Swap Safety Window (72 Hours)**:
   - CountUp immediately sends a **warning SMS** to your shop phone number and displays an urgent banner with a **Cancel Reset** button on any already-signed-in shop phone.
   - **If you did NOT ask for a PIN reset**, tap **Cancel Reset** immediately inside CountUp to block the request.
3. Once the 72-hour waiting period completes without being cancelled, sign in on your phone with SMS OTP, choose **Complete Approved PIN Reset**, set your **new 4-digit PIN**, and write down the newly generated **One-Time Recovery Code**.

---

## 4. Backups & Restoring From a Backup File

Open **Settings → Data & Backups**:

### Downloading a Backup
- Tap **Download JSON Backup** (recommended monthly and before switching phones) or **Export CSV** for spreadsheets.
- Keep your downloaded `.json` backup file in a safe folder or cloud drive. *(Note: JSON backups contain synced/saved ledger records, not unsynced conflict drafts—always let waiting offline entries finish syncing first when possible.)*

### Restoring From a Backup
CountUp supports restoring both **CountUp v2 JSON backups** (`countup-backup-v2`) and **legacy v1 JSON backups** (up to **5 MB** / **50,000 primary records** / **200,000 total rows**, covering 2+ years of active kiosk history):

1. Sign in to your new or empty shop while online and open **Settings → Data & Backups**.
2. Under **Restore from Backup**, choose your `.json` backup file.
3. CountUp uploads and checks the file safely first, showing a **Preview** (shop name, products, receipts, customers, credit balances, and expenses) without changing your shop yet.
4. Confirm **Restore Backup** to import all records atomically and verify every receipt, stock count, and customer balance (`0` discrepancies).
   - By default, CountUp protects non-empty shops from accidental overwrite unless you explicitly confirm merging non-overlapping records.
   - Re-selecting the exact same backup file is safely detected as already imported so records are never duplicated.

---

## 5. Products, Sales, Credit & Reports

1. **Add & Manage Stock**: Open **Stock → Add New Item**, enter the name, selling price, quantity, and optional buying price (needed for profit calculation). Use **+5**, **+10**, or **Adjust** to update stock, or **Archive** discontinued items.
2. **Record a Sale**: Open **Sell**, tap items, tap **Review sale** on mobile, pick **Cash**, **Mobile Money** (MTN/Airtel), or **On Credit** (choose/add customer), and tap **Save Sale**. Eligible same-day sales can be undone in **Reports → Sales ledger → Undo sale**.
3. **Customer Credit Book**: Open **Credit**, select a customer, and tap **Record payment** when they pay cash or Mobile Money (partial repayments are supported). Tap **Send Reminder** to open a pre-filled WhatsApp reminder.
4. **Reports & Expenses**: Open **Reports** (`Today`, `This Week`, `This Month`) to view total sales, money received, estimated profit, and record business expenses (**Record Expense**).

---

## 6. Working Offline, Late Syncs & Conflict Review

- **Offline Recording**: Sales, stock updates, credit repayments, and expenses save immediately on your phone while offline and sync automatically in order when data returns. Never clear browser storage while the waiting sync counter is above zero.
- **Late-Synced Sales (>72 Hours Offline)**: If load-shedding or network loss keeps an active shop offline for more than 72 hours, CountUp still keeps your sales when you reconnect and shows a calm **"Synced late, kept"** note.
- **Sync Conflict Review**:
  - If a customer repayment or credit-sale undo conflicts with a newer balance from another session, tap **Review** to inspect the saved entry vs. current balance before confirming a correction or cancellation. Decisions are recorded in **Settings → Data & Backups → Sync review history**.
  - If an offline stock count was based on an older stock level, **Stock** shows **Stock recount needed**—recount physical goods on the shelf and use **Adjust stock → Set to physical count**.
- **Single Active Tab**: Keep CountUp open in one tab per device; additional tabs wait automatically so two tabs cannot overwrite local queue state.

---

## 7. Subscriptions & Manual Mobile Money Renewal

1. Open the **Plan** screen to view plan options (**1 Month — K99**, **3 Months — K269**, **6 Months — K499**).
2. Send the exact plan amount manually using the **MTN Mobile Money** or **Airtel Money** details shown on the Plan screen (CountUp never asks for your Mobile Money PIN).
3. Enter the operator **Transaction Reference**, **Payer Phone**, and **Payment Date** on the Plan screen and submit.
4. Your status shows **Pending verification** until a platform administrator checks the operator statement and approves it (or rejects it with a clear reason so you can fix a typo in the reference).
5. Every trial and paid plan includes a **3-day grace period** after expiry so you can keep recording sales while renewing. If a plan expires past grace, sales recording pauses while all your existing data remains safe to view and export.

---

## 8. Platform Admin Console (`aal2` MFA)

- Platform administration is restricted to pre-authorized verified administrator email accounts and requires **both** password sign-in and a **6-digit TOTP authenticator code (`aal2`)** enforced on the server.
- From **Platform admin sign-in**, administrators can monitor **SMS cap/abuse alerts, failed sync batches, and reconciliation alerts**, verify all shop ledgers and subscriptions (`0 differences`), review manual Mobile Money references side-by-side before approving or rejecting with a required reason, extend plans, suspend/reactivate accounts, and assist owners with verified PIN lockout or 72-hour PIN resets.
