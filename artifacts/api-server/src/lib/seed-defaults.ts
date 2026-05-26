import { db } from "@workspace/db";
import { priceListTable, settingsTable, SETTING_DEFAULTS } from "@workspace/db/schema";
import { logger } from "./logger";

// Seed-on-boot. Idempotent: only inserts rows that don't exist yet, so
// repeated boots and DB pushes never duplicate or overwrite hand edits.
// Runs on every server start so a fresh DB (or a wiped settings row) gets
// reseeded automatically.

const DEFAULT_PRICE_LIST: Array<{ name: string; priceCents: number; sortOrder: number }> = [
  { name: "Shirt", priceCents: 400, sortOrder: 10 },
  { name: "Pants", priceCents: 800, sortOrder: 20 },
  { name: "Skirt", priceCents: 800, sortOrder: 30 },
  { name: "Sweater", priceCents: 800, sortOrder: 40 },
  { name: "Jacket", priceCents: 1200, sortOrder: 50 },
  { name: "Dress", priceCents: 1400, sortOrder: 60 },
  { name: "Suit", priceCents: 1800, sortOrder: 70 },
  { name: "Coat", priceCents: 2200, sortOrder: 80 },
  { name: "Comforter", priceCents: 3500, sortOrder: 90 },
  { name: "Tie", priceCents: 500, sortOrder: 100 },
];

export async function seedDefaults(): Promise<void> {
  // Settings
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await db.insert(settingsTable).values({ key, value }).onConflictDoNothing();
  }
  // Price list — only seed if EMPTY. Once the admin has any rows, never
  // touch it (don't re-add items the admin deleted).
  const existing = await db.select({ id: priceListTable.id }).from(priceListTable).limit(1);
  if (existing.length === 0) {
    await db.insert(priceListTable).values(DEFAULT_PRICE_LIST);
    logger.info({ count: DEFAULT_PRICE_LIST.length }, "Seeded default price list");
  }
}
