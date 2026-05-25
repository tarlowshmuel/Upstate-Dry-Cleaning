import { pgTable, serial, text, timestamp, boolean, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const referralsTable = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    referrerPhone: text("referrer_phone").notNull(),
    referredPhone: text("referred_phone").notNull(),
    referredName: text("referred_name").notNull(),
    referredColony: text("referred_colony"),
    referredTown: text("referred_town"),
    qualified: boolean("qualified").notNull().default(false),
    qualifiedAt: timestamp("qualified_at"),
    qualifiedOrderId: integer("qualified_order_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // A given referred phone can only be the subject of one referral, ever.
    referredPhoneUnique: uniqueIndex("referrals_referred_phone_unique").on(t.referredPhone),
  }),
);

export const insertReferralSchema = createInsertSchema(referralsTable).omit({
  id: true,
  createdAt: true,
  qualified: true,
  qualifiedAt: true,
  qualifiedOrderId: true,
});
export type InsertReferral = z.infer<typeof insertReferralSchema>;
export type Referral = typeof referralsTable.$inferSelect;
