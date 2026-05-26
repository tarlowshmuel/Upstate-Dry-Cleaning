---
name: Wave-split routes
description: Phase 1 Monday route is split into morning/afternoon waves with same-day customer cutoffs; the invariants every wave-touching surface must uphold.
---

Phase 1 pickup day is split into driver waves, each with its own driving order and same-day customer cutoff. Source of truth: `TOWN_SCHEDULE` + `WAVE_ORDER` + `WAVE_CUTOFF_HOUR` in `routes/twilio.ts`.

**Why split:** different cutoffs let lighter-volume towns text in later and still get same-day pickup; the morning wave is a dense depot loop, the afternoon a shorter edge run.

**Invariants — break any of these and orders go missing or get bumped wrongly:**

- Every surface that says "which orders belong to today's route" must filter by BOTH `pickupDate` AND `townsForWave(wave)`. Dropping the wave filter merges both runs into one.
- Orders whose town has no wave (Phase 2 leftovers, typos) silently disappear from BOTH wave routes unless the caller surfaces them as a warning. Always compute and surface orphans alongside the wave-filtered set.
- Cutoff hour comparison is wall-clock in `America/New_York`, not server-local. Server runs UTC in prod, so naive `now.getHours()` puts a 9:59 AM ET customer past the 10 AM cutoff. Use `etParts(now)` for both day-of-week and hour. Same rule for "what is today" anywhere a date-only string is built from `new Date()` — use `etTodayDateOnly()`.
- The TSP optimizer in `computeOptimizedRoute` is geographically optimal but ignores driver preference. Pass `townOrder: WAVE_ORDER[wave]` so stops appear in the order the driver actually wants to drive, not the order the optimizer picks.
- Customer-facing cutoff messaging is wave-aware. If you add a wave or change a cutoff, the welcome message AND the per-order confirmation AND the dashboard wave label all need to move together.

**Re-launching a Phase 2 town:** flip `phase: 1` and pick a `wave` in `TOWN_SCHEDULE`. If the town isn't in `WAVE_ORDER[wave]`, add it in geographic position.
