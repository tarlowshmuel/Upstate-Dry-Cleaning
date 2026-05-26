import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { sendPaidConfirmation } from "./receipts";
import { qualifyReferralsFor } from "./referrals";

// Single source of truth for the side-effects of toggling an order's paid flag.
// Both the dashboard PATCH /orders/:id/paid handler AND the SMS admin "mark
// paid" command must call this — see .agents/memory/sms-dashboard-parity.md.
// Idempotent and dedup-safe:
//   • Stamps paidAt only on the false→true transition
//   • sendPaidConfirmation is guarded by paid_confirmation_sent_at (one SMS ever per pay-cycle)
//   • Un-paying clears paidAt + the dedup guard so a future re-pay re-fires
export type MarkPaidInput = {
  paid: boolean;
  paidMethod?: "zelle" | "cash" | null;
};

export type MarkPaidResult = {
  order: typeof ordersTable.$inferSelect;
  transitioned: "to-paid" | "to-unpaid" | "method-only" | "no-op";
};

export async function markOrderPaid(
  orderId: number,
  input: MarkPaidInput,
): Promise<MarkPaidResult | null> {
  const [existing] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.id, orderId))
    .limit(1);
  if (!existing) return null;

  const patch: Partial<typeof ordersTable.$inferInsert> = { paid: input.paid };
  let transitioned: MarkPaidResult["transitioned"] = "no-op";

  if (input.paid && !existing.paid) {
    patch.paidAt = new Date();
    patch.paidMethod = input.paidMethod ?? existing.paidMethod ?? null;
    transitioned = "to-paid";
  } else if (!input.paid && existing.paid) {
    patch.paidAt = null;
    patch.paidConfirmationSentAt = null;
    if (input.paidMethod !== undefined) patch.paidMethod = input.paidMethod;
    transitioned = "to-unpaid";
  } else if (input.paidMethod !== undefined && input.paidMethod !== existing.paidMethod) {
    patch.paidMethod = input.paidMethod;
    transitioned = "method-only";
  }

  const [updated] = await db
    .update(ordersTable)
    .set(patch)
    .where(eq(ordersTable.id, orderId))
    .returning();
  if (!updated) return null;

  if (transitioned === "to-paid") {
    // Fire-and-forget: a Twilio hiccup must not roll back the paid flag.
    sendPaidConfirmation(updated.id).catch(() => {
      /* logged at the route layer */
    });
    try {
      await qualifyReferralsFor(updated.phoneNumber, updated.id);
    } catch {
      /* best-effort */
    }
  }

  return { order: updated, transitioned };
}
