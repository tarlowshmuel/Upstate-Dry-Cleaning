---
name: Customer menu picker writes line items
description: Web /order picker submits structured items; server must resolve + write inside one transaction and still snapshot orders.items text for SMS parity.
---

# Customer items picker — resolution must be atomic, items text must stay populated

When the customer-facing /order form submits structured items (array of `{priceListId, quantity}`), the server must:

1. Resolve the picked IDs against the active price list **inside the same `db.transaction` block** that inserts the order + line items. Resolving before the transaction lets a concurrent admin price/rename/soft-delete slip between read and write.
2. Snapshot `itemName` and `unitPriceCents` from the price list into `order_line_items` rows (matches the schema's snapshot contract — see `lib/db/src/schema/order-line-items.ts`).
3. Build a short text summary (e.g. `"3 Shirt, 1 Suit"`) and write it to `orders.items`. The SMS admin views and Twilio confirmation messages still read that column.
4. Return 400 on any unresolved/inactive ID rather than silently dropping — silent drop = invisible item loss for the customer.

**Why:** the SMS-side admin views were built before structured line items existed and still read `orders.items` directly; dropping that text summary would make web-booked orders look empty in the admin SMS flow. And resolving outside the transaction leaves a TOCTOU window where the customer can land a line item against a price/name that no longer exists.

**How to apply:** any future write path that creates orders from structured selections (web, mobile, future kiosks) must do both — resolve-inside-tx and write the text summary. Don't be tempted to drop the text summary "because we have line items now."

**Frontend pairing:** load towns and menu independently (don't `Promise.all`), so a menu fetch failure still lets the customer book with notes.
