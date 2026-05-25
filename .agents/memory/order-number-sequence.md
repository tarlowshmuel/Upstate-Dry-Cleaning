---
name: Order number sequence
description: Why the order_number_seq Postgres sequence must be declared in Drizzle schema, not just created ad-hoc.
---

`nextOrderNumber()` (in `lib/order-number.ts`) does `SELECT nextval('order_number_seq')`. The sequence must exist as a first-class Drizzle object (`pgSequence("order_number_seq", ...)` in `lib/db/src/schema/orders.ts`) so it survives schema pushes and recreations.

**Why:** an earlier version created the sequence implicitly (or out-of-band) and a later `drizzle-kit push` silently dropped it, causing the SMS "new order" wizard to crash deep in the flow (`order_number_seq does not exist`) after the user had already typed in 8 fields. The crash is invisible from a typecheck — it only surfaces at runtime mid-wizard.

**How to apply:**
- Any DB-side object that runtime code calls by literal name (sequences, custom types, extensions, materialized views) must be declared in Drizzle so push/regenerate keeps it. Don't rely on hand-run `CREATE SEQUENCE`.
- When seeding a new sequence into an existing DB, also `SELECT setval('seq', <max_existing>, true)` so the first generated value doesn't collide with seed data.
- The first end-to-end test of a multi-step SMS/web wizard should walk to the final commit step — earlier steps can pass while the final insert blows up.
