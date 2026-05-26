---
name: Route direction geometry
description: How pickup vs delivery routes are defined and where the start/end addresses live.
---

The route service supports two directions, controlled by a `direction: "pickup" | "delivery"` arg:

- **pickup**: driver home → customers → dry cleaners (collect bags)
- **delivery**: dry cleaners → customers → driver home (return clean bags)

**Why:** the business is a one-driver pickup/delivery loop. Both directions share the same stop-clustering and TSP optimizer; only the endpoints swap. Treating delivery as "pickup reversed" keeps one code path.

**How to apply:**
- Driver-home and dry-cleaners addresses must live ONLY in `lib/route-service.ts` (`DRIVER_HOME` / `DRY_CLEANERS`, env-overridable). Never re-declare them in route handlers — earlier duplicates in `twilio.ts` caused drift bugs.
- Use `endpointsFor(direction)` to get `{startAddr, endAddr}`. `computeOptimizedRoute(orders, direction)` handles the rest.
- Delivery filter is `status = 'picked_up'` with NO `pickupDate` filter — once an order is at the cleaners it stays "ready to deliver" regardless of the day it was collected. Pickup filter is `status='pending' AND pickupDate=date`.
- All three surfaces (API `/api/route/today?direction=`, SMS option 6/12, dashboard RoutePanel toggle) must thread the same `direction` value end-to-end.
- Same rule applies to the wave dimension — see `wave-routes.md`.
