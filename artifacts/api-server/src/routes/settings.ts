import { Router } from "express";
import { db } from "@workspace/db";
import { settingsTable, SETTING_DEFAULTS, SETTING_KEYS } from "@workspace/db/schema";
import { z } from "zod/v4";

const router = Router();

// Settings live as a key/value table seeded on boot; we always expose them as
// a flat JSON object with default fallbacks so the client never has to deal
// with a missing key.

async function readSettings(): Promise<Record<string, number>> {
  const rows = await db.select().from(settingsTable);
  const out: Record<string, number> = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

router.get("/settings", async (_req, res) => {
  const map = await readSettings();
  res.json({
    feeCents: map[SETTING_KEYS.feeCents] ?? SETTING_DEFAULTS[SETTING_KEYS.feeCents]!,
    orderMinimumCents:
      map[SETTING_KEYS.orderMinimumCents] ?? SETTING_DEFAULTS[SETTING_KEYS.orderMinimumCents]!,
    wholesalePercent:
      map[SETTING_KEYS.wholesalePercent] ?? SETTING_DEFAULTS[SETTING_KEYS.wholesalePercent]!,
  });
});

const updateSchema = z.object({
  feeCents: z.number().int().min(0).max(100_000).optional(),
  orderMinimumCents: z.number().int().min(0).max(1_000_000).optional(),
  wholesalePercent: z.number().int().min(0).max(100).optional(),
});

router.patch("/settings", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const entries: Array<[string, number]> = [];
  if (parsed.data.feeCents != null) entries.push([SETTING_KEYS.feeCents, parsed.data.feeCents]);
  if (parsed.data.orderMinimumCents != null)
    entries.push([SETTING_KEYS.orderMinimumCents, parsed.data.orderMinimumCents]);
  if (parsed.data.wholesalePercent != null)
    entries.push([SETTING_KEYS.wholesalePercent, parsed.data.wholesalePercent]);

  for (const [key, value] of entries) {
    await db
      .insert(settingsTable)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value, updatedAt: new Date() },
      });
  }
  const map = await readSettings();
  res.json({
    feeCents: map[SETTING_KEYS.feeCents] ?? SETTING_DEFAULTS[SETTING_KEYS.feeCents]!,
    orderMinimumCents:
      map[SETTING_KEYS.orderMinimumCents] ?? SETTING_DEFAULTS[SETTING_KEYS.orderMinimumCents]!,
    wholesalePercent:
      map[SETTING_KEYS.wholesalePercent] ?? SETTING_DEFAULTS[SETTING_KEYS.wholesalePercent]!,
  });
});

export default router;
