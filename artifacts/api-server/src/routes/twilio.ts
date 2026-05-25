import { Router, type RequestHandler } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable } from "@workspace/db/schema";
import { eq, and, gte, desc, ilike, or, sql } from "drizzle-orm";
import { nextOrderNumber } from "../lib/order-number";

const router = Router();

// ─── Towns + Schedule ─────────────────────────────────────────────────────────
// Corridor-based split: Monday handles the Rt 42 south corridor (tight cluster
// around Fallsburg), Tuesday handles the Rt 17 west / Liberty corridor.
// Drop-off is always pickup + 2 days.
const TOWN_SCHEDULE: Record<string, { pickup: string; dropoff: string }> = {
  // ── Monday: Rt 42 south corridor ──────────────────────────────────────────
  "Fallsburg":        { pickup: "Monday",  dropoff: "Wednesday" },
  "South Fallsburg":  { pickup: "Monday",  dropoff: "Wednesday" },
  "Woodbourne":       { pickup: "Monday",  dropoff: "Wednesday" },
  "Loch Sheldrake":   { pickup: "Monday",  dropoff: "Wednesday" },
  "Hurleyville":      { pickup: "Monday",  dropoff: "Wednesday" },
  "Woodridge":        { pickup: "Monday",  dropoff: "Wednesday" },
  "Glen Wild":        { pickup: "Monday",  dropoff: "Wednesday" },
  // ── Tuesday: Rt 17 west / Liberty corridor ────────────────────────────────
  "Monticello":       { pickup: "Tuesday", dropoff: "Thursday"  },
  "Kiamesha Lake":    { pickup: "Tuesday", dropoff: "Thursday"  },
  "Ferndale":         { pickup: "Tuesday", dropoff: "Thursday"  },
  "Liberty":          { pickup: "Tuesday", dropoff: "Thursday"  },
  "Parksville":       { pickup: "Tuesday", dropoff: "Thursday"  },
  "Livingston Manor": { pickup: "Tuesday", dropoff: "Thursday"  },
  "Dairyland":        { pickup: "Tuesday", dropoff: "Thursday"  },
};

const TOWNS = Object.keys(TOWN_SCHEDULE);

// Driving order within each corridor — kept here so the route view can sort
// stops in the order the driver actually visits them.
// Monday (Rt 42): Fallsburg → South Fallsburg → Woodbourne → Loch Sheldrake → Hurleyville → Woodridge → Glen Wild.
// Tuesday (Rt 17): Monticello → Kiamesha Lake → Ferndale → Liberty → Parksville → Livingston Manor → Dairyland.
const TOWN_ROUTE_ORDER: string[] = [
  "Fallsburg",
  "South Fallsburg",
  "Woodbourne",
  "Loch Sheldrake",
  "Hurleyville",
  "Woodridge",
  "Glen Wild",
  "Monticello",
  "Kiamesha Lake",
  "Ferndale",
  "Liberty",
  "Parksville",
  "Livingston Manor",
  "Dairyland",
];

function townRouteIndex(town: string): number {
  const i = TOWN_ROUTE_ORDER.indexOf(town);
  return i === -1 ? 999 : i;
}

const DAY_NUM: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

const DRIVER_START = process.env.DRIVER_START_ADDRESS ?? "458 Riverside Drive, Fallsburg, NY";
const DRIVER_END = process.env.DRY_CLEANERS_ADDRESS ?? DRIVER_START;

const PAYMENT_PHONE = "(929) 345-0940";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://twilio-connect-shmueltarlow.replit.app";
const TERMS_URL = `${PUBLIC_URL}/legal`;

function welcomeIntro(): string {
  return [
    `⏰ Orders must be placed by 12:00 AM (midnight) the night before your pickup day.`,
    `💵 Payment: Cash or Zelle to ${PAYMENT_PHONE} on delivery.`,
    `📄 Terms: ${TERMS_URL}`,
  ].join("\n");
}

function askForNotesMessage(): string {
  return (
    `Almost done! Any special notes for our driver? (e.g. "I won't be home 2–4pm, bag is by the door")\n\n` +
    `Reply with your note, or text "skip" to place your order.`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function twimlResponse(message: string): string {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  return twiml.toString();
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nextPickupDate(town: string, now: Date = new Date()): Date | null {
  const schedule = TOWN_SCHEDULE[town];
  if (!schedule) return null;
  const target = DAY_NUM[schedule.pickup];
  if (target === undefined) return null;
  const today = now.getDay();
  let daysUntil = (target - today + 7) % 7;
  // Cutoff: midnight of pickup day. If today === pickup day, push to next week.
  if (daysUntil === 0) daysUntil = 7;
  const result = new Date(now);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() + daysUntil);
  return result;
}

function nextDropoffDate(pickupDate: Date): Date {
  // Both schedules are pickup + 2 days
  const d = new Date(pickupDate);
  d.setDate(d.getDate() + 2);
  return d;
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

function townList(): string {
  return TOWNS.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

// Public read-only endpoint so the dashboard can show the towns + auto-fill
// pickup date when the admin picks a town in the New Order dialog.
router.get("/towns", (_req, res) => {
  const now = new Date();
  res.json(
    TOWNS.map((name) => {
      const sched = TOWN_SCHEDULE[name]!;
      const next = nextPickupDate(name, now);
      return {
        name,
        pickupDay: sched.pickup,
        dropoffDay: sched.dropoff,
        nextPickupDate: next ? toDateOnly(next) : null,
      };
    }),
  );
});

// Parse free-form items text like "2 suits, 3 dress shirts, 1 coat" → { Suit: 2, Dress Shirt: 3, Coat: 1 }
function parseItemsText(text: string | null): Record<string, number> {
  if (!text) return {};
  const result: Record<string, number> = {};
  // Match: number followed by item name (until comma, "and", or end)
  const regex = /(\d+)\s+([a-zA-Z][a-zA-Z\s/-]*?)(?=\s*(?:,|;|and|$|\s+\d+\s+[a-zA-Z]))/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const qty = parseInt(match[1]!);
    let name = match[2]!.trim().toLowerCase();
    // Strip trailing plural 's' for normalization (suits → suit, dresses → dresse... handled below)
    if (name.endsWith("es") && (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes"))) {
      name = name.slice(0, -2);
    } else if (name.endsWith("s") && !name.endsWith("ss")) {
      name = name.slice(0, -1);
    }
    // Title case
    name = name.replace(/\b\w/g, c => c.toUpperCase());
    if (name && qty > 0) {
      result[name] = (result[name] ?? 0) + qty;
    }
  }
  return result;
}

function buildRouteUrl(stops: OrderRow[]): string {
  const waypoints = stops
    .map(s => [s.colonyAddress, s.colony, s.town, "NY"].filter(Boolean).join(", "))
    .map(encodeURIComponent)
    .join("|");
  const origin = encodeURIComponent(DRIVER_START);
  const destination = encodeURIComponent(DRIVER_END);
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${waypoints}&travelmode=driving`;
}

type OrderRow = typeof ordersTable.$inferSelect;

function formatOrder(o: OrderRow): string {
  const gate = o.gateAccess ? `Gate: ${o.gateAccess}` : "No gate";
  const addr = o.colonyAddress ? `${o.colonyAddress}, ` : "";
  const notesLine = o.notes ? `\n📝 Notes: ${o.notes}` : "";
  const itemsLine = `\n📦 Items: ${o.items ?? "(not set)"}`;
  const pickup = o.pickupDate ? `Pickup: ${o.pickupDate}\n` : "";
  const paid = o.paid ? "PAID ✓" : "UNPAID";
  return `#${o.id} | ${o.orderNumber}\n${o.name} | ${o.phoneNumber}\n${addr}${o.colony}, ${o.town}\nUnit: ${o.unitNumber} | ${gate}${itemsLine}${notesLine}\n${pickup}Status: ${o.status} | ${paid}`;
}

// ─── Admin Menu System ─────────────────────────────────────────────────────────
const ADMIN_MAIN_MENU = [
  "🧺 ADMIN MENU",
  "",
  "1. Today's pickups",
  "2. Orders at cleaners",
  "3. Pending orders",
  "4. Unpaid orders",
  "5. Missed pickups",
  "6. Route (pick any day)",
  "7. Stats",
  "8. Look up an order",
  "9. Update an order",
  "10. New order",
  "",
  'Tip: "sort newest|oldest|pickup|name" · "range today|week|all"',
  'Reply with a number (or "menu" anytime).',
].join("\n");

// ─── Admin preferences (sort / time range) ────────────────────────────────────
// In-memory because admin is a single user; resets on restart, which is fine.
type SortKey = "newest" | "oldest" | "pickup-asc" | "name";
type RangeKey = "today" | "week" | "all";
interface AdminPrefs { sort: SortKey; range: RangeKey }
const adminPrefs = new Map<string, AdminPrefs>();
function getPrefs(phone: string): AdminPrefs {
  let p = adminPrefs.get(phone);
  if (!p) { p = { sort: "newest", range: "all" }; adminPrefs.set(phone, p); }
  return p;
}
function sortOrders(orders: OrderRow[], sort: SortKey): OrderRow[] {
  const arr = [...orders];
  switch (sort) {
    case "newest":     return arr.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    case "oldest":     return arr.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    case "pickup-asc": return arr.sort((a, b) => (a.pickupDate ?? "").localeCompare(b.pickupDate ?? ""));
    case "name":       return arr.sort((a, b) => a.name.localeCompare(b.name));
  }
}
function rangeWhereClause(range: RangeKey) {
  if (range === "today") return eq(ordersTable.pickupDate, toDateOnly(new Date()));
  if (range === "week") {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7); weekAgo.setHours(0, 0, 0, 0);
    return gte(ordersTable.createdAt, weekAgo);
  }
  return undefined;
}
function prefsBadge(p: AdminPrefs): string {
  return `[sort=${p.sort} · range=${p.range}]`;
}

const ADMIN_STATS_MENU = [
  "📊 STATS — pick a range:",
  "",
  "1. Today",
  "2. This week",
  "3. All time",
  "",
  "0. Back to menu",
].join("\n");

function adminUpdateMenu(order: OrderRow): string {
  return [
    `✏️ UPDATE Order #${order.id} — ${order.name}`,
    `Status: ${order.status} | ${order.paid ? "PAID" : "UNPAID"}`,
    ``,
    `── Status ──`,
    `1. Mark picked up`,
    `2. Mark delivered`,
    `3. Mark missed`,
    `4. Mark paid`,
    `5. Mark unpaid`,
    ``,
    `── Edit fields ──`,
    `6. Items`,
    `7. Name`,
    `8. Phone`,
    `9. Address (town · colony · unit/gate)`,
    `10. Pickup date`,
    `11. Notes`,
    ``,
    `0. Back to menu`,
  ].join("\n");
}

async function setAdminStep(phone: string, step: string, scratch: string | null = null): Promise<void> {
  await db
    .insert(conversationsTable)
    .values({ phoneNumber: phone, step, items: scratch })
    .onConflictDoUpdate({
      target: conversationsTable.phoneNumber,
      set: { step, items: scratch, updatedAt: new Date() },
    });
}

// ─── Admin Actions (data fetchers) ─────────────────────────────────────────────
async function actionTodayPickups(prefs: AdminPrefs): Promise<string> {
  const today = toDateOnly(new Date());
  const orders = await db
    .select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)));
  if (orders.length === 0) return "No pickups scheduled for today.";
  const sorted = sortOrders(orders, prefs.sort);
  return `TODAY'S PICKUPS (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

async function actionTodayReturns(prefs: AdminPrefs): Promise<string> {
  const orders = await db
    .select().from(ordersTable)
    .where(eq(ordersTable.status, "picked_up"));
  if (orders.length === 0) return "No returns scheduled.";
  const sorted = sortOrders(orders, prefs.sort);
  return `RETURNS (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

async function actionPending(prefs: AdminPrefs): Promise<string> {
  const baseWhere = eq(ordersTable.status, "pending");
  const rangeWhere = rangeWhereClause(prefs.range);
  const orders = await db
    .select().from(ordersTable)
    .where(rangeWhere ? and(baseWhere, rangeWhere) : baseWhere);
  if (orders.length === 0) return `No pending orders ${prefsBadge(prefs)}.`;
  const sorted = sortOrders(orders, prefs.sort);
  return `PENDING (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

async function actionUnpaid(prefs: AdminPrefs): Promise<string> {
  const baseWhere = eq(ordersTable.paid, false);
  const rangeWhere = rangeWhereClause(prefs.range);
  const orders = await db
    .select().from(ordersTable)
    .where(rangeWhere ? and(baseWhere, rangeWhere) : baseWhere);
  if (orders.length === 0) return `All orders paid 🎉 ${prefsBadge(prefs)}.`;
  const sorted = sortOrders(orders, prefs.sort);
  return `UNPAID (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

// ─── Missed pickups ───────────────────────────────────────────────────────────
// Any pending order whose pickup date is today-or-earlier counts as at-risk.
async function actionMissed(): Promise<{ message: string; ids: string }> {
  const today = toDateOnly(new Date());
  const orders = await db.select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), sql`${ordersTable.pickupDate} <= ${today}`))
    .orderBy(ordersTable.pickupDate);
  if (orders.length === 0) {
    return { message: "✅ No missed pickups.\n\n0. Back to menu", ids: "" };
  }
  const lines = orders.map((o, i) =>
    `${i + 1}. ${o.orderNumber} — ${o.name} · ${o.colony}, ${o.town} (pickup ${o.pickupDate})`
  ).join("\n");
  return {
    message:
      `🚨 MISSED / AT-RISK (${orders.length}):\n\n${lines}\n\n` +
      `Reply with numbers to mark missed (e.g. "1,3"), "all" for everything, or "0" to cancel.\n` +
      `(Customers will be auto-notified to reschedule.)`,
    ids: orders.map((o) => o.id).join(","),
  };
}
async function actionMarkMissedBatch(ids: number[]): Promise<string> {
  let ok = 0, skipped = 0;
  for (const id of ids) {
    // Conditional update — only flip orders that are still pending. Avoids
    // regressing orders that moved on (picked_up/delivered) since the list
    // was generated.
    const updated = await db.update(ordersTable)
      .set({ status: "missed" })
      .where(and(eq(ordersTable.id, id), eq(ordersTable.status, "pending")))
      .returning();
    if (updated.length === 0) { skipped++; continue; }
    const o = updated[0]!;
    const msg = customerStatusMessage(o, "missed");
    if (msg) await notifyCustomer(o, msg);
    ok++;
  }
  return `✅ Marked ${ok} order${ok !== 1 ? "s" : ""} missed; customer${ok !== 1 ? "s" : ""} notified.` +
         (skipped ? ` (${skipped} skipped — already updated since list was generated)` : "");
}

// ─── Route day picker ─────────────────────────────────────────────────────────
function buildRouteDayMenu(): { message: string; dates: string[] } {
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lines: string[] = ["🚚 ROUTE — pick a day:", ""];
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    const label = `${wd[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}${i === 0 ? " (Today)" : ""}`;
    lines.push(`${i + 1}. ${label}`);
    dates.push(toDateOnly(d));
  }
  lines.push("", "0. Back to menu");
  return { message: lines.join("\n"), dates };
}
async function actionRouteForDate(date: string): Promise<string> {
  const orders = await db.select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, date)));
  if (orders.length === 0) return `No pickups for ${date}.`;
  const { computeOptimizedRoute } = await import("../lib/route-service");
  const route = await computeOptimizedRoute(orders);
  let msg = `🚚 ROUTE — ${date} — ${route.stops.length} stop${route.stops.length !== 1 ? "s" : ""}`;
  if (route.totalDistanceMiles > 0) msg += ` · ~${route.totalDistanceMiles} mi`;
  msg += `\nStart: ${DRIVER_START}\n`;
  route.stops.forEach((s, i) => {
    const oh = orders.filter((o) => s.orderIds.includes(o.id));
    msg += `\n${i + 1}. ${s.colony}${s.addressHint ? ` (${s.addressHint})` : ""}, ${s.town}\n`;
    oh.forEach((o) => {
      const gate = o.gateAccess ? ` · Gate ${o.gateAccess}` : "";
      msg += `   • Unit ${o.unitNumber} — ${o.name}${gate}\n     📞 ${o.phoneNumber}\n`;
    });
  });
  msg += `\nEnd: ${DRIVER_END}`;
  if (route.warnings.length > 0) msg += `\n\n⚠️ ${route.warnings.join("; ")}`;
  return msg;
}

// ─── New-order (admin-initiated) flow scratch ─────────────────────────────────
// Multi-step state stashed as JSON in conversationsTable.items.
interface NewOrderScratch {
  phone?: string;
  name?: string;
  town?: string;
  colony?: string;
  address?: string;
  unit?: string;
  gate?: string | null;
  items?: string;
}
function readScratch(s: string | null): NewOrderScratch {
  if (!s) return {};
  try { return JSON.parse(s) as NewOrderScratch; } catch { return {}; }
}
function writeScratch(o: NewOrderScratch): string { return JSON.stringify(o); }

async function actionRoute(): Promise<string> {
  const today = toDateOnly(new Date());
  const orders = await db
    .select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)));
  if (orders.length === 0) return "No pickups for today's route.";

  const { computeOptimizedRoute } = await import("../lib/route-service");
  const route = await computeOptimizedRoute(orders);

  let msg = `🚚 OPTIMIZED ROUTE — ${route.stops.length} stop${route.stops.length !== 1 ? "s" : ""}`;
  if (route.totalDistanceMiles > 0) {
    msg += ` · ~${route.totalDistanceMiles} mi`;
  }
  msg += `\nStart: ${DRIVER_START}\n`;

  route.stops.forEach((s, i) => {
    const ordersHere = orders.filter((o) => s.orderIds.includes(o.id));
    msg += `\n${i + 1}. ${s.colony}${s.addressHint ? ` (${s.addressHint})` : ""}, ${s.town}\n`;
    ordersHere.forEach((o) => {
      const gate = o.gateAccess ? ` · Gate ${o.gateAccess}` : "";
      msg += `   • Unit ${o.unitNumber} — ${o.name}${gate}\n`;
      msg += `     📞 ${o.phoneNumber}\n`;
    });
  });
  msg += `\nEnd: ${DRIVER_END}`;
  if (route.warnings.length > 0) {
    msg += `\n\n⚠️ ${route.warnings.join("; ")}`;
  }
  return msg;
}

async function actionStats(range: "today" | "week" | "all"): Promise<string> {
  let whereClause;
  let label = "ALL TIME";
  if (range === "today") {
    const today = toDateOnly(new Date());
    whereClause = eq(ordersTable.pickupDate, today);
    label = "TODAY";
  } else if (range === "week") {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);
    whereClause = gte(ordersTable.createdAt, weekAgo);
    label = "THIS WEEK";
  }

  const orders = whereClause
    ? await db.select().from(ordersTable).where(whereClause)
    : await db.select().from(ordersTable);

  if (orders.length === 0) return `No orders for ${label.toLowerCase()}.`;

  const totals: Record<string, number> = {};
  let totalItemCount = 0;
  const statusCounts: Record<string, number> = {};
  for (const o of orders) {
    statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
    const parsed = parseItemsText(o.items);
    for (const [name, qty] of Object.entries(parsed)) {
      totals[name] = (totals[name] ?? 0) + qty;
      totalItemCount += qty;
    }
  }

  const sortedItems = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const itemLines = sortedItems.map(([name, qty]) => `  ${qty}x ${name}`).join("\n");
  const statusLines = Object.entries(statusCounts).map(([s, c]) => `  ${s}: ${c}`).join("\n");

  return [
    `📊 STATS — ${label}`,
    ``,
    `Orders: ${orders.length}`,
    `Total items: ${totalItemCount}`,
    ``,
    `By status:`,
    statusLines,
    ``,
    `Items breakdown:`,
    itemLines || "  (no parseable items)",
  ].join("\n");
}

async function actionUpdateBrowse(): Promise<{ message: string; ids: string }> {
  const recent = await db.select().from(ordersTable)
    .where(sql`${ordersTable.status} <> 'delivered'`)
    .orderBy(desc(ordersTable.createdAt))
    .limit(10);
  if (recent.length === 0) {
    return {
      message: `✏️ UPDATE — no active orders.\n\nReply with a name, phone digits, or order # (DRY-…) to search older orders.\n\n0. Back to menu`,
      ids: "",
    };
  }
  const lines = recent.map((o, i) =>
    `${i + 1}. ${o.orderNumber} — ${o.name} (${o.status}${o.paid ? ", paid" : ""})`
  ).join("\n");
  return {
    message: `✏️ UPDATE — pick a recent order:\n\n${lines}\n\nOr reply with a name or order # (DRY-…) to search.\n\n0. Back to menu`,
    ids: recent.map((o) => o.id).join(","),
  };
}

async function actionLookup(id: number): Promise<string> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) return `No order found with ID ${id}.`;
  return formatOrder(order);
}

// Search by ID (exact), phone fragment (digits), or name (text). Returns matches newest-first.
async function searchOrders(rawQuery: string): Promise<OrderRow[]> {
  const q = rawQuery.trim();
  if (!q) return [];

  // Pure digits: try ID first if short, then phone fragment.
  if (/^\d+$/.test(q)) {
    if (q.length <= 5) {
      const byId = await db.select().from(ordersTable)
        .where(eq(ordersTable.id, parseInt(q, 10))).limit(1);
      if (byId.length) return byId;
    }
    const byDigits = await db.select().from(ordersTable)
      .where(sql`regexp_replace(${ordersTable.phoneNumber}, '\\D', '', 'g') LIKE ${'%' + q + '%'}`)
      .orderBy(desc(ordersTable.createdAt))
      .limit(20);
    return byDigits;
  }

  // Text: case-insensitive name / colony / order-number match.
  return await db.select().from(ordersTable)
    .where(or(
      ilike(ordersTable.name, `%${q}%`),
      ilike(ordersTable.colony, `%${q}%`),
      ilike(ordersTable.orderNumber, `%${q}%`),
    ))
    .orderBy(desc(ordersTable.createdAt))
    .limit(20);
}

function formatMatchList(matches: OrderRow[]): string {
  return matches.map((o, i) => {
    const paid = o.paid ? "paid" : "unpaid";
    return `${i + 1}. #${o.id} ${o.name} — ${o.colony}, ${o.town} (${o.status}, ${paid})`;
  }).join("\n");
}

// ─── Customer Notifications ───────────────────────────────────────────────────
// Returns a short suffix to append to the admin reply, indicating whether the
// customer was notified. Never throws — SMS failures must not block status changes.
async function notifyCustomer(order: OrderRow, message: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !fromNumber) {
    return `\n(⚠️ Customer NOT notified — TWILIO_PHONE_NUMBER not configured.)`;
  }
  try {
    const client = twilio(sid, token);
    await client.messages.create({
      to: order.phoneNumber,
      from: fromNumber,
      body: message,
    });
    return `\n📩 Customer notified.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `\n⚠️ Customer notify FAILED: ${msg}`;
  }
}

function customerStatusMessage(order: OrderRow, newStatus: string): string | null {
  const greeting = `Hi ${order.name.split(" ")[0] ?? order.name}!`;
  switch (newStatus) {
    case "picked_up":
      return `${greeting} ✅ We just picked up your order ${order.orderNumber} from ${order.colony}. It's on the way to the cleaners — we'll text you again when it's been delivered back to your unit.`;
    case "delivered":
      return `${greeting} 🧺 Your dry cleaning order ${order.orderNumber} has been delivered back to ${order.colony}, Unit ${order.unitNumber}. Thanks for choosing Dry Cleaning Service!${order.paid ? "" : " (Reminder: payment still due.)"}`;
    case "missed":
      return `${greeting} We weren't able to pick up your order ${order.orderNumber} today. Please text us to reschedule — sorry for the inconvenience!`;
    default:
      return null;
  }
}

async function actionApplyUpdate(id: number, choice: string): Promise<string> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) return `Order #${id} not found.`;

  let newStatus: "picked_up" | "delivered" | "missed" | null = null;
  let paidUpdate: boolean | null = null;
  let baseReply = "";

  switch (choice) {
    case "1":
      newStatus = "picked_up";
      baseReply = `✅ Order #${id} (${order.name}) — marked picked up.`;
      break;
    case "2":
      newStatus = "delivered";
      baseReply = `✅ Order #${id} (${order.name}) — marked delivered.`;
      break;
    case "3":
      newStatus = "missed";
      baseReply = `✅ Order #${id} (${order.name}) — marked missed.`;
      break;
    case "4":
      paidUpdate = true;
      baseReply = `✅ Order #${id} (${order.name}) — marked PAID.`;
      break;
    case "5":
      paidUpdate = false;
      baseReply = `✅ Order #${id} (${order.name}) — marked UNPAID.`;
      break;
    default:
      return "Invalid choice.";
  }

  if (newStatus) {
    await db.update(ordersTable).set({ status: newStatus }).where(eq(ordersTable.id, id));
    const updatedOrder = { ...order, status: newStatus };
    const msg = customerStatusMessage(updatedOrder, newStatus);
    if (msg) {
      const notifyResult = await notifyCustomer(updatedOrder, msg);
      return baseReply + notifyResult;
    }
    return baseReply;
  }

  if (paidUpdate !== null) {
    await db.update(ordersTable).set({ paid: paidUpdate }).where(eq(ordersTable.id, id));
    // Paid/unpaid is internal bookkeeping — no customer notification.
    return baseReply;
  }

  return baseReply;
}

// ─── Admin Menu Handler ────────────────────────────────────────────────────────
async function handleAdminCommand(from: string, text: string, raw: string): Promise<string> {
  // Universal "menu" / "back" / empty resets to main menu
  if (text === "menu" || text === "back" || text === "0" || text === "help" || text === "") {
    await setAdminStep(from, "admin_main");
    return ADMIN_MAIN_MENU;
  }

  // ── Inline sort/range commands — usable from any state ────────────────────
  const sortMatch = text.match(/^sort\s+(newest|oldest|pickup|name)$/);
  if (sortMatch) {
    const map: Record<string, SortKey> = {
      newest: "newest", oldest: "oldest", pickup: "pickup-asc", name: "name",
    };
    getPrefs(from).sort = map[sortMatch[1]!]!;
    await setAdminStep(from, "admin_main");
    return `✅ Sort set to ${sortMatch[1]}.\n\n${ADMIN_MAIN_MENU}`;
  }
  const rangeMatch = text.match(/^range\s+(today|week|all)$/);
  if (rangeMatch) {
    getPrefs(from).range = rangeMatch[1] as RangeKey;
    await setAdminStep(from, "admin_main");
    return `✅ Range set to ${rangeMatch[1]}.\n\n${ADMIN_MAIN_MENU}`;
  }

  // Load admin session (if any)
  const [session] = await db
    .select().from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  const step = session?.step;

  // ── Update browse: pick from recent list, or fall through to a search query
  if (step === "admin_update_browse") {
    const browseIds = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    // If reply is a small number that maps to the shown list, pick from list.
    if (/^\d+$/.test(text) && browseIds.length > 0) {
      const pick = parseInt(text, 10);
      if (pick >= 1 && pick <= browseIds.length) {
        const id = browseIds[pick - 1]!;
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
        if (!order) {
          await setAdminStep(from, "admin_main");
          return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
        }
        await setAdminStep(from, "admin_update_action", String(id));
        return adminUpdateMenu(order);
      }
    }
    // Otherwise treat as a search query.
    await setAdminStep(from, "admin_update_search");
    // Fall through into the search handler below by re-running it inline:
  }

  // ── Lookup flow: collecting search query ───────────────────────────────────
  if (step === "admin_lookup" || step === "admin_update_search" || step === "admin_update_browse") {
    const nextFlow = step === "admin_lookup" ? "lookup" : "update";
    const matches = await searchOrders(raw);
    if (matches.length === 0) {
      return `No orders matched "${raw}".\nTry a name, phone digits, or order ID — or reply 0 to go back.`;
    }
    if (matches.length === 1) {
      const o = matches[0]!;
      if (nextFlow === "lookup") {
        await setAdminStep(from, "admin_main");
        return `${formatOrder(o)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
      }
      await setAdminStep(from, "admin_update_action", String(o.id));
      return adminUpdateMenu(o);
    }
    const ids = matches.map((m) => m.id).join(",");
    const pickStep = nextFlow === "lookup" ? "admin_lookup_pick" : "admin_update_pick";
    await setAdminStep(from, pickStep, ids);
    return `Found ${matches.length} matches — reply with a number:\n\n${formatMatchList(matches)}\n\n0. Back to menu`;
  }

  // ── Lookup/Update picker: choosing from match list ─────────────────────────
  if (step === "admin_lookup_pick" || step === "admin_update_pick") {
    const nextFlow = step === "admin_lookup_pick" ? "lookup" : "update";
    const ids = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    if (!/^\d+$/.test(text)) return `Please reply with a number 1-${ids.length}, or "0" to go back.`;
    const pick = parseInt(text, 10);
    if (pick < 1 || pick > ids.length) {
      return `Please reply with a number 1-${ids.length}, or "0" to go back.`;
    }
    const id = ids[pick - 1]!;
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) {
      await setAdminStep(from, "admin_main");
      return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
    }
    if (nextFlow === "lookup") {
      await setAdminStep(from, "admin_main");
      return `${formatOrder(order)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    await setAdminStep(from, "admin_update_action", String(id));
    return adminUpdateMenu(order);
  }

  // ── Update flow: applying action ───────────────────────────────────────────
  if (step === "admin_update_action") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    // Field-edit options 6-11: load order and jump to the right step.
    const fieldEdit: Record<string, { step: string; prompt: (o: OrderRow) => string }> = {
      "6": {
        step: "admin_update_items",
        prompt: (o) =>
          `📦 Items for #${o.id} (${o.name}).\n\nList with quantities, comma-separated.\n` +
          `Text "clear" to remove, or "0" to cancel.` +
          (o.items ? `\n\nCurrent: ${o.items}` : ""),
      },
      "7": {
        step: "admin_edit_name",
        prompt: (o) => `📛 New name for #${o.id}?\n\nCurrent: ${o.name}\n\n"0" to cancel.`,
      },
      "8": {
        step: "admin_edit_phone",
        prompt: (o) =>
          `📞 New phone for #${o.id}? (e.g. +19293450940)\n\nCurrent: ${o.phoneNumber}\n\n"0" to cancel.`,
      },
      "9": {
        step: "admin_edit_addr_town",
        prompt: (o) =>
          `🏘️ New town for #${o.id}?\n\nCurrent: ${o.town}\n\n${townList()}\n\n"0" to cancel.`,
      },
      "10": {
        step: "admin_edit_pickup",
        prompt: (o) =>
          `📅 New pickup date for #${o.id}? (YYYY-MM-DD)\n\n` +
          `Current: ${o.pickupDate ?? "—"}\n\n` +
          `Text "clear" to remove date, or "0" to cancel.`,
      },
      "11": {
        step: "admin_edit_notes",
        prompt: (o) =>
          `📝 New driver notes for #${o.id}?\n\nCurrent: ${o.notes ?? "—"}\n\n` +
          `Text "clear" to remove, or "0" to cancel.`,
      },
    };
    if (fieldEdit[text]) {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        await setAdminStep(from, "admin_main");
        return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      }
      const { step: nextStep, prompt } = fieldEdit[text]!;
      await setAdminStep(from, nextStep, String(id));
      return prompt(order);
    }
    if (!["1", "2", "3", "4", "5"].includes(text)) {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      return `Please reply 1-11, or "0" to go back.\n\n${order ? adminUpdateMenu(order) : ""}`;
    }
    const result = await actionApplyUpdate(id, text);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Single-field edits ────────────────────────────────────────────────────
  const editFieldSteps = new Set([
    "admin_edit_name", "admin_edit_phone", "admin_edit_pickup", "admin_edit_notes",
    "admin_edit_addr_town", "admin_edit_addr_colony", "admin_edit_addr_unit", "admin_edit_addr_gate",
  ]);
  if (step && editFieldSteps.has(step)) {
    // Scratch is either a bare numeric id (single-field flows) or a JSON
    // payload `{id, town?, colony?, unit?}` (address subflow). Using JSON
    // instead of `id|town|colony|unit` so user-typed values that contain
    // delimiter characters can't corrupt later parsing.
    let id = NaN;
    let addr: { id: number; town?: string; colony?: string; unit?: string } = { id: NaN };
    const sc = session?.items ?? "";
    if (sc.startsWith("{")) {
      try {
        addr = JSON.parse(sc);
        id = Number(addr.id);
      } catch { /* fall through to lost-track */ }
    } else {
      id = parseInt(sc, 10);
    }
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }

    if (step === "admin_edit_name") {
      if (!raw.trim()) return `Name can't be empty. Try again, or "0" to cancel.`;
      await db.update(ordersTable).set({ name: raw.trim() }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — name set to "${raw.trim()}"\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    if (step === "admin_edit_phone") {
      const digits = raw.replace(/[^\d+]/g, "");
      if (!/^\+?\d{10,15}$/.test(digits)) {
        return `Please send a valid phone (e.g. +19293450940), or "0" to cancel.`;
      }
      const phone = digits.startsWith("+") ? digits : `+1${digits.replace(/^1/, "")}`;
      await db.update(ordersTable).set({ phoneNumber: phone }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — phone set to ${phone}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    if (step === "admin_edit_pickup") {
      const value = (text === "clear" || text === "none") ? null : raw.trim();
      if (value !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return `Date must be YYYY-MM-DD (e.g. 2026-06-03). Try again, or "0" to cancel.`;
        }
        const [y, m, d] = value.split("-").map(Number);
        const dt = new Date(Date.UTC(y!, m! - 1, d!));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
          return `Not a real calendar date. Try again, or "0" to cancel.`;
        }
      }
      await db.update(ordersTable).set({ pickupDate: value }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — pickup date ${value ? `set to ${value}` : "cleared"}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    if (step === "admin_edit_notes") {
      const value = (text === "clear" || text === "none") ? null : raw;
      await db.update(ordersTable).set({ notes: value }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — notes ${value ? "updated" : "cleared"}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    // Address: 4 sub-steps — town → colony → unit → gate. State carried as
    // JSON in `items`; bare-id scratch from option 9 is upgraded to JSON on
    // the town step.
    if (step === "admin_edit_addr_town") {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > TOWNS.length) {
        return `Reply 1-${TOWNS.length}, or "0" to cancel.\n\n${townList()}`;
      }
      const town = TOWNS[n - 1]!;
      await setAdminStep(from, "admin_edit_addr_colony", JSON.stringify({ id, town }));
      return `🏠 Colony / building / development name?\n\n"0" to cancel.`;
    }
    if (step === "admin_edit_addr_colony") {
      if (!raw.trim()) return `Colony can't be empty. Try again, or "0" to cancel.`;
      await setAdminStep(from, "admin_edit_addr_unit",
        JSON.stringify({ ...addr, colony: raw.trim() }));
      return `🚪 Unit number / apartment?\n\n"0" to cancel.`;
    }
    if (step === "admin_edit_addr_unit") {
      if (!raw.trim()) return `Unit can't be empty. Try again, or "0" to cancel.`;
      await setAdminStep(from, "admin_edit_addr_gate",
        JSON.stringify({ ...addr, unit: raw.trim() }));
      return `🔑 Gate code or access notes? (or "none" to skip)\n\n"0" to cancel.`;
    }
    if (step === "admin_edit_addr_gate") {
      const town = addr.town;
      const colony = addr.colony;
      const unit = addr.unit;
      if (!town || !colony || !unit) {
        await setAdminStep(from, "admin_main");
        return `Address edit lost its state — please start over.\n\n${ADMIN_MAIN_MENU}`;
      }
      const gate = (text === "none" || text === "clear" || !raw.trim()) ? null : raw.trim();
      await db.update(ordersTable)
        .set({ town, colony, unitNumber: unit, gateAccess: gate })
        .where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — address updated:\n  ${town} · ${colony} · Unit ${unit}` +
             (gate ? `\n  Gate: ${gate}` : "") +
             `\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
  }

  // ── Update flow: capturing items ───────────────────────────────────────────
  if (step === "admin_update_items") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    const value = text === "clear" || text === "none" ? null : raw;
    await db.update(ordersTable).set({ items: value }).where(eq(ordersTable.id, id));
    await setAdminStep(from, "admin_main");
    const summary = value ? `Items set to: ${value}` : `Items cleared.`;
    return `✅ Order #${id} — ${summary}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Stats submenu ──────────────────────────────────────────────────────────
  if (step === "admin_stats") {
    let range: "today" | "week" | "all" | null = null;
    if (text === "1") range = "today";
    else if (text === "2") range = "week";
    else if (text === "3") range = "all";
    else return `Please reply 1-3, or "0" to go back.\n\n${ADMIN_STATS_MENU}`;
    const result = await actionStats(range);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Missed pickups: batch-mark selection ──────────────────────────────────
  if (step === "admin_missed_pick") {
    const ids = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    let picks: number[] = [];
    if (text === "all") {
      picks = ids;
    } else {
      const nums = text.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      for (const n of nums) {
        if (n >= 1 && n <= ids.length) picks.push(ids[n - 1]!);
      }
    }
    if (picks.length === 0) {
      return `Reply with numbers (e.g. "1,3"), "all", or "0" to cancel.`;
    }
    const result = await actionMarkMissedBatch(picks);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Route day picker ──────────────────────────────────────────────────────
  if (step === "admin_route_pick_day") {
    const dates = (session?.items ?? "").split(",").filter(Boolean);
    if (!/^\d+$/.test(text)) return `Please reply 1-${dates.length}, or "0" to go back.`;
    const pick = parseInt(text, 10);
    if (pick < 1 || pick > dates.length) return `Please reply 1-${dates.length}, or "0" to go back.`;
    const date = dates[pick - 1]!;
    const result = await actionRouteForDate(date);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── New order flow (admin-initiated) ──────────────────────────────────────
  if (step?.startsWith("admin_new_")) {
    const scratch = readScratch(session?.items ?? null);

    if (step === "admin_new_phone") {
      const digits = raw.replace(/[^\d+]/g, "");
      if (!/^\+?\d{10,15}$/.test(digits)) {
        return `Please send a valid phone (e.g. +19293450940), or "0" to cancel.`;
      }
      scratch.phone = digits.startsWith("+") ? digits : `+1${digits.replace(/^1/, "")}`;
      await setAdminStep(from, "admin_new_name", writeScratch(scratch));
      return `📛 Customer name?`;
    }
    if (step === "admin_new_name") {
      scratch.name = raw;
      await setAdminStep(from, "admin_new_town", writeScratch(scratch));
      return `🏘️ Which town?\n\n${townList()}`;
    }
    if (step === "admin_new_town") {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > TOWNS.length) {
        return `Reply 1-${TOWNS.length}.\n\n${townList()}`;
      }
      scratch.town = TOWNS[n - 1]!;
      await setAdminStep(from, "admin_new_colony", writeScratch(scratch));
      return `🏢 Colony / neighborhood name?`;
    }
    if (step === "admin_new_colony") {
      scratch.colony = raw;
      await setAdminStep(from, "admin_new_location", writeScratch(scratch));
      return `📍 Address details — 3 lines:\n\n1. Street address\n2. Unit / house number\n3. Gate code (or skip)\n\nExample:\n458 Riverside Dr\nUnit 50\n1234#`;
    }
    if (step === "admin_new_location") {
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length < 2) return `Need at least 2 lines (street, unit). Try again or "0" to cancel.`;
      const [street, unit, gate] = lines;
      scratch.address = street!;
      scratch.unit = unit!;
      scratch.gate = !gate || /^(none|no|skip)$/i.test(gate) ? null : gate;
      await setAdminStep(from, "admin_new_items", writeScratch(scratch));
      return `📦 Items? (e.g. "2 suits, 3 shirts" — or "skip")`;
    }
    if (step === "admin_new_items") {
      scratch.items = /^(skip|none|no)$/i.test(text) ? undefined : raw;
      await setAdminStep(from, "admin_new_notes", writeScratch(scratch));
      return `📝 Any notes for the driver? (or "skip")`;
    }
    if (step === "admin_new_notes") {
      const notes = /^(skip|none|no)$/i.test(text) ? null : raw;
      const pickup = nextPickupDate(scratch.town!);
      if (!pickup) {
        await setAdminStep(from, "admin_main");
        return `❌ No service schedule for ${scratch.town}.\n\n${ADMIN_MAIN_MENU}`;
      }
      const orderNumber = await nextOrderNumber();
      await db.insert(ordersTable).values({
        orderNumber,
        phoneNumber: scratch.phone!,
        name: scratch.name!,
        town: scratch.town!,
        colony: scratch.colony!,
        colonyAddress: scratch.address ?? null,
        unitNumber: scratch.unit!,
        gateAccess: scratch.gate ?? null,
        items: scratch.items ?? null,
        notes,
        pickupDate: toDateOnly(pickup),
        status: "pending",
      });
      await setAdminStep(from, "admin_main");
      return [
        `✅ Order ${orderNumber} created for ${scratch.name}.`,
        `📍 ${scratch.colony}, Unit ${scratch.unit} · ${scratch.town}`,
        `📅 Pickup: ${formatLongDate(pickup)}`,
        `📞 ${scratch.phone}`,
        ``,
        `———`,
        ``,
        ADMIN_MAIN_MENU,
      ].join("\n");
    }
  }

  // ── Main menu (default) ────────────────────────────────────────────────────
  const prefs = getPrefs(from);
  switch (text) {
    case "1": {
      await setAdminStep(from, "admin_main");
      return `${await actionTodayPickups(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "2": {
      await setAdminStep(from, "admin_main");
      return `${await actionTodayReturns(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "3": {
      await setAdminStep(from, "admin_main");
      return `${await actionPending(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "4": {
      await setAdminStep(from, "admin_main");
      return `${await actionUnpaid(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "5": {
      const { message, ids } = await actionMissed();
      await setAdminStep(from, ids ? "admin_missed_pick" : "admin_main", ids);
      return message;
    }
    case "6": {
      const { message, dates } = buildRouteDayMenu();
      await setAdminStep(from, "admin_route_pick_day", dates.join(","));
      return message;
    }
    case "7": {
      await setAdminStep(from, "admin_stats");
      return ADMIN_STATS_MENU;
    }
    case "8": {
      await setAdminStep(from, "admin_lookup");
      return `🔍 Search for an order — reply with any of:\n  • Customer name (e.g. "Sarah")\n  • Phone digits (e.g. "9293450")\n  • Order ID (e.g. "5")\n  • Order # (e.g. "DRY-12345")\n\n0. Back to menu`;
    }
    case "9": {
      const { message, ids } = await actionUpdateBrowse();
      await setAdminStep(from, "admin_update_browse", ids);
      return message;
    }
    case "10": {
      await setAdminStep(from, "admin_new_phone", writeScratch({}));
      return `📱 NEW ORDER — what's the customer's phone? (e.g. +19293450940)\n\n0. Cancel`;
    }
    default:
      await setAdminStep(from, "admin_main");
      return `I didn't recognize that. Pick a number:\n\n${ADMIN_MAIN_MENU}`;
  }
}


// ─── Confirmation SMS ─────────────────────────────────────────────────────────
function buildConfirmationSms(order: {
  orderNumber: string;
  town: string;
  colony: string;
  colonyAddress: string | null;
  unitNumber: string;
  notes: string | null;
  pickupDate: Date;
}): string {
  const dropoff = nextDropoffDate(order.pickupDate);
  const addr = order.colonyAddress ? `${order.colonyAddress}, ` : "";
  const notesBlock = order.notes ? [``, `📝 Notes: ${order.notes}`] : [];

  return [
    `✅ Order Confirmed — ${order.orderNumber}`,
    ``,
    `📍 ${addr}${order.colony}, Unit ${order.unitNumber}`,
    `   ${order.town}`,
    ...notesBlock,
    ``,
    `📅 Pickup: ${formatLongDate(order.pickupDate)}`,
    `📅 Drop-off by: ${formatLongDate(dropoff)}`,
    ``,
    `⏰ Order cutoff: 12:00 AM the night before your pickup day.`,
    ``,
    `📋 Please have your items bagged and ready by 10:00 AM on pickup day. Unprepared orders cannot be picked up. Thank you! 🙏`,
  ].join("\n");
}

// ─── Twilio signature validation ──────────────────────────────────────────────
// Validates `X-Twilio-Signature` so that only requests genuinely signed with
// our TWILIO_AUTH_TOKEN can hit the webhook. Without this, anyone who knows
// the URL + admin phone number could spoof admin SMS commands.
//
// In production we hard-fail on missing token or invalid signature.
// In dev (no TWILIO_AUTH_TOKEN configured) we log a warning and allow the
// request so curl-based testing still works.
const verifyTwilioSignature: RequestHandler = (req, res, next) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      req.log.error("TWILIO_AUTH_TOKEN not set in production — rejecting webhook");
      res.status(500).send("Webhook validation not configured");
      return;
    }
    req.log.warn("TWILIO_AUTH_TOKEN not set — skipping Twilio signature check (dev only)");
    next();
    return;
  }

  const signature = req.header("X-Twilio-Signature") ?? "";
  if (!signature) {
    req.log.warn({ ip: req.ip }, "Missing X-Twilio-Signature header — rejecting");
    res.status(403).send("Forbidden");
    return;
  }

  // Twilio signs the absolute URL it POSTed to (including query string) plus
  // the form-encoded parameters. Behind our reverse proxy, req.protocol/host
  // can be wrong, so we reconstruct from the configured PUBLIC_URL.
  const url = `${PUBLIC_URL.replace(/\/$/, "")}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;

  const valid = twilio.validateRequest(token, signature, url, params);
  if (!valid) {
    req.log.warn({ url, ip: req.ip }, "Invalid Twilio signature — rejecting");
    res.status(403).send("Forbidden");
    return;
  }
  next();
};

// ─── Webhook ──────────────────────────────────────────────────────────────────
router.post("/webhook/twilio", verifyTwilioSignature, async (req, res) => {
  const body = req.body as { Body?: string; From?: string };
  const from = (body.From ?? "").trim();
  const raw = (body.Body ?? "").trim();
  const text = raw.toLowerCase().trim();

  res.setHeader("Content-Type", "text/xml");

  if (!from) {
    res.send(twimlResponse("Unable to process your request."));
    return;
  }

  // ── Admin branch ─────────────────────────────────────────────────────────
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;
  if (adminPhone && from === adminPhone) {
    const reply = await handleAdminCommand(from, text, raw);
    res.send(twimlResponse(reply));
    return;
  }

  // ── Start fresh ───────────────────────────────────────────────────────────
  if (text === "clean") {
    // Returning customer? Look up the most recent order for this phone.
    const [lastOrder] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.phoneNumber, from))
      .orderBy(desc(ordersTable.id))
      .limit(1);

    if (lastOrder) {
      await db
        .insert(conversationsTable)
        .values({
          phoneNumber: from,
          step: "returning_confirm",
          name: lastOrder.name,
          town: lastOrder.town,
          colony: lastOrder.colony,
          colonyAddress: lastOrder.colonyAddress,
          unitNumber: lastOrder.unitNumber,
          gateAccess: lastOrder.gateAccess,
        })
        .onConflictDoUpdate({
          target: conversationsTable.phoneNumber,
          set: {
            step: "returning_confirm",
            name: lastOrder.name,
            town: lastOrder.town,
            colony: lastOrder.colony,
            colonyAddress: lastOrder.colonyAddress,
            unitNumber: lastOrder.unitNumber,
            gateAccess: lastOrder.gateAccess,
            items: null,
            updatedAt: new Date(),
          },
        });
      const firstName = lastOrder.name.split(" ")[0] ?? lastOrder.name;
      const gateLine = lastOrder.gateAccess ? `Gate: ${lastOrder.gateAccess}` : "No gate";
      res.send(twimlResponse(
        `Welcome back, ${firstName}! 👋\n\n` +
        `${welcomeIntro()}\n\n` +
        `Use your saved address?\n\n` +
        `${lastOrder.colonyAddress ?? ""}\n` +
        `${lastOrder.colony}, Unit ${lastOrder.unitNumber}\n` +
        `${lastOrder.town}\n` +
        `${gateLine}\n\n` +
        `Reply YES to use it, or NO to enter a new address.`
      ));
      return;
    }

    await db
      .insert(conversationsTable)
      .values({ phoneNumber: from, step: "name" })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: {
          step: "name",
          name: null, town: null, colony: null, colonyAddress: null,
          unitNumber: null, gateAccess: null, items: null,
          updatedAt: new Date(),
        },
      });
    res.send(twimlResponse(
      `Welcome to Dry Cleaning Service! 👔\n\n` +
      `${welcomeIntro()}\n\n` +
      `What is your full name?`
    ));
    return;
  }

  // ── Load conversation ─────────────────────────────────────────────────────
  const [convo] = await db
    .select().from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  // ── Reschedule flow: pick a new pickup day for a missed order ────────────
  // Triggered when a customer with a missed order texts back. We don't intercept
  // if they're already mid-order-flow (returning_confirm/name/town/etc.).
  const orderFlowSteps = new Set([
    "returning_confirm", "name", "town", "colony", "location_details", "notes",
  ]);
  if (!convo || !orderFlowSteps.has(convo.step ?? "")) {
    if (convo?.step === "reschedule_offer") {
      if (text === "yes" || text === "y" || text === "reschedule") {
        // Bind to the SPECIFIC order id captured when we sent the offer, not
        // "latest missed" — otherwise a newer missed order would silently
        // hijack the reschedule.
        const offeredId = parseInt(convo.items ?? "", 10);
        const [missed] = isNaN(offeredId)
          ? [undefined]
          : await db.select().from(ordersTable)
              .where(and(
                eq(ordersTable.id, offeredId),
                eq(ordersTable.phoneNumber, from),
                eq(ordersTable.status, "missed"),
              )).limit(1);
        if (!missed) {
          await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
          res.send(twimlResponse(`Sorry, that order is no longer eligible to reschedule. Text "clean" to start a new one.`));
          return;
        }
        const choices: { date: Date; label: string }[] = [];
        let cursor = new Date();
        for (let i = 0; i < 3; i++) {
          const next = nextPickupDate(missed.town, cursor);
          if (!next) break;
          choices.push({ date: next, label: formatLongDate(next) });
          cursor = new Date(next); cursor.setDate(cursor.getDate() + 1);
        }
        if (choices.length === 0) {
          res.send(twimlResponse(`Sorry, we don't have a pickup schedule for ${missed.town}. Please call (845) 606-0022.`));
          return;
        }
        const lines = choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
        const dates = choices.map((c) => toDateOnly(c.date)).join(",");
        await db.update(conversationsTable)
          .set({ step: "reschedule_pick", items: `${missed.id}|${dates}`, updatedAt: new Date() })
          .where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`Great! Pick a new pickup day for order ${missed.orderNumber}:\n\n${lines}\n\nReply with a number, or "cancel" to skip.`));
        return;
      }
      if (text === "no" || text === "n" || text === "cancel") {
        await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`No problem. Text "clean" anytime to place a new order.`));
        return;
      }
      res.send(twimlResponse(`Reply YES to pick a new pickup day, or NO to skip.`));
      return;
    }
    if (convo?.step === "reschedule_pick") {
      if (text === "cancel" || text === "no") {
        await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`Cancelled. Text "clean" anytime to place a new order.`));
        return;
      }
      const [idStr, dateCsv] = (convo.items ?? "").split("|");
      const orderId = parseInt(idStr ?? "", 10);
      const dates = (dateCsv ?? "").split(",").filter(Boolean);
      const pick = parseInt(text, 10);
      if (isNaN(pick) || pick < 1 || pick > dates.length) {
        res.send(twimlResponse(`Please reply with a number 1-${dates.length}, or "cancel".`));
        return;
      }
      const newDate = dates[pick - 1]!;
      // Conditional update: only flip if the order is still missed and still
      // owned by this phone — guards against a stale conversation reviving an
      // order that was already handled in the dashboard.
      const updated = await db.update(ordersTable)
        .set({ status: "pending", pickupDate: newDate })
        .where(and(
          eq(ordersTable.id, orderId),
          eq(ordersTable.phoneNumber, from),
          eq(ordersTable.status, "missed"),
        ))
        .returning();
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      if (updated.length === 0) {
        res.send(twimlResponse(`Sorry, that order can no longer be rescheduled (it may have been updated). Text "clean" to start a new order.`));
        return;
      }
      res.send(twimlResponse(`✅ Rescheduled! Your new pickup is ${formatLongDate(new Date(newDate + "T00:00:00"))}. Please have your bag out by 10:00 AM. Thanks!`));
      return;
    }

    // Not already in a reschedule conversation — offer one if a missed order exists.
    if (text !== "clean") {
      const [missed] = await db.select().from(ordersTable)
        .where(and(eq(ordersTable.phoneNumber, from), eq(ordersTable.status, "missed")))
        .orderBy(desc(ordersTable.id)).limit(1);
      if (missed) {
        // Persist the offered order id in items so the YES branch binds to
        // the same order, not whatever "latest missed" happens to be then.
        await db.insert(conversationsTable)
          .values({ phoneNumber: from, step: "reschedule_offer", items: String(missed.id) })
          .onConflictDoUpdate({
            target: conversationsTable.phoneNumber,
            set: { step: "reschedule_offer", items: String(missed.id), updatedAt: new Date() },
          });
        res.send(twimlResponse(
          `Hi! We missed picking up your order ${missed.orderNumber}. ` +
          `Would you like to reschedule it for the next pickup day?\n\n` +
          `Reply YES to pick a new day, or text "clean" to start a brand-new order.`
        ));
        return;
      }
    }
  }

  if (!convo) {
    res.send(twimlResponse('Text "clean" to start a dry cleaning pickup request.'));
    return;
  }

  const step = convo.step;

  if (step === "returning_confirm") {
    if (text === "yes" || text === "y") {
      await db.update(conversationsTable)
        .set({ step: "notes", updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(askForNotesMessage()));
      return;
    }
    if (text === "no" || text === "n") {
      await db.update(conversationsTable)
        .set({
          step: "name",
          name: null, town: null, colony: null, colonyAddress: null,
          unitNumber: null, gateAccess: null, items: null,
          updatedAt: new Date(),
        })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse("No problem! What is your full name?"));
      return;
    }
    res.send(twimlResponse("Please reply YES to use your saved address or NO to enter a new one."));
    return;
  }

  if (step === "name") {
    await db.update(conversationsTable)
      .set({ name: raw, step: "town", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(`Thanks, ${raw}! Which town are you in?\n\nReply with the number:\n\n${townList()}`));
    return;
  }

  if (step === "town") {
    const num = parseInt(text);
    if (isNaN(num) || num < 1 || num > TOWNS.length) {
      res.send(twimlResponse(`Please reply with a number between 1 and ${TOWNS.length}.\n\n${townList()}`));
      return;
    }
    const selectedTown = TOWNS[num - 1]!;
    await db.update(conversationsTable)
      .set({ town: selectedTown, step: "colony", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(`${selectedTown} — got it!\n\nWhat is the name of your colony or neighborhood?`));
    return;
  }

  if (step === "colony") {
    await db.update(conversationsTable)
      .set({ colony: raw, step: "location_details", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      `Got it! Please reply with the following on separate lines:\n\n` +
      `1. Street address\n` +
      `2. Unit or house number\n` +
      `3. Gate code (optional — leave out if no gate)\n\n` +
      `Example:\n458 Riverside Dr\nUnit 50\n1234#`
    ));
    return;
  }

  if (step === "location_details") {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) {
      res.send(twimlResponse(
        `Please send at least 2 lines:\n\n` +
        `1. Street address\n` +
        `2. Unit or house number\n` +
        `3. Gate code (optional — leave out if no gate)\n\n` +
        `Example:\n458 Riverside Dr\nUnit 50\n1234#`
      ));
      return;
    }
    const [streetAddress, unitNumber, gateRaw] = lines;
    const gateAccess = !gateRaw || gateRaw.toLowerCase() === "none" || gateRaw.toLowerCase() === "no"
      ? null
      : gateRaw;
    await db.update(conversationsTable)
      .set({
        colonyAddress: streetAddress!,
        unitNumber: unitNumber!,
        gateAccess,
        step: "notes",
        updatedAt: new Date(),
      })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(askForNotesMessage()));
    return;
  }

  if (step === "notes") {
    const notes = text === "skip" || text === "none" || text === "no" ? null : raw;
    const pickupDate = nextPickupDate(convo.town!);
    if (!pickupDate) {
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(`Sorry, we don't service ${convo.town} yet. Please text "clean" to start over.`));
      return;
    }

    const orderNumber = await nextOrderNumber();
    await db.insert(ordersTable).values({
      orderNumber,
      phoneNumber: from,
      name: convo.name!,
      town: convo.town!,
      colony: convo.colony!,
      colonyAddress: convo.colonyAddress ?? null,
      unitNumber: convo.unitNumber!,
      gateAccess: convo.gateAccess,
      notes,
      pickupDate: toDateOnly(pickupDate),
      status: "pending",
    });

    await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));

    res.send(twimlResponse(buildConfirmationSms({
      orderNumber,
      town: convo.town!,
      colony: convo.colony!,
      colonyAddress: convo.colonyAddress ?? null,
      unitNumber: convo.unitNumber!,
      notes,
      pickupDate,
    })));
    return;
  }

  res.send(twimlResponse('Text "clean" to start a new pickup request.'));
});

// ─── Fallback Webhook ─────────────────────────────────────────────────────────
// Twilio calls this if the primary webhook above fails (timeout, 5xx, etc.).
// Returns a graceful message so the customer isn't left hanging.
router.post("/webhook/twilio-fallback", verifyTwilioSignature, (req, res) => {
  res.setHeader("Content-Type", "text/xml");
  res.send(
    twimlResponse(
      "Sorry, Dry Cleaning Service is having a temporary technical issue. " +
      "Please try texting again in a few minutes, or call/text (845) 606-0022 directly. Thank you for your patience!"
    )
  );
});

export default router;
