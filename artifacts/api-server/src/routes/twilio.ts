import { Router } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable } from "@workspace/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";

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

const DAY_NUM: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

const DRIVER_START = process.env.DRIVER_START_ADDRESS ?? "458 Riverside Drive, Sullivan County, NY";
const DRIVER_END = process.env.DRY_CLEANERS_ADDRESS ?? DRIVER_START;

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
  const itemsStr = o.items ?? "(none)";
  const pickup = o.pickupDate ? `Pickup: ${o.pickupDate}\n` : "";
  return `#${o.id} | ${o.orderNumber}\n${o.name} | ${o.phoneNumber}\n${addr}${o.colony}, ${o.town}\nUnit: ${o.unitNumber} | ${gate}\nItems: ${itemsStr}\n${pickup}Status: ${o.status}`;
}

// ─── Admin Commands ────────────────────────────────────────────────────────────
async function handleAdminCommand(text: string): Promise<string> {
  if (text === "help") {
    return [
      "COMMANDS:",
      "today pickups",
      "today returns",
      "pending",
      "route",
      "stats",
      "stats today",
      "stats week",
      "customer [id]",
      "mark completed [id]",
      "mark paid [id]",
      "missed [id]",
    ].join("\n");
  }

  // today pickups — orders scheduled for today's pickup
  if (text === "today pickups") {
    const today = toDateOnly(new Date());
    const orders = await db
      .select().from(ordersTable)
      .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)))
      .orderBy(ordersTable.town);
    if (orders.length === 0) return "No pickups scheduled for today.";
    return `TODAY'S PICKUPS (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
  }

  if (text === "today returns") {
    const orders = await db
      .select().from(ordersTable)
      .where(eq(ordersTable.status, "picked_up"))
      .orderBy(ordersTable.town);
    if (orders.length === 0) return "No returns scheduled.";
    return `RETURNS (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
  }

  if (text === "pending") {
    const orders = await db
      .select().from(ordersTable)
      .where(eq(ordersTable.status, "pending"))
      .orderBy(desc(ordersTable.createdAt));
    if (orders.length === 0) return "No pending orders.";
    return `PENDING (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
  }

  // route — today's pickups grouped by town + Google Maps URL
  if (text === "route") {
    const today = toDateOnly(new Date());
    const orders = await db
      .select().from(ordersTable)
      .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)))
      .orderBy(ordersTable.town);
    if (orders.length === 0) return "No pickups for today's route.";

    const byTown = new Map<string, OrderRow[]>();
    for (const o of orders) {
      if (!byTown.has(o.town)) byTown.set(o.town, []);
      byTown.get(o.town)!.push(o);
    }

    let msg = `ROUTE — ${orders.length} stop${orders.length !== 1 ? "s" : ""}:\n`;
    for (const [town, townOrders] of byTown) {
      msg += `\n${town.toUpperCase()} (${townOrders.length}):\n`;
      for (const o of townOrders) {
        const gate = o.gateAccess ? ` [Gate: ${o.gateAccess}]` : "";
        const addr = o.colonyAddress ? `${o.colonyAddress}, ` : "";
        msg += `  #${o.id} ${o.name} — ${addr}${o.colony}, Unit ${o.unitNumber}${gate}\n`;
      }
    }
    msg += `\n📍 Open in Google Maps:\n${buildRouteUrl(orders)}`;
    return msg.trim();
  }

  // stats — item totals
  const statsMatch = text.match(/^stats(?: (today|week|all))?$/);
  if (statsMatch) {
    const range = statsMatch[1] ?? "all";
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

    // Aggregate items
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

  const customerMatch = text.match(/^customer (\d+)$/);
  if (customerMatch) {
    const id = parseInt(customerMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `No order found with ID ${id}.`;
    return formatOrder(order);
  }

  const completedMatch = text.match(/^mark completed (\d+)$/);
  if (completedMatch) {
    const id = parseInt(completedMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `Order #${id} not found.`;
    await db.update(ordersTable).set({ status: "picked_up" }).where(eq(ordersTable.id, id));
    return `Order #${id} (${order.name}) — marked picked up.`;
  }

  const paidMatch = text.match(/^mark paid (\d+)$/);
  if (paidMatch) {
    const id = parseInt(paidMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `Order #${id} not found.`;
    await db.update(ordersTable).set({ status: "paid" }).where(eq(ordersTable.id, id));
    return `Order #${id} (${order.name}) — marked paid.`;
  }

  const missedMatch = text.match(/^missed (\d+)$/);
  if (missedMatch) {
    const id = parseInt(missedMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `Order #${id} not found.`;
    await db.update(ordersTable).set({ status: "missed" }).where(eq(ordersTable.id, id));
    return `Order #${id} (${order.name}) — marked missed.`;
  }

  return `Unknown command. Text "help" for a list of commands.`;
}

// ─── Confirmation SMS ─────────────────────────────────────────────────────────
function buildConfirmationSms(order: {
  orderNumber: string;
  town: string;
  colony: string;
  colonyAddress: string | null;
  unitNumber: string;
  items: string | null;
  pickupDate: Date;
}): string {
  const dropoff = nextDropoffDate(order.pickupDate);
  const addr = order.colonyAddress ? `${order.colonyAddress}, ` : "";

  return [
    `✅ Order Confirmed — ${order.orderNumber}`,
    ``,
    `📍 ${addr}${order.colony}, Unit ${order.unitNumber}`,
    `   ${order.town}`,
    ``,
    `📦 Items: ${order.items ?? "(none)"}`,
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
    const reply = await handleAdminCommand(text);
    res.send(twimlResponse(reply));
    return;
  }

  // ── Start fresh ───────────────────────────────────────────────────────────
  if (text === "clean") {
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
    res.send(twimlResponse("Welcome to Fresh Pick Dry Cleaning! 👔\n\nWhat is your full name?"));
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
      .set({ colony: raw, step: "colonyAddress", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("What is the street address of your colony? (e.g. 123 Main St)"));
    return;
  }

  if (step === "colonyAddress") {
    await db.update(conversationsTable)
      .set({ colonyAddress: raw, step: "unit", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("What is your unit or house number?"));
    return;
  }

  if (step === "unit") {
    await db.update(conversationsTable)
      .set({ unitNumber: raw, step: "gate", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse('Does your building have a gate?\n\nIf yes, reply with the code or access instructions.\nIf no, just reply "no".'));
    return;
  }

  if (step === "gate") {
    const gateAccess = text === "no" ? null : raw;
    await db.update(conversationsTable)
      .set({ gateAccess, step: "items", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      `What items are you sending in for cleaning?\n\nList them with quantities, for example:\n"2 suits, 3 dress shirts, 1 coat"`
    ));
    return;
  }

  if (step === "items") {
    await db.update(conversationsTable)
      .set({ items: raw, step: "items_confirm", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      `Got it! Here's your order:\n\n${raw}\n\nReply CONFIRM to place your order, or EDIT to change items.`
    ));
    return;
  }

  if (step === "items_confirm") {
    if (text === "edit") {
      await db.update(conversationsTable)
        .set({ step: "items", updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `No problem! Please re-list your items with quantities:\n\nExample: "2 suits, 3 dress shirts, 1 coat"`
      ));
      return;
    }

    if (text === "confirm") {
      const pickupDate = nextPickupDate(convo.town!);
      if (!pickupDate) {
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
        items: convo.items,
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
        items: convo.items,
        pickupDate,
      })));
      return;
    }

    res.send(twimlResponse(
      `Please reply CONFIRM to place your order or EDIT to change items.\n\nYour items: ${convo.items ?? "(none)"}`
    ));
    return;
  }

  res.send(twimlResponse('Text "clean" to start a new pickup request.'));
});

export default router;
