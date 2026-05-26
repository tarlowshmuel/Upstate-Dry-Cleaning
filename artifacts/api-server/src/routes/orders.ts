import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, orderLineItemsTable } from "@workspace/db/schema";
import { asc, desc, eq } from "drizzle-orm";
import { nextOrderNumber } from "../lib/order-number";
import { notifyCustomerCancellation, notifyCustomerStatusChange } from "../lib/customer-notify";
import { sendOutstandingReceipt } from "../lib/receipts";
import { getFeeCents, computeOrderTotals } from "../lib/pricing";
import { markOrderPaid } from "../lib/paid-toggle";
import { z } from "zod/v4";

const router = Router();

router.get("/orders", async (_req, res) => {
  const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
  res.json(orders);
});

const createOrderSchema = z.object({
  name: z.string().trim().min(1),
  phoneNumber: z.string().trim().min(1),
  town: z.string().trim().min(1),
  colony: z.string().trim().min(1),
  colonyAddress: z.string().trim().nullable().optional(),
  unitNumber: z.string().trim().min(1),
  gateAccess: z.string().trim().nullable().optional(),
  items: z.string().trim().nullable().optional(),
  notes: z.string().trim().nullable().optional(),
  pickupDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine((s) => {
      const [y, m, d] = s.split("-").map(Number);
      const dt = new Date(Date.UTC(y!, m! - 1, d!));
      return (
        dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === m! - 1 &&
        dt.getUTCDate() === d
      );
    }, "Invalid calendar date")
    .nullable()
    .optional(),
});

router.post("/orders", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid order", details: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  for (let attempt = 0; attempt < 6; attempt++) {
    const orderNumber = await nextOrderNumber();
    try {
      const [created] = await db
        .insert(ordersTable)
        .values({
          orderNumber,
          name: d.name,
          phoneNumber: d.phoneNumber,
          town: d.town,
          colony: d.colony,
          colonyAddress: d.colonyAddress ?? null,
          unitNumber: d.unitNumber,
          gateAccess: d.gateAccess ?? null,
          items: d.items ?? null,
          notes: d.notes ?? null,
          pickupDate: d.pickupDate ?? null,
          status: "pending",
          paid: false,
        })
        .returning();
      res.status(201).json(created);
      return;
    } catch (err: unknown) {
      // 23505 = unique_violation in Postgres; retry with a new order number
      const code = (err as { code?: string } | null)?.code;
      if (code !== "23505") {
        req.log.error({ err }, "Failed to create order");
        res.status(500).json({ error: "Failed to create order" });
        return;
      }
    }
  }
  res.status(500).json({ error: "Could not generate unique order number" });
});

const phoneRe = /^\+?\d{10,15}$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const updateOrderSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    phoneNumber: z
      .string()
      .trim()
      .regex(phoneRe, "Phone must be 10-15 digits, optional leading +")
      .optional(),
    town: z.string().trim().min(1).optional(),
    colony: z.string().trim().min(1).optional(),
    colonyAddress: z.string().trim().nullable().optional(),
    unitNumber: z.string().trim().min(1).optional(),
    gateAccess: z.string().trim().nullable().optional(),
    items: z.string().trim().nullable().optional(),
    notes: z.string().trim().nullable().optional(),
    pickupDate: z
      .string()
      .regex(dateRe, "Date must be YYYY-MM-DD")
      .refine((s) => {
        const [y, m, d] = s.split("-").map(Number);
        const dt = new Date(Date.UTC(y!, m! - 1, d!));
        return (
          dt.getUTCFullYear() === y &&
          dt.getUTCMonth() === m! - 1 &&
          dt.getUTCDate() === d
        );
      }, "Invalid calendar date")
      .nullable()
      .optional(),
  })
  .strict();

router.patch("/orders/:id", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const parsed = updateOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update", details: parsed.error.issues });
    return;
  }
  // Only include keys that were actually sent so we never overwrite a field
  // with undefined.
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "No fields provided" });
    return;
  }
  const [updated] = await db
    .update(ordersTable)
    .set(patch)
    .where(eq(ordersTable.id, id))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(updated);
});

router.patch("/orders/:id/status", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  const { status } = req.body as { status?: string };

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const validStatuses = ["pending", "picked_up", "at_cleaners", "ready", "missed", "delivered"];
  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const [updated] = await db
    .update(ordersTable)
    .set({ status })
    .where(eq(ordersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  // Parity with the SMS admin path — same status transitions trigger the same
  // customer SMS regardless of which surface flipped them. Fire-and-forget so
  // a Twilio hiccup doesn't fail the dashboard mutation.
  notifyCustomerStatusChange(updated, status).catch((err) => {
    req.log.warn({ err, orderId: updated.id, status }, "Customer notify failed (dashboard path)");
  });

  res.json(updated);
});

// Bulk transition: every order currently `at_cleaners` → `ready`. Runs as a
// single conditional UPDATE so stale client snapshots can't rewind orders that
// have since moved on (delivered, missed, etc). Fires the same per-order
// customer notification the single-order PATCH does, preserving SMS↔dashboard
// parity.
// One-tap: every order currently in the van (picked_up) is marked at_cleaners.
// Driver hits this when they walk in and drop the load on the cleaners' counter.
// Same server-side conditional UPDATE pattern as bulk-mark-ready — see
// .agents/memory/bulk-status-transitions.md. Per-order customer notification
// preserved for SMS↔dashboard parity.
router.post("/orders/bulk-mark-at-cleaners", async (req, res) => {
  const updated = await db
    .update(ordersTable)
    .set({ status: "at_cleaners" })
    .where(eq(ordersTable.status, "picked_up"))
    .returning();

  for (const order of updated) {
    notifyCustomerStatusChange(order, "at_cleaners").catch((err) => {
      req.log.warn(
        { err, orderId: order.id, status: "at_cleaners" },
        "Customer notify failed (bulk-mark-at-cleaners path)",
      );
    });
  }

  req.log.info({ count: updated.length }, "Bulk-marked orders at cleaners");
  res.json({ updated: updated.length, orders: updated });
});

router.post("/orders/bulk-mark-ready", async (req, res) => {
  const updated = await db
    .update(ordersTable)
    .set({ status: "ready" })
    .where(eq(ordersTable.status, "at_cleaners"))
    .returning();

  for (const order of updated) {
    notifyCustomerStatusChange(order, "ready").catch((err) => {
      req.log.warn(
        { err, orderId: order.id, status: "ready" },
        "Customer notify failed (bulk-mark-ready path)",
      );
    });
  }

  req.log.info({ count: updated.length }, "Bulk-marked orders ready");
  res.json({ updated: updated.length, orders: updated });
});

router.delete("/orders/:id", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const [deleted] = await db
    .delete(ordersTable)
    .where(eq(ordersTable.id, id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  req.log.info({ orderId: deleted.id, orderNumber: deleted.orderNumber }, "Order deleted");
  // Parity with the SMS admin delete path: cancelled orders text the customer.
  // Fire-and-forget so a Twilio hiccup doesn't fail the dashboard mutation.
  notifyCustomerCancellation(deleted).catch((err) => {
    req.log.warn({ err, orderId: deleted.id }, "Cancellation notify failed (dashboard path)");
  });
  res.status(204).send();
});

const paidSchema = z.object({
  paid: z.boolean(),
  paidMethod: z.enum(["zelle", "cash"]).nullable().optional(),
});

router.patch("/orders/:id/paid", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const parsed = paidSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { paid, paidMethod } = parsed.data;

  // All side effects live in markOrderPaid (shared with the SMS admin path —
  // see .agents/memory/sms-dashboard-parity.md). It stamps paidAt on the
  // false→true transition, dedup-fires the paid confirmation SMS, qualifies
  // referrals, and clears the dedup guard on un-paying.
  const result = await markOrderPaid(id, { paid, paidMethod });
  if (!result) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  req.log.info(
    { orderId: id, transitioned: result.transitioned, paid, paidMethod },
    "Order paid updated (dashboard)",
  );
  res.json(result.order);
});

// ─── Line items / pricing ─────────────────────────────────────────────────────
// GET returns the stored line items + computed totals snapshot for an order.
router.get("/orders/:id/line-items", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const lines = await db
    .select()
    .from(orderLineItemsTable)
    .where(eq(orderLineItemsTable.orderId, id))
    .orderBy(asc(orderLineItemsTable.sortOrder), asc(orderLineItemsTable.id));
  const totals = computeOrderTotals(order, lines);
  res.json({ lines, totals, isPriced: order.pricedAt != null && lines.length > 0 });
});

const lineItemInput = z.object({
  priceListId: z.number().int().nullable().optional(),
  itemName: z.string().trim().min(1).max(60),
  quantity: z.number().int().min(1).max(999),
  unitPriceCents: z.number().int().min(0).max(1_000_000),
  isOverride: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const putLineItemsSchema = z.object({
  lines: z.array(lineItemInput),
  totalOverrideCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
  sendReceipt: z.boolean().optional(), // default true — caller may suppress
});

// PUT replaces the entire line-item set in one transaction. Nulls the
// receipt_sent_at guard so the auto-send fires a fresh receipt (per user spec:
// any pricing edit re-sends the outstanding receipt). Snapshots the fee at
// first pricing so later fee bumps don't retroactively change historical totals.
router.put("/orders/:id/line-items", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const parsed = putLineItemsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { lines, totalOverrideCents, sendReceipt = true } = parsed.data;

  const [existing] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  // Snapshot the fee at first pricing only — later fee bumps don't retroactively
  // alter historical totals. If admin wants to recalc the fee on an existing
  // order they can clear it via DB; we don't expose that to the UI.
  const feeCentsSnapshot = existing.feeCentsSnapshot ?? (await getFeeCents());

  const updated = await db.transaction(async (tx) => {
    await tx.delete(orderLineItemsTable).where(eq(orderLineItemsTable.orderId, id));
    if (lines.length > 0) {
      await tx.insert(orderLineItemsTable).values(
        lines.map((l, i) => ({
          orderId: id,
          priceListId: l.priceListId ?? null,
          itemName: l.itemName,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          isOverride: l.isOverride ?? false,
          sortOrder: l.sortOrder ?? i * 10,
        })),
      );
    }
    const [row] = await tx
      .update(ordersTable)
      .set({
        pricedAt: lines.length > 0 ? existing.pricedAt ?? new Date() : null,
        feeCentsSnapshot: lines.length > 0 ? feeCentsSnapshot : null,
        totalOverrideCents: totalOverrideCents ?? null,
        totalWasOverridden: totalOverrideCents != null,
        receiptSentAt: null, // re-arm; auto-send will fire below if priced
      })
      .where(eq(ordersTable.id, id))
      .returning();
    return row;
  });

  // Fire receipt unless explicitly suppressed (e.g. dashboard "save draft").
  let receiptResult: { sent: boolean; reason?: string } = { sent: false, reason: "skipped" };
  if (sendReceipt && updated && updated.pricedAt != null) {
    receiptResult = await sendOutstandingReceipt(updated.id);
  }
  req.log.info(
    { orderId: id, lineCount: lines.length, receiptSent: receiptResult.sent },
    "Line items saved",
  );

  const fresh = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  const freshLines = await db
    .select()
    .from(orderLineItemsTable)
    .where(eq(orderLineItemsTable.orderId, id))
    .orderBy(asc(orderLineItemsTable.sortOrder), asc(orderLineItemsTable.id));
  const totals = computeOrderTotals(fresh[0]!, freshLines);
  res.json({
    order: fresh[0],
    lines: freshLines,
    totals,
    receiptSent: receiptResult.sent,
    receiptSkippedReason: receiptResult.sent ? undefined : receiptResult.reason,
  });
});

// Manual re-send of the outstanding receipt. Useful if the auto-send failed
// (Twilio hiccup) or the customer asks for a fresh copy.
router.post("/orders/:id/send-receipt", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  const result = await sendOutstandingReceipt(id);
  if (!result.sent) {
    res.status(409).json({ error: result.reason ?? "Could not send receipt" });
    return;
  }
  res.json({ ok: true });
});

export default router;
