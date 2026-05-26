---
name: HELP intercept must preserve in-flight conversation state
description: Global SMS intercepts (HELP/INFO) that upsert a new conversation step will wipe a mid-booking customer's progress unless prior state is stashed and restored on exit.
---

Any global SMS keyword that hijacks the customer flow regardless of current
`step` (e.g. HELP, STOP, INFO) must stash the existing `conversationsTable`
row into `items` as JSON before overwriting `step`, and restore it from every
exit path (menu choice, cancel, timeout, completion).

**Why:** Twilio CTA compliance requires HELP to work from anywhere, but a
naïve `onConflictDoUpdate({ step: "help_menu" })` clobbers `name`, `town`,
`colony`, `unitNumber`, etc. on a customer who was mid-booking. They then
return to the order flow and the next message is misinterpreted because the
prior context is gone — silent data loss, no error.

**How to apply:**
- Before entering the global intercept's first step, read the existing convo.
- If `step` is not already one of the intercept's own steps, JSON-encode the
  prior `{step, name, town, colony, colonyAddress, unitNumber, gateAccess,
  items, notes}` into `items` of the new row.
- Every exit path calls a `restorePrev(stash)` helper that either UPDATEs back
  to the prior fields or DELETEs the row if no prior state existed.
- Re-entry into the intercept (HELP while already in help_menu) must NOT
  re-stash the help_menu row over the original prev — pass through the
  existing `items` instead.

Same rule applies to any future global commands ("cancel", "status", etc.) —
if they can fire mid-flow, they must be non-destructive.
