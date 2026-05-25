import { Router } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable } from "@workspace/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";

const router = Router();

// ─── Towns + Schedule ─────────────────────────────────────────────────────────
// Each town maps to { pickup: weekday name, dropoff: weekday name }
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

// ─── Dry Cleaning Items ────────────────────────────────────────────────────────
const ITEMS = [
  "Suit",
  "Jacket / Blazer",
  "Dress Shirt",
  "Pants / Trousers",
  "Dress",
  "Skirt",
  "Blouse",
  "Sweater / Knit",
  "Coat / Winter Jacket",
  "Tie / Scarf",
  "Comforter / Blanket",
];

// Steps: name → town → colony → colonyAddress → unit → gate → item_0..item_N → items_confirm
const itemStep = (index: number) => `item_${index}`;
const isItemStep = (step: string) => /^item_\d+$/.test(step);
const itemIndexFromStep = (step: string) => parseInt(step.replace("item_", ""));

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

function townList(): string {
  return TOWNS.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

function parseItems(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, number>; }
  catch { return {}; }
}

function formatItemsList(json: string | null | undefined): string {
  const items = parseItems(json);
  const lines = Object.entries(items)
    .filter(([, qty]) => qty > 0)
    .map(([name, qty]) => `  ${qty}x ${name}`);
  return lines.length > 0 ? lines.join("\n") : "  (none selected)";
}

type OrderRow = typeof ordersTable.$inferSelect;

function formatOrder(o: OrderRow): string {
  const gate = o.gateAccess ? `Gate: ${o.gateAccess}` : "No gate";
  const addr = o.colonyAddress ? `${o.colonyAddress}, ` : "";
  const itemsStr = formatItemsList(o.items);
  return `#${o.id} | ${o.orderNumber}\n${o.name} | ${o.phoneNumber}\n${addr}${o.colony}, ${o.town}\nUnit: ${o.unitNumber} | ${gate}\nStatus: ${o.status}\nItems:\n${itemsStr}`;
}

// ─── Admin Commands ────────────────────────────────────────────────────────────
async function handleAdminCommand(text: string, raw: string): Promise<string> {
  if (text === "help") {
    return [
      "COMMANDS:",
      "today pickups",
      "today returns",
      "pending",
      "route",
      "customer [id]",
      "mark completed [id]",
      "mark paid [id]",
      "missed [id]",
    ].join("\n");
  }

  if (text === "today pickups") {
    const orders = await db
      .select().from(ordersTable)
      .where(and(eq(ordersTable.status, "pending"), gte(ordersTable.createdAt, todayStart())))
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

  if (text === "route") {
    const orders = await db
      .select().from(ordersTable)
      .where(and(eq(ordersTable.status, "pending"), gte(ordersTable.createdAt, todayStart())))
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
    return msg.trim();
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

// ─── Item step prompt ─────────────────────────────────────────────────────────
function itemPrompt(index: number): string {
  const item = ITEMS[index]!;
  const progress = `(${index + 1}/${ITEMS.length})`;
  return `${progress} How many ${item}s are you bringing in?\n\nReply with a number — or 0 to skip.`;
}

// ─── Confirmation message sent after order is placed ─────────────────────────
function buildConfirmationSms(order: {
  orderNumber: string;
  name: string;
  town: string;
  colony: string;
  colonyAddress: string | null;
  unitNumber: string;
  items: string | null;
}): string {
  const schedule = TOWN_SCHEDULE[order.town] ?? { pickup: "TBD", dropoff: "TBD" };
  const addr = order.colonyAddress ? `${order.colonyAddress}, ` : "";
  const itemsStr = formatItemsList(order.items);

  return [
    `✅ Order Confirmed — ${order.orderNumber}`,
    ``,
    `📍 ${addr}${order.colony}, Unit ${order.unitNumber}`,
    `   ${order.town}`,
    ``,
    `📦 Items:`,
    itemsStr,
    ``,
    `📅 Pickup: ${schedule.pickup}`,
    `📅 Drop-off: ${schedule.dropoff}`,
    ``,
    `📋 Preparation Instructions:`,
    `Please have your items bagged and ready by 9 AM on ${schedule.pickup}. Unprepared or missing orders cannot be picked up. A separate bag per customer is appreciated. Thank you! 🙏`,
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
    const reply = await handleAdminCommand(text, raw);
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
          name: null,
          town: null,
          colony: null,
          colonyAddress: null,
          unitNumber: null,
          items: null,
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

  // ── name ──────────────────────────────────────────────────────────────────
  if (step === "name") {
    await db.update(conversationsTable)
      .set({ name: raw, step: "town", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      `Thanks, ${raw}! Which town are you in?\n\nReply with the number:\n\n${townList()}`
    ));
    return;
  }

  // ── town ──────────────────────────────────────────────────────────────────
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

  // ── colony ────────────────────────────────────────────────────────────────
  if (step === "colony") {
    await db.update(conversationsTable)
      .set({ colony: raw, step: "colonyAddress", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("What is the street address of your colony? (e.g. 123 Main St)"));
    return;
  }

  // ── colonyAddress ─────────────────────────────────────────────────────────
  if (step === "colonyAddress") {
    await db.update(conversationsTable)
      .set({ colonyAddress: raw, step: "unit", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("What is your unit or house number?"));
    return;
  }

  // ── unit ──────────────────────────────────────────────────────────────────
  if (step === "unit") {
    await db.update(conversationsTable)
      .set({ unitNumber: raw, step: "gate", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      'Does your building have a gate?\n\nIf yes, reply with the code or access instructions.\nIf no, just reply "no".'
    ));
    return;
  }

  // ── gate → start item iteration ───────────────────────────────────────────
  if (step === "gate") {
    const gateAccess = text === "no" ? null : raw;
    await db.update(conversationsTable)
      .set({
        step: itemStep(0),
        items: JSON.stringify({ __gate: gateAccess ?? "" }),
        updatedAt: new Date(),
      })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      `Great! Now let's build your order.\n\nFor each item, reply with how many you're bringing. Reply 0 to skip.\n\n${itemPrompt(0)}`
    ));
    return;
  }

  // ── item_N steps ──────────────────────────────────────────────────────────
  if (isItemStep(step)) {
    const index = itemIndexFromStep(step);
    const qty = parseInt(text);

    if (isNaN(qty) || qty < 0) {
      res.send(twimlResponse(`Please reply with a number (0 to skip).\n\n${itemPrompt(index)}`));
      return;
    }

    // Update item counts
    const current = parseItems(convo.items);
    if (qty > 0) {
      current[ITEMS[index]!] = qty;
    }

    const nextIndex = index + 1;

    if (nextIndex < ITEMS.length) {
      // Move to next item
      await db.update(conversationsTable)
        .set({ items: JSON.stringify(current), step: itemStep(nextIndex), updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(itemPrompt(nextIndex)));
    } else {
      // All items done — go to confirmation
      await db.update(conversationsTable)
        .set({ items: JSON.stringify(current), step: "items_confirm", updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));

      const itemsStr = formatItemsList(JSON.stringify(current));
      const hasItems = Object.entries(current).filter(([k, v]) => k !== "__gate" && v > 0).length > 0;

      if (!hasItems) {
        res.send(twimlResponse(
          `You haven't selected any items.\n\nReply EDIT to go back and add items, or text "clean" to start over.`
        ));
      } else {
        res.send(twimlResponse(
          `Here's your order:\n\n${itemsStr}\n\nReply CONFIRM to place your order, or EDIT to make changes.`
        ));
      }
    }
    return;
  }

  // ── items_confirm ─────────────────────────────────────────────────────────
  if (step === "items_confirm") {
    if (text === "edit") {
      // Restart item iteration from item 0, keep existing counts
      await db.update(conversationsTable)
        .set({ step: itemStep(0), updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `Let's update your order. Reply with the new quantity for each item (0 to remove).\n\n${itemPrompt(0)}`
      ));
      return;
    }

    if (text === "confirm") {
      const itemsData = parseItems(convo.items);

      // Extract gate from __gate key
      const gateAccess = ("__gate" in itemsData && typeof itemsData["__gate"] === "string")
        ? (itemsData["__gate"] as string) || null
        : null;
      delete itemsData["__gate"];

      const cleanItems = JSON.stringify(itemsData);
      const orderNumber = generateOrderNumber();

      const newOrder = {
        orderNumber,
        phoneNumber: from,
        name: convo.name!,
        town: convo.town!,
        colony: convo.colony!,
        colonyAddress: convo.colonyAddress ?? null,
        unitNumber: convo.unitNumber!,
        gateAccess,
        items: cleanItems,
        status: "pending" as const,
      };

      await db.insert(ordersTable).values(newOrder);
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));

      const confirmMsg = buildConfirmationSms({
        orderNumber,
        name: convo.name!,
        town: convo.town!,
        colony: convo.colony!,
        colonyAddress: convo.colonyAddress ?? null,
        unitNumber: convo.unitNumber!,
        items: cleanItems,
      });

      res.send(twimlResponse(confirmMsg));
      return;
    }

    // Unknown reply at confirm step
    const itemsStr = formatItemsList(convo.items);
    res.send(twimlResponse(
      `Please reply CONFIRM to place your order or EDIT to make changes.\n\nYour order:\n${itemsStr}`
    ));
    return;
  }

  res.send(twimlResponse('Text "clean" to start a new pickup request.'));
});

export default router;
