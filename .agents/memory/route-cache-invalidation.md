---
name: Route cache invalidation
description: Order mutations must invalidate the route query cache with the right key shape, or the route panel goes stale.
---

After any order mutation (create, update, delete, status/paid change), invalidate the route cache with the **prefix key** `["route"]`, not a specific tuple.

**Why:** `RoutePanel` builds its react-query keys as `["route", selectedDate, direction, wave]` (4 dimensions: date × pickup/delivery × morning/afternoon). A literal `["route", "today"]` key never matches anything and silently leaves stale data in the UI. The bug bit twice (update + delete) before being caught by code review.

**How to apply:** In any dashboard mutation success handler that can affect what shows on the route, do:
```ts
await qc.invalidateQueries({ queryKey: ["route"] });
```
TanStack Query treats the queryKey arg as a prefix by default, so this invalidates every route variant in one call.
