---
name: SMS state-machine writes
description: Rule for safely committing writes at the end of a multi-turn SMS conversation.
---

A multi-turn SMS flow (offer → confirm → pick → commit) takes seconds-to-minutes of wall time, and the underlying row can change between turns (admin edits in a dashboard, a newer status, a second offer for the same phone, etc.).

**The rule:** at the *offer* step, capture the specific row id in the conversation state. At the *commit* step, write with a conditional `WHERE id=? AND owner=? AND status=<expected>` and use `.returning()`; if zero rows updated, surface a "no longer eligible" message instead of pretending it succeeded.

**Why:** without id binding, the YES branch silently re-queries "latest matching" and can act on the wrong row. Without the conditional write, a stale conversation can regress an order that was already handled elsewhere (e.g. revive a delivered order back to pending).

**How to apply:** any time the customer or admin replies "yes/confirm/pick N" to do something to a row referenced in an earlier message — store the id when you send the message, re-validate at write, and report skipped/ineligible rows rather than swallowing them.
