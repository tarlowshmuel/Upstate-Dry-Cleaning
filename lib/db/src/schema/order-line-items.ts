import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Structured line items per order. unitPriceCents is SNAPSHOTTED at the time
// the line was saved — later edits to the price list never alter past orders.
// priceListId is nullable so a soft-deleted price-list row can't break
// referential integrity; itemName is also snapshotted for the same reason.
export const orderLineItemsTable = pgTable("order_line_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull(),
  priceListId: integer("price_list_id"),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  isOverride: boolean("is_override").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertOrderLineItemSchema = createInsertSchema(orderLineItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertOrderLineItem = z.infer<typeof insertOrderLineItemSchema>;
export type OrderLineItem = typeof orderLineItemsTable.$inferSelect;
