---
name: Pickup weekday window
description: Pickups only run Monday–Thursday; every create/update path that writes pickupDate must enforce this.
---

Pickups only run **Monday–Thursday** (UTC `getUTCDay()` ∈ [1,4]).

**Why:** Driver doesn't run routes Fri/Sat/Sun, and TOWN_SCHEDULE today only schedules Mon/Tue, but ad-hoc admin overrides used to let weekend dates slip in.

**How to apply:** Any code path that writes `orders.pickupDate` must reject dow < 1 or > 4. Today that's enforced in:
- `createOrderSchema` + `updateOrderSchema` Zod refines (dashboard new/edit)
- SMS `admin_edit_pickup` step (twilio.ts)
- `nextPickupDate(town)` is implicitly safe because TOWN_SCHEDULE only contains Mon/Tue pickups — but if a Fri/Sat/Sun town is ever added, that function will start producing invalid dates and needs its own guard.

When adding a new pickup-date write path (e.g. reschedule wizard, bulk reassign), copy the same guard.
