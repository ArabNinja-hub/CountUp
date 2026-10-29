# Firestore Security Specification & Invariants

## 1. System Invariants
- **Identity Invariant**: A shop can only be created by an authenticated user where `ownerUid == request.auth.uid` (or platform admin).
- **Relational Sync (Master Gate)**: Sub-resources (`items`, `sales`, `customers`, `credit_payments`, `expenses`) belong to `/shops/{shopId}` and are accessible only if `request.auth.uid == shop.ownerUid` or `isPlatformAdmin()`.
- **Anti-Spoofing Guard**: The platform admin role for `ronisherbwalya@gmail.com` strictly requires `request.auth.token.email_verified == true`.
- **Immortal Field Invariant**: `ownerUid` on `/shops/{shopId}` cannot be changed by the user during updates.
- **Path Variable Hardening**: Document IDs must conform to `^[a-zA-Z0-9_\-]+$` and have length <= 128 characters.
- **PII Isolation**: Shop profiles containing phone numbers and contact details can only be read by their respective owner or verified platform admin.

## 2. Dirty Dozen Attack Payloads
1. **Unauthenticated Read to /shops/{shopId}**: Anonymous/unauthenticated user attempts `get` -> REJECTED.
2. **Blanket Query Scraping**: Authenticated user attempts `list` on `/shops` without owning the shops -> REJECTED.
3. **Identity Spoofing on Shop Creation**: User `uid_attacker` sends `ownerUid: 'uid_victim'` -> REJECTED.
4. **Email Spoofing Admin Attack**: User signs up with unverified email `ronisherbwalya@gmail.com` (`email_verified: false`) -> REJECTED.
5. **Path Traversal / ID Poisoning**: Attempt to write to shop with ID containing special characters `../../secret` -> REJECTED (`isValidId`).
6. **Owner Hijacking**: Legitimate owner tries to update `ownerUid` to another account -> REJECTED.
7. **Foreign Subcollection Injection**: User creates an item inside another user's `/shops/{otherShopId}/items` -> REJECTED (Master Gate).
8. **Foreign Sales Inspection**: User attempts to read another merchant's `/shops/{otherShopId}/sales` -> REJECTED.
9. **Debt Forgery**: Attacker attempts to modify customer debt records in `/shops/{otherShopId}/customers` -> REJECTED.
10. **Expense Tampering**: Attacker attempts to delete or modify `/shops/{otherShopId}/expenses` -> REJECTED.
11. **Admin Promotion Self-Grant**: Non-admin attempts to write their own UID into `/admins/{myUid}` -> REJECTED.
12. **Catch-All Probe**: Probing arbitrary root collections like `/random_collection/doc` -> REJECTED by default-deny catch-all.
