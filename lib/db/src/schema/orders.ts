import { pgTable, pgSequence, serial, text, timestamp, date, boolean, integer } from "drizzle-orm/pg-core";
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
  // Pricing/receipt fields. All nullable so legacy unpriced orders stay valid.
  // `priced_at` flips from NULL to a timestamp the first time line items are saved.
  // `fee_cents_snapshot` locks the fee at price-finalize time so later fee bumps
  // don't retroactively change historical totals.
  // `total_override_cents` lets the admin set a custom grand total; computed
  // total is otherwise lines_subtotal + fee_cents_snapshot.
  // `receipt_sent_at` / `paid_confirmation_sent_at` are dedup guards — a save
  // that changes pricing nulls receipt_sent_at so the next save re-sends.
  // `paid_method` is set inline on the row (Zelle/Cash); not asked when toggling.
  pricedAt: timestamp("priced_at"),
  feeCentsSnapshot: integer("fee_cents_snapshot"),
  totalOverrideCents: integer("total_override_cents"),
  totalWasOverridden: boolean("total_was_overridden").notNull().default(false),
  receiptSentAt: timestamp("receipt_sent_at"),
  paidAt: timestamp("paid_at"),
  paidMethod: text("paid_method"),
  paidConfirmationSentAt: timestamp("paid_confirmation_sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
