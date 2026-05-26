---
name: Customer-triggered admin SMS must be rate limited
description: Any path where an inbound customer message causes an outbound SMS to the admin phone is a spam/cost amplification vector and needs per-phone throttling.
---

Any flow where a customer's SMS triggers `notifyAdmin(...)` (or otherwise
sends to `ADMIN_PHONE_NUMBER`) must enforce throttling before the outbound
call. Without it, anyone with the business number can drive arbitrary SMS
volume into the admin phone — annoying at minimum, billable at worst.

**Why:** Twilio charges per outbound segment; abuse loops (e.g. HELP→Other→
message, repeated) cost real money and bury the admin under spam. The
business number is on a public website (CTA page) so the sender pool is
effectively the open internet.

**How to apply:**
- Per-phone cooldown (~60s) between consecutive forwards.
- Per-phone daily cap (~3/24h) on total forwards.
- Minimum body length / quality gate before counting the forward.
- Truncate forwarded body (~500 chars) so a long paste can't blow segment count.
- In-memory `Map<phone, timestamps[]>` is fine for single-process; restarts
  resetting counts only HELPS legitimate users. Move to DB only if going
  multi-instance.
- Failure-safe response: if rate-limited or Twilio errors, tell the customer
  to call the business number directly — never leave them with silence.
