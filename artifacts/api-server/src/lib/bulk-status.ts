import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { notifyCustomerStatusChange } from "./customer-notify";
import { logger } from "./logger";

// Single source of truth for "mark every order currently in status X as Y".
// Both dashboard bulk endpoints AND the SMS admin bulk command must call this —
// see .agents/memory/sms-dashboard-parity.md and bulk-status-transitions.md.
// Uses a conditional UPDATE WHERE (server-side) so orders that moved on
// between fetch and confirm are never rewound.

export type BulkTransition =
  | { from: "picked_up"; to: "at_cleaners" }
  | { from: "at_cleaners"; to: "ready" }
  | { from: "ready"; to: "delivered" };

export interface BulkTransitionResult {
  updated: number;
  orders: (typeof ordersTable.$inferSelect)[];
}

export async function bulkTransitionStatus(
  t: BulkTransition,
): Promise<BulkTransitionResult> {
  const updated = await db
    .update(ordersTable)
    .set({ status: t.to })
    .where(eq(ordersTable.status, t.from))
    .returning();

  for (const order of updated) {
    notifyCustomerStatusChange(order, t.to).catch((err) => {
      logger.warn(
        { err, orderId: order.id, from: t.from, to: t.to },
        "Customer notify failed (bulk transition)",
      );
    });
  }

  logger.info(
    { count: updated.length, from: t.from, to: t.to },
    "Bulk status transition",
  );
  return { updated: updated.length, orders: updated };
}
