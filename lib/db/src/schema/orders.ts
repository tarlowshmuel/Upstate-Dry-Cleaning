import { pgTable, serial, text, timestamp, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),
  phoneNumber: text("phone_number").notNull(),
  name: text("name").notNull(),
  town: text("town").notNull(),
  colony: text("colony").notNull(),
  colonyAddress: text("colony_address"),
  unitNumber: text("unit_number").notNull(),
  gateAccess: text("gate_access"),
  items: text("items"),
  notes: text("notes"),
  pickupDate: date("pickup_date"),
  status: text("status").notNull().default("pending"),
  paid: boolean("paid").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
