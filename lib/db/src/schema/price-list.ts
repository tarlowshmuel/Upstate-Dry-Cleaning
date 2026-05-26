import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Editable price list. Money is stored as integer cents — never floats.
// We use a soft-delete via `active=false` rather than hard-deleting rows,
// so historical line items that reference a price_list row can still
// resolve their name/lineage if anyone digs through audit data later.
export const priceListTable = pgTable("price_list", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  priceCents: integer("price_cents").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPriceListSchema = createInsertSchema(priceListTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPriceListItem = z.infer<typeof insertPriceListSchema>;
export type PriceListItem = typeof priceListTable.$inferSelect;
