import { Router } from "express";
import { db } from "@workspace/db";
import { priceListTable } from "@workspace/db/schema";
import { asc, eq } from "drizzle-orm";
import { z } from "zod/v4";

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  priceCents: z.number().int().min(0).max(1_000_000),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const updateSchema = createSchema.partial();

router.get("/price-list", async (_req, res) => {
  const rows = await db
    .select()
    .from(priceListTable)
    .orderBy(asc(priceListTable.sortOrder), asc(priceListTable.id));
  res.json(rows);
});

router.post("/price-list", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [row] = await db
      .insert(priceListTable)
      .values({ ...parsed.data, updatedAt: new Date() })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(msg)) {
      res.status(409).json({ error: "An item with that name already exists" });
      return;
    }
    throw err;
  }
});

router.patch("/price-list/:id", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(priceListTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(priceListTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Price list item not found" });
    return;
  }
  res.json(row);
});

// Soft-delete by flipping active=false. Hard-deleting would break the
// price_list_id reference on historical line items.
router.delete("/price-list/:id", async (req, res) => {
  const id = parseInt(req.params.id ?? "");
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [row] = await db
    .update(priceListTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(priceListTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Price list item not found" });
    return;
  }
  res.json(row);
});

export default router;
