import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { computeOptimizedRoute } from "../lib/route-service";
import { WAVE_ORDER, townsForWave, etTodayDateOnly, type RouteWave } from "./twilio";

const router = Router();

// The business runs Mon–Thu only. Sun/Fri/Sat have no routes.
const ROUTE_DAYS = new Set([1, 2, 3, 4]);
const WD_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isoToDate(iso: string): Date {
  const [y, m, day] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y!, (m ?? 1) - 1, day ?? 1);
}

router.get("/route/today", async (req, res) => {
  const requested = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : etTodayDateOnly();
  const direction = req.query.direction === "delivery" ? "delivery" as const : "pickup" as const;
  const wave: RouteWave = req.query.wave === "afternoon" ? "afternoon" : "morning";
  const d = isoToDate(date);
  const dayName = WD_FULL[d.getDay()]!;
  const isOperating = ROUTE_DAYS.has(d.getDay());
  try {
    const waveTowns = new Set(townsForWave(wave));
    const otherWaveTowns = new Set(townsForWave(wave === "morning" ? "afternoon" : "morning"));
    const allOrders = !isOperating
      ? []
      : direction === "delivery"
        ? await db.select().from(ordersTable).where(eq(ordersTable.status, "ready"))
        : await db.select().from(ordersTable)
            .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, date)));
    const orders = allOrders.filter((o) => waveTowns.has(o.town));
    // Surface "orphan" orders — eligible by date/status but whose town isn't
    // in ANY wave. Without this they silently disappear from both waves
    // (e.g. legacy data after a Phase 1 → Phase 2 demotion, or a typo'd town).
    const orphans = allOrders.filter(
      (o) => !waveTowns.has(o.town) && !otherWaveTowns.has(o.town),
    );

    const route = await computeOptimizedRoute(orders, direction, {
      townOrder: WAVE_ORDER[wave],
    });
    if (!isOperating) {
      route.warnings.unshift(`No route on ${dayName} (${date}). The business runs Mon–Thu only.`);
    }
    if (orphans.length > 0) {
      const orphanTowns = [...new Set(orphans.map((o) => o.town))].join(", ");
      route.warnings.push(
        `${orphans.length} order${orphans.length !== 1 ? "s" : ""} not in any wave (towns: ${orphanTowns}) — not shown on either route.`,
      );
    }

    const stopsWithDetail = route.stops.map((s, idx) => {
      const stopOrders = orders
        .filter((o) => s.orderIds.includes(o.id))
        .sort((a, b) => {
          const an = parseInt(a.unitNumber, 10);
          const bn = parseInt(b.unitNumber, 10);
          if (!isNaN(an) && !isNaN(bn)) return an - bn;
          return a.unitNumber.localeCompare(b.unitNumber);
        })
        .map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          name: o.name,
          phoneNumber: o.phoneNumber,
          unitNumber: o.unitNumber,
          gateAccess: o.gateAccess,
          notes: o.notes,
          items: o.items,
        }));
      return { ...s, index: idx + 1, orders: stopOrders };
    });

    res.json({
      date,
      dayName,
      direction,
      wave,
      isOperatingDay: isOperating,
      start: route.start,
      end: route.end,
      stops: stopsWithDetail,
      totalDistanceKm: route.totalDistanceKm,
      totalDistanceMiles: route.totalDistanceMiles,
      mapsUrl: route.mapsUrl,
      warnings: route.warnings,
    });
  } catch (err) {
    req.log.error({ err }, "route/today failed");
    res.status(500).json({ error: "Failed to compute route" });
  }
});

export default router;
