---
name: Town phase rollout
description: Why TOWN_SCHEDULE carries a `phase` tag and how the customer / admin booking flows must diverge on it.
---

`TOWN_SCHEDULE` in the SMS handler tags every town with `phase: 1 | 2`. Phase 1 = currently servicing. Phase 2 = on the roadmap, advertised to customers but not bookable.

**Why:** the business launches in geographic waves. Showing a Phase 2 town in the bookable picker creates orders the driver can't fulfill; hiding it entirely loses the signal that customers in that area want service. The compromise is: customer picker numbers Phase 1 only (those are the valid selections) and lists Phase 2 below as a "🚧 Coming soon" footer; if a customer types a Phase 2 town name, the flow politely declines and wipes the conversation. Admin booking flows (SMS new-order wizard, SMS edit-address town step, dashboard `/towns` endpoint) show **Phase 1 only** — admins shouldn't be able to book what we can't service either.

**How to apply:**
- One source of truth: change a town's status by editing its `phase` field in `TOWN_SCHEDULE`. Do not maintain parallel "active towns" arrays.
- Customer-facing list helper and admin-facing list helper must be distinct functions backed by `PHASE_1_TOWNS` filtering — never reuse the same `townList()` for both, or admins start seeing "coming soon" footers and customers start seeing bookable Phase 2 entries.
- The `/towns` endpoint backs the dashboard New Order dialog, so it must be filtered to Phase 1 too. If you ever need an "all towns including roadmap" endpoint for reporting, add a separate route — don't loosen this one.
- When a customer picks Phase 2 (by name, since the numbers don't reach), delete their conversation row before responding so a stale `step: "town"` doesn't strand them.
