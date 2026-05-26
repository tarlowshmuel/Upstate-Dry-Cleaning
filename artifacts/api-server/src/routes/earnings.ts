import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, orderLineItemsTable } from "@workspace/db/schema";
import { and, gte, isNotNull, lte } from "drizzle-orm";
import { computeOrderTotals, getSettingsMap } from "../lib/pricing";
import { SETTING_KEYS } from "@workspace/db/schema";

const router = Router();

// All periods are computed in America/New_York to match the Sullivan County
// operations day. Week starts Monday. "All" returns since the dawn of time.
function periodRange(period: string): { start: Date | null; end: Date | null } {
  const tz = "America/New_York";
  const now = new Date();
  // Get the local Y-M-D in the operating tz.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const y = parseInt(parts.year ?? "0", 10);
  const m = parseInt(parts.month ?? "0", 10);
  const d = parseInt(parts.day ?? "0", 10);
  const weekdayShort = parts.weekday ?? "Mon"; // Mon, Tue, ...
  const dayMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dayIdx = dayMap[weekdayShort] ?? 0;

  // Build the start-of-local-day as a UTC date. NY is UTC-4 (EDT) most of the
  // year. We rely on Date's built-in tz conversion: build an ISO string in
  // local form, then let JS parse it as local (server tz might differ), so
  // we use a stable UTC anchor and shift by the tz offset.
  const localMidnight = new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00`);
  // Approximate offset: compare same wall-clock as if it were UTC vs as if it were NY.
  const asUTC = new Date(Date.UTC(y, m - 1, d));
  // Get NY offset in minutes for this date.
  const tzPartsUTC = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(asUTC);
  const hh = parseInt(tzPartsUTC.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mm = parseInt(tzPartsUTC.find((p) => p.type === "minute")?.value ?? "0", 10);
  const nyOffsetMin = -((24 - hh) % 24) * 60 - mm; // negative if behind UTC
  const startOfToday = new Date(localMidnight.getTime() - nyOffsetMin * 60_000);

  // End bound is exclusive (start of next period) — avoids the "midnight
  // boundary" off-by-one where an order priced at 11:59 PM in NY is missed by
  // a "today" report run a minute later from a cached or replayed query.
  const startOfTomorrow = new Date(startOfToday.getTime() + 86_400_000);
  switch (period) {
    case "today":
      return { start: startOfToday, end: startOfTomorrow };
    case "week": {
      const startOfWeek = new Date(startOfToday.getTime() - dayIdx * 86_400_000);
      return { start: startOfWeek, end: startOfTomorrow };
    }
    case "month": {
      const startOfMonth = new Date(startOfToday.getTime() - (d - 1) * 86_400_000);
      return { start: startOfMonth, end: startOfTomorrow };
    }
    case "all":
    default:
      return { start: null, end: null };
  }
}

export async function computeEarningsReport(period: string) {
  const { start, end } = periodRange(period);

  const conds = [isNotNull(ordersTable.pricedAt)];
  if (start) conds.push(gte(ordersTable.pricedAt, start));
  if (end) conds.push(lte(ordersTable.pricedAt, end));
  const where = conds.length === 1 ? conds[0] : and(...conds);

  const pricedOrders = await db.select().from(ordersTable).where(where);
  const allLines = await db.select().from(orderLineItemsTable);
  const linesByOrder = new Map<number, typeof allLines>();
  for (const l of allLines) {
    const arr = linesByOrder.get(l.orderId) ?? [];
    arr.push(l);
    linesByOrder.set(l.orderId, arr);
  }

  const settings = await getSettingsMap();
  const wholesalePercent = settings[SETTING_KEYS.wholesalePercent] ?? 50;

  let orderCount = 0;
  let grossRevenueCents = 0;
  let feesCollectedCents = 0;
  let itemsRevenueCents = 0;
  let paidCents = 0;
  let outstandingCents = 0;
  const byMethod = { zelle: 0, cash: 0, unknown: 0 };
  const byRouteDay = new Map<string, { count: number; revenueCents: number }>();

  for (const o of pricedOrders) {
    const lines = linesByOrder.get(o.id) ?? [];
    const totals = computeOrderTotals(o, lines);
    orderCount += 1;
    grossRevenueCents += totals.grandTotalCents;
    feesCollectedCents += totals.feeCents;
    itemsRevenueCents += totals.itemsSubtotalCents;
    if (o.paid) {
      paidCents += totals.grandTotalCents;
      const method = (o.paidMethod ?? "").toLowerCase();
      if (method === "zelle") byMethod.zelle += totals.grandTotalCents;
      else if (method === "cash") byMethod.cash += totals.grandTotalCents;
      else byMethod.unknown += totals.grandTotalCents;
    } else {
      outstandingCents += totals.grandTotalCents;
    }
    const day = o.pickupDate ?? "no-date";
    const entry = byRouteDay.get(day) ?? { count: 0, revenueCents: 0 };
    entry.count += 1;
    entry.revenueCents += totals.grandTotalCents;
    byRouteDay.set(day, entry);
  }

  // Profit estimate = total revenue − (wholesalePercent% of items revenue).
  // Fees are kept as profit (delivery margin).
  const profitEstimateCents =
    grossRevenueCents - Math.round((wholesalePercent * itemsRevenueCents) / 100);

  return {
    period,
    orderCount,
    grossRevenueCents,
    feesCollectedCents,
    itemsRevenueCents,
    paidCents,
    outstandingCents,
    profitEstimateCents,
    wholesalePercent,
    byMethod,
    byRouteDay: Array.from(byRouteDay.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, v]) => ({ date, count: v.count, revenueCents: v.revenueCents })),
  };
}

router.get("/earnings", async (req, res) => {
  const period = String(req.query.period ?? "all");
  const report = await computeEarningsReport(period);
  res.json(report);
});

export default router;
