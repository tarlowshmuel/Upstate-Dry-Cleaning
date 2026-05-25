import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { computeOptimizedRoute } from "../lib/route-service";

const router = Router();

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

router.get("/route/today", async (req, res) => {
  const requested = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : toDateOnly(new Date());
  try {
    const orders = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, date)));

    const route = await computeOptimizedRoute(orders);

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
