import { pgTable, pgSequence, serial, text, timestamp, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Customer-facing order number generator. Lives in the DB so it survives
// restarts and gives a single source of truth across the SMS admin "new order"
// flow and the dashboard's "New Order" form. Starts at 2017 to leave room for
// the seed/test orders already in the 2000-range.
export const orderNumberSeq = pgSequence("order_number_seq", { startWith: 2017, increment: 1 });

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
  cleanerTickets: text("cleaner_tickets"),
  pickupDate: date("pickup_date"),
  status: text("status").notNull().default("pending"),
  paid: boolean("paid").notNull().default(false),
  referralCreditApplied: boolean("referral_credit_applied").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
