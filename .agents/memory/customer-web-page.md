---
name: Customer-facing web order page parity + abuse controls
description: The web /order and /my-orders surface must use the same scheduling helpers as the SMS flow AND must rate-limit creates because the endpoints are unauthenticated and trigger outbound SMS.
---

The customer-facing web pages (`/order`, `/my-orders`) live on the dashboard
artifact but call dedicated `/api/customer/*` endpoints. Two non-obvious
constraints govern them.

**Rule 1 — schedule logic must be shared, not re-derived.**
All cutoff, M–Th filtering, dropoff-skip-Shabbos, and confirmation-SMS text
must come from the same helpers the SMS flow uses (currently exported from
`routes/twilio.ts`). Re-implementing any of it on the web side will drift
silently — customers will see a date the SMS flow would have rejected, or
get a different confirmation body than the text gives them.

**Why:** Phase-1 wave cutoffs and the Wed/Thu→Mon shabbos push are
business-critical; a parity gap shows up as customers booking pickups we
can't service.

**How to apply:**
- Re-use `nextPickupOptions`, `nextDropoffDate`, `dropoffPushedPastShabbos`,
  `buildConfirmationSms`, `normalizePhone` from the SMS module — never
  reimplement.
- Re-validate the chosen pickup date with a fresh `nextPickupOptions(...,
  new Date())` at write time. The page may have been open for hours; the
  date that was valid on render can be past its wave cutoff at submit.

**Rule 2 — unauthenticated create endpoints must rate-limit.**
`POST /api/customer/orders` triggers an outbound Twilio SMS to a
user-supplied phone number. Without throttling this is a free SMS-spam /
cost-amplification vector — same pattern as the admin-forward intercept.

**How to apply:**
- Per-IP cooldown + per-IP daily cap on creates.
- Per-phone cooldown + per-phone daily cap on creates.
- Per-IP hourly cap on phone-lookup endpoint (prevents enumeration).
- In-memory Maps are fine single-process; restart-reset only helps real users.
- Return 429 with a friendly "please text us instead" message — never silent.

**Rule 3 — phone-only ownership is weak; lock writes with atomic SQL guards.**
`/my-orders` and reschedule treat "knows the phone number" as the credential.
That's tolerable for read + reschedule-pending, but the reschedule UPDATE
must be conditional in SQL (`WHERE id AND phone_number AND status='pending'`)
so the admin moving an order out of pending between the SELECT and the
UPDATE can't be raced by the customer.

**Open follow-up if data sensitivity ever increases:** gate behind an
SMS-OTP challenge before showing order details or allowing a reschedule.
