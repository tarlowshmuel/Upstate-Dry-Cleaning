---
name: Dropoff skips Fri/Sat/Sun
description: Pickup+2 dropoff math must roll forward past Fri/Sat/Sun, and Wed/Thu pickups need a shabbos warning on every customer-facing surface.
---

Dropoff is pickup + 2 days, but Fri/Sat/Sun are never valid delivery days (no Friday delivery window, no shabbos work). `nextDropoffDate` rolls forward to the next Mon–Thu. In practice: Mon→Wed, Tue→Thu, Wed→next Mon, Thu→next Mon.

**Why:** customers booking on Wed/Thu would otherwise expect a Fri/Sat dropoff and be surprised when it actually lands the following Monday. Burying that surprise inside a confirmation message generated complaints. The rule has to be enforced in code (not just docs) because the math is easy to recompute incorrectly in any surface that shows a dropoff date.

**How to apply:**
- Always go through `nextDropoffDate(pickupDate)` for the dropoff calendar value. Never inline a `+2 days` calculation.
- Any surface that shows a customer their pickup *day* must call `dropoffPushedPastShabbos(pickupDate)` and surface a shabbos warning when true. Surfaces today: the customer pickup-day picker, the admin pickup-day picker, the missed-order reschedule picker, and `buildConfirmationSms`. New surfaces must do the same.
- Phase 1 pickups are Mon–Thu only; that's enforced separately by `isPickupWeekday`/`nextPickupOptions`. Don't conflate the two checks — pickup-eligibility is a different rule than dropoff-roll-forward.
