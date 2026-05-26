---
name: Bulk status transitions
description: Bulk order-state changes must be server-side conditional UPDATEs, not client fanout, to prevent stale snapshots from rewinding orders.
---

Any "mark all X → Y" admin action must run as a single server-side
`UPDATE … WHERE status='X' RETURNING *`, not as N parallel client PATCHes
over a client-captured ID list.

**Why:** The client's order list is a snapshot from the last fetch. Between
fetch and confirm-click, an order can move on (SMS admin marks it delivered,
another tab acts on it, etc.). Client fanout sends unconditional
`status: Y` for every ID and will happily rewind those orders. The
server-side `WHERE` clause makes the operation atomically self-filtering —
ineligible rows are skipped automatically and reported in the response.

**How to apply:**
- Add a dedicated endpoint (e.g. `POST /orders/bulk-mark-ready`) returning
  `{ updated: N, orders: [...] }` so the UI toast reflects truth.
- Iterate the returned `orders` to fire the same per-order side effects
  (notifications, etc.) the single-order PATCH path does — keeps SMS↔dashboard
  parity per `sms-dashboard-parity.md`.
- Client should pass NO ID list. Use the local count only as a UI affordance
  for button visibility/label.
