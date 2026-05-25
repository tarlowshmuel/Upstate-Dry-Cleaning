import { Router } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable } from "@workspace/db/schema";
import { eq, and, gte, desc, ilike, or, sql } from "drizzle-orm";

const router = Router();

// ─── Towns + Schedule ─────────────────────────────────────────────────────────
const TOWN_SCHEDULE: Record<string, { pickup: string; dropoff: string }> = {
  "Monticello":       { pickup: "Monday",  dropoff: "Wednesday" },
  "South Fallsburg":  { pickup: "Monday",  dropoff: "Wednesday" },
  "Woodridge":        { pickup: "Monday",  dropoff: "Wednesday" },
  "Glen Wild":        { pickup: "Monday",  dropoff: "Wednesday" },
  "Fallsburg":        { pickup: "Monday",  dropoff: "Wednesday" },
  "Hurleyville":      { pickup: "Monday",  dropoff: "Wednesday" },
  "Woodbourne":       { pickup: "Tuesday", dropoff: "Thursday"  },
  "Loch Sheldrake":   { pickup: "Tuesday", dropoff: "Thursday"  },
  "Liberty":          { pickup: "Tuesday", dropoff: "Thursday"  },
  "Kiamesha Lake":    { pickup: "Tuesday", dropoff: "Thursday"  },
  "Ferndale":         { pickup: "Tuesday", dropoff: "Thursday"  },
  "Parksville":       { pickup: "Tuesday", dropoff: "Thursday"  },
  "Livingston Manor": { pickup: "Tuesday", dropoff: "Thursday"  },
  "Dairyland":        { pickup: "Tuesday", dropoff: "Thursday"  },
};

const TOWNS = Object.keys(TOWN_SCHEDULE);

// Driving order from Fallsburg through Sullivan County and back.
// Monday set: Fallsburg → South Fallsburg → Hurleyville → Woodridge → Glen Wild → Monticello.
// Tuesday set: Woodbourne → Loch Sheldrake → Kiamesha Lake → Liberty → Ferndale → Parksville → Livingston Manor → Dairyland.
const TOWN_ROUTE_ORDER: string[] = [
  "Fallsburg",
  "South Fallsburg",
  "Woodbourne",
  "Loch Sheldrake",
  "Hurleyville",
  "Woodridge",
  "Glen Wild",
  "Kiamesha Lake",
  "Monticello",
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

function generateOrderNumber(): string {
  const num = Math.floor(10000 + Math.random() * 90000);
  return `DRY-${num}`;
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
  const ticketsLine = `\n🎫 Tickets: ${o.cleanerTickets ?? "(not set)"}`;
  const pickup = o.pickupDate ? `Pickup: ${o.pickupDate}\n` : "";
  const paid = o.paid ? "PAID ✓" : "UNPAID";
  return `#${o.id} | ${o.orderNumber}\n${o.name} | ${o.phoneNumber}\n${addr}${o.colony}, ${o.town}\nUnit: ${o.unitNumber} | ${gate}${itemsLine}${ticketsLine}${notesLine}\n${pickup}Status: ${o.status} | ${paid}`;
}

// ─── Admin Menu System ─────────────────────────────────────────────────────────
const ADMIN_MAIN_MENU = [
  "🧺 ADMIN MENU",
  "",
  "1. Today's pickups",
  "2. Orders at cleaners",
  "3. Pending orders",
  "4. Unpaid orders",
  "5. Today's route (driving order)",
  "6. Stats",
  "7. Look up an order",
  "8. Update an order",
  "",
  'Reply with a number (or "menu" anytime).',
].join("\n");

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
    `1. Mark picked up`,
    `2. Mark delivered`,
    `3. Mark missed`,
    `4. Mark paid`,
    `5. Mark unpaid`,
    `6. Set cleaner ticket #s`,
    `7. Set items`,
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
async function actionTodayPickups(): Promise<string> {
  const today = toDateOnly(new Date());
  const orders = await db
    .select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)))
    .orderBy(ordersTable.town);
  if (orders.length === 0) return "No pickups scheduled for today.";
  return `TODAY'S PICKUPS (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
}

async function actionTodayReturns(): Promise<string> {
  const orders = await db
    .select().from(ordersTable)
    .where(eq(ordersTable.status, "picked_up"))
    .orderBy(ordersTable.town);
  if (orders.length === 0) return "No returns scheduled.";
  return `RETURNS (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
}

async function actionPending(): Promise<string> {
  const orders = await db
    .select().from(ordersTable)
    .where(eq(ordersTable.status, "pending"))
    .orderBy(desc(ordersTable.createdAt));
  if (orders.length === 0) return "No pending orders.";
  return `PENDING (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
}

async function actionUnpaid(): Promise<string> {
  const orders = await db
    .select().from(ordersTable)
    .where(eq(ordersTable.paid, false))
    .orderBy(desc(ordersTable.createdAt));
  if (orders.length === 0) return "All orders are paid. 🎉";
  return `UNPAID (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
}

async function actionRoute(): Promise<string> {
  const today = toDateOnly(new Date());
  const orders = await db
    .select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)));
  if (orders.length === 0) return "No pickups for today's route.";

  // Sort by driving order: town route index, then colony (keeps same-complex stops together), then address.
  const sorted = [...orders].sort((a, b) => {
    const ta = townRouteIndex(a.town);
    const tb = townRouteIndex(b.town);
    if (ta !== tb) return ta - tb;
    const ca = (a.colony ?? "").localeCompare(b.colony ?? "");
    if (ca !== 0) return ca;
    return (a.colonyAddress ?? "").localeCompare(b.colonyAddress ?? "");
  });

  let msg = `🚚 ROUTE — ${sorted.length} stop${sorted.length !== 1 ? "s" : ""}\n`;
  msg += `Start: ${DRIVER_START}\n`;
  let currentTown = "";
  sorted.forEach((o, i) => {
    if (o.town !== currentTown) {
      currentTown = o.town;
      msg += `\n— ${currentTown.toUpperCase()} —\n`;
    }
    const addr = o.colonyAddress ?? "";
    const gate = o.gateAccess ? `   Gate: ${o.gateAccess}\n` : "";
    msg += `\n${i + 1}. ${o.name}\n`;
    if (addr) msg += `   ${addr}\n`;
    msg += `   ${o.colony}, Unit ${o.unitNumber}\n`;
    msg += `   ${o.town}, NY\n`;
    msg += gate;
    msg += `   📞 ${o.phoneNumber}\n`;
  });
  msg += `\nEnd: ${DRIVER_END}`;
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
    // Match phone fragment OR cleaner-ticket fragment.
    const byDigits = await db.select().from(ordersTable)
      .where(or(
        sql`regexp_replace(${ordersTable.phoneNumber}, '\\D', '', 'g') LIKE ${'%' + q + '%'}`,
        ilike(ordersTable.cleanerTickets, `%${q}%`),
      ))
      .orderBy(desc(ordersTable.createdAt))
      .limit(20);
    return byDigits;
  }

  // Text: case-insensitive name OR colony match.
  return await db.select().from(ordersTable)
    .where(or(
      ilike(ordersTable.name, `%${q}%`),
      ilike(ordersTable.colony, `%${q}%`),
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
      return `${greeting} 🧺 Your dry cleaning order ${order.orderNumber} has been delivered back to ${order.colony}, Unit ${order.unitNumber}. Thanks for choosing Upstate Dry Cleaning!${order.paid ? "" : " (Reminder: payment still due.)"}`;
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

  // Load admin session (if any)
  const [session] = await db
    .select().from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  const step = session?.step;

  // ── Lookup flow: collecting search query ───────────────────────────────────
  if (step === "admin_lookup" || step === "admin_update_search") {
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
    if (text === "6") {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        await setAdminStep(from, "admin_main");
        return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      }
      await setAdminStep(from, "admin_update_tickets", String(id));
      const current = order.cleanerTickets ? `\n\nCurrent: ${order.cleanerTickets}` : "";
      return `🎫 Enter cleaner ticket #s for order #${id} (${order.name}).\n\n` +
             `One per item, comma-separated.\nExample: 4123, 4124, 4125\n\n` +
             `Text "clear" to remove, or "0" to cancel.${current}`;
    }
    if (text === "7") {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        await setAdminStep(from, "admin_main");
        return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      }
      await setAdminStep(from, "admin_update_items", String(id));
      const current = order.items ? `\n\nCurrent: ${order.items}` : "";
      return `📦 Enter items for order #${id} (${order.name}).\n\n` +
             `List with quantities, comma-separated.\nExample: 2 suits, 3 dress shirts, 1 coat\n\n` +
             `Text "clear" to remove, or "0" to cancel.${current}`;
    }
    if (!["1", "2", "3", "4", "5"].includes(text)) {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      return `Please reply 1-7, or "0" to go back.\n\n${order ? adminUpdateMenu(order) : ""}`;
    }
    const result = await actionApplyUpdate(id, text);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Update flow: capturing cleaner ticket numbers ──────────────────────────
  if (step === "admin_update_tickets") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    const value = text === "clear" || text === "none" ? null : raw;
    await db.update(ordersTable).set({ cleanerTickets: value }).where(eq(ordersTable.id, id));
    await setAdminStep(from, "admin_main");
    const summary = value ? `Tickets set to: ${value}` : `Tickets cleared.`;
    return `✅ Order #${id} — ${summary}\n\n———\n\n${ADMIN_MAIN_MENU}`;
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

  // ── Main menu (default) ────────────────────────────────────────────────────
  // If no session or at main menu, treat input as menu choice
  switch (text) {
    case "1": {
      await setAdminStep(from, "admin_main");
      return `${await actionTodayPickups()}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "2": {
      await setAdminStep(from, "admin_main");
      return `${await actionTodayReturns()}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "3": {
      await setAdminStep(from, "admin_main");
      return `${await actionPending()}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "4": {
      await setAdminStep(from, "admin_main");
      return `${await actionUnpaid()}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "5": {
      await setAdminStep(from, "admin_main");
      return `${await actionRoute()}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "6": {
      await setAdminStep(from, "admin_stats");
      return ADMIN_STATS_MENU;
    }
    case "7": {
      await setAdminStep(from, "admin_lookup");
      return `🔍 Search for an order — reply with any of:\n  • Customer name (e.g. "Sarah")\n  • Phone digits (e.g. "9293450")\n  • Order ID (e.g. "5")\n  • Cleaner ticket # (e.g. "4123")\n\n0. Back to menu`;
    }
    case "8": {
      await setAdminStep(from, "admin_update_search");
      return `✏️ Find the order to update — reply with any of:\n  • Customer name\n  • Phone digits\n  • Order ID\n\n0. Back to menu`;
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

// ─── Webhook ──────────────────────────────────────────────────────────────────
router.post("/webhook/twilio", async (req, res) => {
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
      `Welcome to Upstate Dry Cleaning! 👔\n\n` +
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

    const orderNumber = generateOrderNumber();
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
router.post("/webhook/twilio-fallback", (req, res) => {
  res.setHeader("Content-Type", "text/xml");
  res.send(
    twimlResponse(
      "Sorry, Upstate Dry Cleaning is having a temporary technical issue. " +
      "Please try texting again in a few minutes, or call/text (845) 606-0022 directly. Thank you for your patience!"
    )
  );
});

export default router;
