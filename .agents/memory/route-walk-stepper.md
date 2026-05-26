---
name: Route walk-through stepper
description: SMS admin route flow (options 6/12) is a per-stop stepper, not a static list dump. Per-stop view re-fetches orders fresh.
---

After admin picks day + wave (option 6 pickup / 12 delivery), the SMS flow enters `admin_route_walk` mode (state stashed as JSON in conversationsTable.items). Overview lists stops; each stop view shows colony/addr/gate + per-order name/unit/phone/items/notes + actions to mark all picked_up/delivered/missed.

**Why per-stop view re-fetches orders by ID:** the dashboard (or another SMS session) can mutate orders while the driver is walking the route. Cached state in the JSON would show stale notes/status; re-fetch keeps the driver looking at current data.

**How to apply:**
- Any status transition triggered from a stop must use the conditional `UPDATE WHERE id=? AND status='<expected_from>'` pattern + return `.returning()` to detect skips. Same rule as bulk-status-transitions.md — never rewind an order that moved on.
- Customer SMS notification must fire only for rows the conditional UPDATE actually touched (use `customerStatusMessage` + `notifyCustomer`, same shape as `actionMarkMissedBatch`).
- When adding new actions to the stepper, mirror them for both `dir: pickup` (pending→picked_up, pending→missed) and `dir: delivery` (ready→delivered) — they are not symmetric.
- The global `"0"/"menu"/"back"` intercept at the top of `handleAdminCommand` already exits walk mode; do NOT add a duplicate exit handler inside the step or it will mask the global one.
