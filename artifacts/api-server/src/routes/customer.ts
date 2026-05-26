import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod/v4";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import {
  PHASE_1_TOWNS,
  TOWN_SCHEDULE,
  isPhase1,
  waveOf,
  nextPickupOptions,
  nextDropoffDate,
  dropoffPushedPastShabbos,
  toDateOnly,
  formatLongDate,
  buildConfirmationSms,
  normalizePhone,
} from "./twilio";
import { nextOrderNumber } from "../lib/order-number";
import { notifyCustomer } from "../lib/customer-notify";

const router = Router();

// ─── Abuse controls ───────────────────────────────────────────────────────
// All customer endpoints are unauthenticated and the create/reschedule paths
// trigger outbound SMS. Without throttling these become an SMS-cost
// amplification vector (per .agents/memory/admin-forward-rate-limit.md). We
// gate by (a) per-IP daily cap on creates/reschedules and (b) per-phone
// cooldown + daily cap on creates. Single-process in-memory is fine — a
// restart only relaxes limits for legitimate users.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IP_CREATE_COOLDOWN_MS = 30 * 1000;
const IP_CREATE_DAILY_CAP = 20;
const PHONE_CREATE_COOLDOWN_MS = 2 * 60 * 1000;
const PHONE_CREATE_DAILY_CAP = 5;
const LOOKUP_PER_IP_HOURLY_CAP = 60;

const ipCreateHits = new Map<string, number[]>();
const phoneCreateHits = new Map<string, number[]>();
const ipLookupHits = new Map<string, number[]>();

function prune(arr: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  return arr.filter((t) => t > cutoff);
}
function clientIp(req: Request): string {
  // Trusts the platform's reverse proxy; falls back to socket address.
  return (req.ip ?? req.socket.remoteAddress ?? "unknown").toString();
}

function checkCreateAbuse(
  req: Request,
  phone: string,
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  const ip = clientIp(req);
  const ipHits = prune(ipCreateHits.get(ip) ?? [], DAY_MS, now);
  if (ipHits.length >= IP_CREATE_DAILY_CAP) {
    return { ok: false, reason: "Too many orders from this network today. Please text us instead." };
  }
  if (ipHits.length > 0 && now - ipHits[ipHits.length - 1]! < IP_CREATE_COOLDOWN_MS) {
    return { ok: false, reason: "Please wait a few seconds before submitting again." };
  }
  const phoneHits = prune(phoneCreateHits.get(phone) ?? [], DAY_MS, now);
  if (phoneHits.length >= PHONE_CREATE_DAILY_CAP) {
    return {
      ok: false,
      reason: "We've already received several orders for this number today. Text us to add more.",
    };
  }
  if (phoneHits.length > 0 && now - phoneHits[phoneHits.length - 1]! < PHONE_CREATE_COOLDOWN_MS) {
    return {
      ok: false,
      reason: "Please wait a couple of minutes before placing another order for this number.",
    };
  }
  ipCreateHits.set(ip, [...ipHits, now]);
  phoneCreateHits.set(phone, [...phoneHits, now]);
  return { ok: true };
}

function lookupRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const ip = clientIp(req);
  const hits = prune(ipLookupHits.get(ip) ?? [], HOUR_MS, now);
  if (hits.length >= LOOKUP_PER_IP_HOURLY_CAP) {
    res.status(429).json({ error: "Too many lookups. Please try again later." });
    return;
  }
  ipLookupHits.set(ip, [...hits, now]);
  next();
}

// Public, no-auth endpoints used by the customer-facing /order and /my-orders
// pages. These mirror the SMS booking + reschedule flow so customers using the
// web form get exactly the same scheduling rules, shabbos warnings, cutoffs,
// and confirmation SMS.
//
// Phase 1 only. Phase 2 towns are surfaced via /api/customer/towns as
// "coming soon" so the customer sees we're expanding, but they cannot book.

// ─── GET /api/customer/towns ──────────────────────────────────────────────
// Returns every town in the schedule. Phase 1 towns include 4 upcoming
// Mon–Thu pickup options (auto-bumped past the wave cutoff), each with a
// shabbos-warning flag for Wed/Thu. Phase 2 towns are returned with
// `comingSoon: true` and no options.
router.get("/customer/towns", (_req, res) => {
  const now = new Date();
  const towns = Object.keys(TOWN_SCHEDULE).map((name) => {
    if (!isPhase1(name)) {
      return { name, comingSoon: true, wave: null, options: [] };
    }
    const wave = waveOf(name);
    const options = nextPickupOptions(name, 4, now).map((d) => ({
      date: toDateOnly(d),
      label: formatLongDate(d),
      shabbosWarning: dropoffPushedPastShabbos(d),
      dropoffDate: toDateOnly(nextDropoffDate(d)),
      dropoffLabel: formatLongDate(nextDropoffDate(d)),
    }));
    return { name, comingSoon: false, wave, options };
  });
  res.json({
    towns,
    waveCutoffs: { morning: "10:00 AM", afternoon: "12:00 PM (noon)" },
  });
});

// ─── POST /api/customer/orders ────────────────────────────────────────────
// Customer self-service order placement. Validates that the chosen pickup
// date is still one of the currently-valid options for the town (so a slot
// that expired between page load and submit is rejected), creates the
// order, and texts the customer the same confirmation SMS the wizard sends.
const createCustomerOrderSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(20),
  town: z.string().trim().min(1),
  colony: z.string().trim().min(1).max(80),
  colonyAddress: z.string().trim().max(200).optional().nullable(),
  unitNumber: z.string().trim().min(1).max(40),
  gateAccess: z.string().trim().max(120).optional().nullable(),
  items: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
});

router.post("/customer/orders", async (req, res) => {
  const parsed = createCustomerOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid order", details: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  if (!isPhase1(d.town)) {
    res.status(400).json({
      error: `${d.town} isn't in our service area yet. We'll text everyone when we open it up!`,
    });
    return;
  }

  const phone = normalizePhone(d.phone);
  if (!phone) {
    res.status(400).json({ error: "That doesn't look like a valid phone number." });
    return;
  }

  const abuse = checkCreateAbuse(req, phone);
  if (!abuse.ok) {
    req.log.warn({ phone, ip: clientIp(req) }, "customer order rate-limited");
    res.status(429).json({ error: abuse.reason });
    return;
  }

  // Re-validate the chosen pickup date against the CURRENT set of valid
  // options for this town. The page may have been left open for hours, so a
  // date that was valid when shown might be past its wave cutoff now.
  const validDates = new Set(
    nextPickupOptions(d.town, 4, new Date()).map((dt) => toDateOnly(dt)),
  );
  if (!validDates.has(d.pickupDate)) {
    res.status(400).json({
      error: "That pickup day is no longer available — the cutoff just passed. Please pick a fresh day.",
    });
    return;
  }

  const [y, m, day] = d.pickupDate.split("-").map(Number);
  const pickupDate = new Date(y!, m! - 1, day!);

  // Insert with retry on order-number collision (same pattern as admin path).
  for (let attempt = 0; attempt < 6; attempt++) {
    const orderNumber = await nextOrderNumber();
    try {
      const [created] = await db
        .insert(ordersTable)
        .values({
          orderNumber,
          name: d.name,
          phoneNumber: phone,
          town: d.town,
          colony: d.colony,
          colonyAddress: d.colonyAddress ?? null,
          unitNumber: d.unitNumber,
          gateAccess: d.gateAccess ?? null,
          items: d.items ?? null,
          notes: d.notes ?? null,
          pickupDate: d.pickupDate,
          status: "pending",
          paid: false,
        })
        .returning();
      if (!created) {
        res.status(500).json({ error: "Failed to create order" });
        return;
      }

      // Fire-and-mostly-forget confirmation SMS (don't block the response on
      // Twilio latency, but await so failures show up in logs).
      const confirmSms = buildConfirmationSms({
        orderNumber: created.orderNumber,
        town: created.town,
        colony: created.colony,
        colonyAddress: created.colonyAddress,
        unitNumber: created.unitNumber,
        notes: created.notes,
        pickupDate,
      });
      void notifyCustomer(created, confirmSms);

      res.status(201).json({
        order: created,
        pickupLabel: formatLongDate(pickupDate),
        dropoffLabel: formatLongDate(nextDropoffDate(pickupDate)),
        shabbosWarning: dropoffPushedPastShabbos(pickupDate),
      });
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "23505") {
        req.log.error({ err }, "Failed to create customer order");
        res.status(500).json({ error: "Failed to create order" });
        return;
      }
    }
  }
  res.status(500).json({ error: "Could not generate unique order number" });
});

// ─── GET /api/customer/orders?phone=... ───────────────────────────────────
// Returns the customer's *open* orders (anything not yet delivered or
// cancelled), most recent first. No auth — knowing a phone number is the
// only "credential". Acceptable for dry cleaning order metadata; if this
// ever holds anything more sensitive, gate behind an SMS code.
const ACTIVE_STATUSES = ["pending", "picked_up", "at_cleaners", "ready"] as const;
router.get("/customer/orders", lookupRateLimit, async (req, res) => {
  const rawPhone = String(req.query.phone ?? "");
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    res.status(400).json({ error: "Please provide a valid phone number." });
    return;
  }
  const rows = await db
    .select()
    .from(ordersTable)
    .where(
      and(
        eq(ordersTable.phoneNumber, phone),
        inArray(ordersTable.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(sql`${ordersTable.createdAt} DESC`);
  res.json({
    phone,
    orders: rows.map((o) => ({
      ...o,
      pickupLabel: o.pickupDate
        ? formatLongDate(parseDate(o.pickupDate))
        : null,
      dropoffLabel: o.pickupDate
        ? formatLongDate(nextDropoffDate(parseDate(o.pickupDate)))
        : null,
    })),
  });
});

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

// ─── POST /api/customer/orders/:id/reschedule ─────────────────────────────
// Customer-driven reschedule. Verifies the request phone matches the order's
// phone (so a stranger guessing an order id can't move someone else's
// pickup), validates the new date against the same cutoff rules, then
// updates and texts a fresh confirmation.
const rescheduleSchema = z.object({
  phone: z.string().trim().min(7).max(20),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

router.post("/customer/orders/:id/reschedule", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order id" });
    return;
  }
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ error: "Invalid phone" });
    return;
  }

  // Read first only to validate town + decide the right error message;
  // the actual update is conditional in SQL so we don't race with the
  // dashboard moving the order out of "pending" between read and write.
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  if (!order || order.phoneNumber !== phone) {
    // 404 either way — don't reveal which orders exist.
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (order.status !== "pending") {
    res.status(400).json({
      error: "This order is already in progress and can't be rescheduled from the web. Text us and we'll help.",
    });
    return;
  }

  const validDates = new Set(
    nextPickupOptions(order.town, 4, new Date()).map((dt) => toDateOnly(dt)),
  );
  if (!validDates.has(parsed.data.pickupDate)) {
    res.status(400).json({
      error: "That pickup day is no longer available — please pick a fresh day.",
    });
    return;
  }

  // Atomic guard: only update if the order is still pending AND still owned
  // by this phone. Closes the TOCTOU window between the SELECT above and
  // here (admin could have picked it up, paid it, or reassigned in between).
  const [updated] = await db
    .update(ordersTable)
    .set({ pickupDate: parsed.data.pickupDate })
    .where(
      and(
        eq(ordersTable.id, id),
        eq(ordersTable.phoneNumber, phone),
        eq(ordersTable.status, "pending"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(409).json({
      error: "This order changed while you were rescheduling — please refresh and try again.",
    });
    return;
  }

  const newPickup = parseDate(parsed.data.pickupDate);
  const confirmSms = buildConfirmationSms({
    orderNumber: updated.orderNumber,
    town: updated.town,
    colony: updated.colony,
    colonyAddress: updated.colonyAddress,
    unitNumber: updated.unitNumber,
    notes: updated.notes,
    pickupDate: newPickup,
  });
  void notifyCustomer(updated, `🔄 Rescheduled:\n\n${confirmSms}`);

  res.json({
    order: updated,
    pickupLabel: formatLongDate(newPickup),
    dropoffLabel: formatLongDate(nextDropoffDate(newPickup)),
    shabbosWarning: dropoffPushedPastShabbos(newPickup),
  });
});

export default router;
