---
name: SMS ↔ dashboard write-path parity
description: For this dry-cleaning app the admin must be able to run the business from SMS alone. Any side effect attached to one write path must be hooked into the matching path on the other surface.
---

The dashboard's `PATCH /orders/:id/paid` and the SMS admin "mark paid" action (`actionApplyUpdate` option 4) both flip `orders.paid`. They are separate code paths.

**Why:** When the referral qualification hook was first added only inside the SMS admin path, marking an order paid via the web dashboard silently failed to qualify the matching referral — invisible drift, no error, customer never gets their credit.

**How to apply:** Put side-effect logic (qualification, notification, audit) in a shared module under `artifacts/api-server/src/lib/` and call it from BOTH surfaces. When adding ANY new write path (e.g. a future bulk-update endpoint), check whether the matching SMS admin action already triggers side effects and mirror them — and vice versa. Same rule for: status transitions, customer notifications, referral credit application.
