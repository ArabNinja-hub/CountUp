# CountUp instruction manual

Open **Help** on the sign-in page or the **?** button at the top of your shop for the in-app guide.

## 1. Create or open a shop

1. Choose **New shop**. Enter the shop name, your phone number and a four-number PIN.
2. Tap **Create shop**. A new shop starts with an empty stock book and a 30-day trial.
3. To return on the same device, choose **Log in** and enter the same phone number and PIN.

Keep your PIN private. A phone-and-PIN-only shop is tied to the original device's Firebase identity; the PIN alone cannot open it on a new device. Before changing devices or clearing browser data, sync your entries and link an email under **Settings → Account & cloud access**. You can then use **Email sign in** on another device.

## 2. Add and update products

1. Open **Stock** and tap **Add New Item** (or **Add product** on Home).
2. Enter the item name, selling price and current quantity. Enter the buying price if you know it; it is needed for profit calculations.
3. Tap **Add New Item**. The default low-stock warning is five items. To change it or add a pack size, open **More options** before saving.
4. In Stock, use **+5** or **+10** to restock, or **Adjust** for another quantity. Use **Edit** to change details and **Archive** to remove a product from the active list. Archived items can be restored from the **Archived** tab.

## 3. Record a sale

1. Open **Sell** and tap the products the customer is buying. Tap again or use the quantity controls to add more.
2. On a phone, tap **Review sale**; on a larger screen, the sale appears beside the product list. Use **Add items** to return to the list on a phone.
3. Choose **Cash**, **Mobile Money**, or **On Credit**. For Mobile Money, choose the network. For credit, select or add a customer.
4. Add a reference or note under **More details** if needed, then tap **Save Sale**.

CountUp records the payment method; it does not transfer money or check a Mobile Money wallet. Stock is reduced when the sale is recorded. To undo an eligible sale made today, open **Reports → Sales ledger → Undo sale**. A partly repaid credit sale cannot be undone.

## 4. Manage credit

1. Open **Credit** to see who owes you. Select a customer to view their details and history.
2. When the customer pays, tap **Record payment**, enter the amount and choose cash or Mobile Money. Save the payment; partial payments are allowed.
3. To send a reminder, open the customer's details and choose **Send Reminder**. A saved phone number and WhatsApp are needed.

## 5. Check reports and record expenses

Open **Reports** and choose **Today**, **This Week** or **This Month**. Tap **Record Expense** to add an expense. Use **Share** or **CSV** for a summary, and open **More insights** for the health and trend charts.

Sales include credit given. Money received includes cash, Mobile Money and repayments, but not unpaid credit sales. Profit is an estimate and excludes products without a known buying price.

## 6. Offline, sync and backups

- Open the production app online once and let it finish loading. It can then reopen offline in the same browser, unless its cached files have been cleared or evicted. The app files are not a backup of your shop data.
- Ordinary shop entries can be saved on the current device while offline. Reconnect and check the sync notice; CountUp retries temporary connection failures. Keep the original browser data until the waiting count is zero.
- If a payment or sale undo conflicts with a newer customer balance, later entries wait too. Tap **Review** to compare the saved entry and current server balance. Check the receipts and payments on every device before choosing. Correct an amount only if it was entered wrongly, or cancel a payment only if it was never made or is a duplicate. For a conflicting undo, you may choose to keep the sale and cancel the undo; check physical stock afterwards. Each choice requires confirmation, and the remaining entries resume in order.
- CountUp cannot yet record a genuine overpayment or refund. If the full payment was really received, or the sale still needs to be undone and refunded, leave the entry waiting; reconcile outside the app or seek support. Do not reduce a real payment just to clear the queue. **Settings → Data & backups → Sync review history** shows the original entry and confirmed decision for reviewed conflicts.
- When another device's stock changes conflict with a sale, or an offline physical count was based on an older stock level, Stock shows **Stock recount needed**. A stale count is not applied. Count the goods again, use **Adjust stock → Set to physical count**, then mark the notice recounted.
- Use only one CountUp tab on a device. Supported browsers make a second tab wait until the first closes; older browsers show a warning instead.
- Do not clear browser data or switch accounts while entries are waiting to sync. Link email before moving a phone-and-PIN-only shop to a new device. Logging out clears the local shop cache, so phone-and-PIN sign-in needs a connection afterwards.
- If a linked shop loses its cloud session while entries are waiting, reconnect the original email under **Settings → Account & cloud access**. The queue stays on this device; a different account cannot sync it. An unlinked anonymous Firebase identity cannot be recreated to recover an existing shop.
- **Settings → Data & backups** exports JSON or CSV and can import supported legacy v1 backups. CountUp JSON exports do **not** yet have an in-app restore, and do not contain the pending sync queue. Keep the original device data until everything has synced.
- Plan activation is handled through the contact options on the Plan screen; recording a Mobile Money sale does not pay for the subscription.

## 7. Admin console

The console is for accounts explicitly granted platform-admin access; creating a shop does not make its owner an admin.

- On the sign-in page, choose **Admin sign in**, enter the authorized account's email and password, then tap **Open admin console**. An internet connection is required. Choose **Sign out** to leave.
- If your admin access is tied to a phone-and-PIN shop, log in to that shop on its original device and choose **Settings → Platform Admin**. To use email for that same account, first link it under **Settings → Account & cloud access**.
- Administrators can search shops, extend plans and suspend or reactivate shops. These actions require a connection and must be accepted by the server.

The project owner must provision admin access in Firebase; see **Platform owner access** in the README. There is no default admin password.
