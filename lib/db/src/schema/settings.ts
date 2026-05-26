import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// Single-row key/value settings. Integer-valued only — anything else gets its
// own table. Seeded with fee_cents=600, order_minimum_cents=1800,
// wholesale_percent=50. Schema stays open (no enum) so we can add knobs later
// without a migration.
export const settingsTable = pgTable("settings", {
  key: text("key").primaryKey(),
  value: integer("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Setting = typeof settingsTable.$inferSelect;

export const SETTING_KEYS = {
  feeCents: "fee_cents",
  orderMinimumCents: "order_minimum_cents",
  wholesalePercent: "wholesale_percent",
} as const;

export const SETTING_DEFAULTS: Record<string, number> = {
  [SETTING_KEYS.feeCents]: 600,
  [SETTING_KEYS.orderMinimumCents]: 1800,
  [SETTING_KEYS.wholesalePercent]: 50,
};
