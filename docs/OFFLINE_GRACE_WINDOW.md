# Subscription Grace Period & 72-Hour Offline Sync Window (Plain-Language Guide)

CountUp has **two separate time protections** so honest Zambian shopkeepers never lose sales during load-shedding or network outages, while expired or tampered devices cannot record unpaid sales indefinitely.

---

## 1. The 3-Day Subscription Grace Period (`sales_access_until`)

When a shop’s free trial or paid plan reaches its expiry date (`plan_expiry_at`):

- The shop automatically gets **3 extra days of grace** (`sales_access_until = plan_expiry_at + 3 days`).
- During those 3 grace days, the app shows a renewal reminder, and the shopkeeper can still record sales normally while they send their Airtel/MTN payment reference and wait for approval.
- Once `sales_access_until` passes on the **server clock**, new live sales are locked until the subscription is renewed (all existing sales, stock, and customer credit records remain readable and exportable).

---

## 2. The 72-Hour Offline Sync Window

Because phones in Zambia often go offline during power cuts or mobile data outages, a shopkeeper may record sales offline and reconnect hours or days later.

When an offline sale reaches the Supabase server (`record_sale` RPC), the server compares the sale’s timestamp (`client_created_at`) against **server receive time** (`clock_timestamp()`):

1. **Normal offline sync (sale timestamp is within 72 hours before server receive time):**
   - If the sale was recorded before `sales_access_until`, was recorded after the shop’s last server contact (within a 10-minute clock-drift tolerance), is not in the future, and is **no more than 72 hours (`259,200` seconds) older than server receive time**, the server accepts it normally (`offline_window_flagged = false`).

2. **Older than 72 hours before server receive time (`server_receive_time - client_created_at > 72 hours`):**
   - **If the shop’s subscription + 3-day grace has already expired on the server (`server_receive_time > sales_access_until`):**
     - The server **rejects** the sale (`PLAN_EXPIRED`). Setting a phone’s clock back more than 72 hours cannot bypass an expired plan. The entry stays safely in the phone’s local queue until the owner renews.
   - **If the shop’s subscription is still active (or inside its 3-day grace period):**
     - The server **does not lose the sale**, because a paying shopkeeper may genuinely have been offline for 4+ days during load-shedding. Instead, the server saves the sale with **`offline_window_flagged = true`** (`offline_flag_reason = 'exceeded_bounded_offline_window'`) and stamps `created_at` with **server receive time** rather than trusting the old phone clock.

3. **Suspended shops (`is_deactivated = true` / `plan_status = 'suspended'`):**
   - Always rejected immediately (`SHOP_SUSPENDED`), whether online or offline.

---

## Quick Examples

| Scenario | What the Server Does |
| --- | --- |
| Active shop loses data for 14 hours, records 20 sales, reconnects | Accepted normally (`offline_window_flagged = false`). |
| Active shop has no power/network for 4 days (96h), reconnects while plan is still active | Saved so no sales are lost, **flagged** (`offline_window_flagged = true`, `exceeded_bounded_offline_window`), `created_at` set to server receive time. |
| Shop plan + 3-day grace expired yesterday; phone was offline 10 hours before expiry, recorded a sale 2 hours before expiry, reconnects today (12h later) | Accepted (`<= 72h` old and recorded before `sales_access_until`). |
| Shop plan + 3-day grace is expired; someone sets their phone clock back 5 days (120h) to record sales | **Rejected** (`PLAN_EXPIRED`) because the timestamp is older than 72h before server receive time on an expired shop. |
