import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";

const router = Router();

router.get("/orders", async (req, res) => {
  const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
  res.json(orders);
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
