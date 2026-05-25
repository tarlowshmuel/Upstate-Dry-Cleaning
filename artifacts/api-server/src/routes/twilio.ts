import { Router } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable } from "@workspace/db/schema";
import { eq, and, gte, desc } from "drizzle-orm";

const router = Router();

// ─── Upstate NY Towns ─────────────────────────────────────────────────────────
const TOWNS: string[] = [
  "Albany",
  "Amsterdam",
  "Auburn",
  "Binghamton",
  "Canton",
  "Catskill",
  "Cooperstown",
  "Cortland",
  "Elmira",
  "Fulton",
  "Geneva",
  "Glens Falls",
  "Gloversville",
  "Hudson",
  "Ithaca",
  "Johnstown",
  "Kingston",
  "Lake Placid",
  "Malone",
  "Massena",
  "Newburgh",
  "Ogdensburg",
  "Oneida",
  "Oneonta",
  "Oswego",
  "Plattsburgh",
  "Potsdam",
  "Poughkeepsie",
  "Rome",
  "Saratoga Springs",
  "Schenectady",
  "Troy",
  "Utica",
  "Watertown",
];

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

type OrderRow = typeof ordersTable.$inferSelect;

function formatOrder(o: OrderRow): string {
  const gate = o.gateAccess ? `Gate: ${o.gateAccess}` : "No gate";
  const addr = o.colonyAddress ? `${o.colonyAddress}, ` : "";
  return `#${o.id} | ${o.orderNumber}\n${o.name} | ${o.phoneNumber}\n${addr}${o.colony}, ${o.town}\nUnit: ${o.unitNumber} | ${gate}\nStatus: ${o.status}`;
}

function townList(): string {
  return TOWNS.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

// ─── Admin Commands ────────────────────────────────────────────────────────────
async function handleAdminCommand(text: string, raw: string): Promise<string> {
  // help
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

  // today pickups — pending orders created today
  if (text === "today pickups") {
    const orders = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.status, "pending"), gte(ordersTable.createdAt, todayStart())))
      .orderBy(ordersTable.town);
    if (orders.length === 0) return "No pickups scheduled for today.";
    return `TODAY'S PICKUPS (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
  }

  // today returns — picked_up orders (clothes at cleaners, being returned)
  if (text === "today returns") {
    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.status, "picked_up"))
      .orderBy(ordersTable.town);
    if (orders.length === 0) return "No returns scheduled.";
    return `RETURNS (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
  }

  // pending — all pending orders
  if (text === "pending") {
    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.status, "pending"))
      .orderBy(desc(ordersTable.createdAt));
    if (orders.length === 0) return "No pending orders.";
    return `PENDING (${orders.length}):\n\n` + orders.map(formatOrder).join("\n\n---\n\n");
  }

  // route — today's pending pickups grouped by town
  if (text === "route") {
    const orders = await db
      .select()
      .from(ordersTable)
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

  // customer [id]
  const customerMatch = text.match(/^customer (\d+)$/);
  if (customerMatch) {
    const id = parseInt(customerMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `No order found with ID ${id}.`;
    return formatOrder(order);
  }

  // mark completed [id]
  const completedMatch = text.match(/^mark completed (\d+)$/);
  if (completedMatch) {
    const id = parseInt(completedMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `Order #${id} not found.`;
    await db.update(ordersTable).set({ status: "picked_up" }).where(eq(ordersTable.id, id));
    return `Order #${id} (${order.name}) — marked picked up.`;
  }

  // mark paid [id]
  const paidMatch = text.match(/^mark paid (\d+)$/);
  if (paidMatch) {
    const id = parseInt(paidMatch[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) return `Order #${id} not found.`;
    await db.update(ordersTable).set({ status: "paid" }).where(eq(ordersTable.id, id));
    return `Order #${id} (${order.name}) — marked paid.`;
  }

  // missed [id]
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

// ─── Webhook ──────────────────────────────────────────────────────────────────
router.post("/webhook/twilio", async (req, res) => {
  const body = req.body as { Body?: string; From?: string };
  const from = (body.From ?? "").trim();
  const raw = (body.Body ?? "").trim();
  const text = raw.toLowerCase();

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

  // ── Customer branch ───────────────────────────────────────────────────────

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
          updatedAt: new Date(),
        },
      });
    res.send(twimlResponse("Welcome to Fresh Pick Dry Cleaning!\n\nWhat is your full name?"));
    return;
  }

  const [convo] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  if (!convo) {
    res.send(twimlResponse('Text "clean" to start a dry cleaning pickup request.'));
    return;
  }

  const step = convo.step;

  if (step === "name") {
    await db
      .update(conversationsTable)
      .set({ name: raw, step: "town", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(
      twimlResponse(
        `Thanks, ${raw}! Which town are you in?\n\nReply with the number:\n\n${townList()}`
      )
    );
    return;
  }

  if (step === "town") {
    const num = parseInt(text.trim());
    if (isNaN(num) || num < 1 || num > TOWNS.length) {
      res.send(
        twimlResponse(
          `Please reply with a number between 1 and ${TOWNS.length}.\n\n${townList()}`
        )
      );
      return;
    }
    const selectedTown = TOWNS[num - 1]!;
    await db
      .update(conversationsTable)
      .set({ town: selectedTown, step: "colony", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(`${selectedTown} — got it!\n\nWhat is the name of your colony or neighborhood?`));
    return;
  }

  if (step === "colony") {
    await db
      .update(conversationsTable)
      .set({ colony: raw, step: "colonyAddress", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("What is the street address of your colony? (e.g. 123 Main St)"));
    return;
  }

  if (step === "colonyAddress") {
    await db
      .update(conversationsTable)
      .set({ colonyAddress: raw, step: "unit", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse("What is your unit or house number?"));
    return;
  }

  if (step === "unit") {
    await db
      .update(conversationsTable)
      .set({ unitNumber: raw, step: "gate", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(
      twimlResponse(
        'Almost done! Does your building have a front gate?\nIf yes, reply with the code or access instructions.\nIf no, just reply "no".'
      )
    );
    return;
  }

  if (step === "gate") {
    const gateAccess = text === "no" ? null : raw;
    const orderNumber = generateOrderNumber();

    await db.insert(ordersTable).values({
      orderNumber,
      phoneNumber: from,
      name: convo.name!,
      town: convo.town!,
      colony: convo.colony!,
      colonyAddress: convo.colonyAddress ?? null,
      unitNumber: convo.unitNumber!,
      gateAccess,
      status: "pending",
    });

    await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));

    const gateMsg = gateAccess ? `Gate: ${gateAccess}` : "No gate access needed.";
    res.send(
      twimlResponse(
        `Pickup confirmed!\n\nOrder: ${orderNumber}\nName: ${convo.name}\nTown: ${convo.town}\nColony: ${convo.colony}\nAddress: ${convo.colonyAddress}\nUnit: ${convo.unitNumber}\n${gateMsg}\n\nWe'll be in touch soon!`
      )
    );
    return;
  }

  res.send(twimlResponse('Text "clean" to start a new pickup request.'));
});

export default router;
