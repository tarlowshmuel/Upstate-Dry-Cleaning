import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { nextOrderNumber } from "../lib/order-number";
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

router.patch("/orders/:id/status", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  const { status } = req.body as { status?: string };

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  const validStatuses = ["pending", "picked_up", "missed", "delivered"];
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

  res.json(updated);
});

router.patch("/orders/:id/paid", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  const { paid } = req.body as { paid?: boolean };

  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }

  if (typeof paid !== "boolean") {
    res.status(400).json({ error: "Field 'paid' must be a boolean" });
    return;
  }

  const [updated] = await db
    .update(ordersTable)
    .set({ paid })
    .where(eq(ordersTable.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  res.json(updated);
});

export default router;
