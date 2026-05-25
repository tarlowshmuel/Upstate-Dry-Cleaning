import twilio from "twilio";
import { db } from "@workspace/db";
import { ordersTable, referralsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

export const REFERRAL_THRESHOLD = 3;
export const REFERRAL_CREDIT_USD = 30;
export const REFERRAL_MAX_REDEMPTIONS = 2;

export interface ReferralStats {
  total: number;
  pending: number;
  qualified: number;
  creditsEarned: number;
  creditsUsed: number;
  creditsAvailable: number;
  atCap: boolean;
}

export async function getReferralStats(referrerPhone: string): Promise<ReferralStats> {
  const refs = await db.select().from(referralsTable)
    .where(eq(referralsTable.referrerPhone, referrerPhone));
  const total = refs.length;
  const qualified = refs.filter((r) => r.qualified).length;
  const pending = total - qualified;
  const earnedRaw = Math.floor(qualified / REFERRAL_THRESHOLD);
  const creditsEarned = Math.min(earnedRaw, REFERRAL_MAX_REDEMPTIONS);
  const usedRows = await db.select({ id: ordersTable.id }).from(ordersTable)
    .where(and(
      eq(ordersTable.phoneNumber, referrerPhone),
      eq(ordersTable.referralCreditApplied, true),
    ));
  const creditsUsed = usedRows.length;
  const creditsAvailable = Math.max(0, creditsEarned - creditsUsed);
  const atCap = qualified >= REFERRAL_THRESHOLD * REFERRAL_MAX_REDEMPTIONS;
  return { total, pending, qualified, creditsEarned, creditsUsed, creditsAvailable, atCap };
}

/**
 * Mark a single pending referral as qualified when its referred phone completes
 * their FIRST paid pickup. Atomic — only one concurrent paid-hook will win
 * the conditional update and send the SMS. Best-effort; never throws.
 */
export async function qualifyReferralsFor(referredPhone: string, qualifyingOrderId: number): Promise<void> {
  try {
    // Enforce "first paid pickup": if this customer already had any other paid
    // order before this one, do NOT qualify the referral. Their pending
    // referral simply stays pending (harmless — never qualifies).
    const priorPaid = await db.select({ id: ordersTable.id }).from(ordersTable)
      .where(and(
        eq(ordersTable.phoneNumber, referredPhone),
        eq(ordersTable.paid, true),
      ));
    if (priorPaid.filter((o) => o.id !== qualifyingOrderId).length > 0) return;

    const [ref] = await db.select().from(referralsTable)
      .where(and(
        eq(referralsTable.referredPhone, referredPhone),
        eq(referralsTable.qualified, false),
      ))
      .limit(1);
    if (!ref) return;

    // Atomic flip: only proceed with SMS if we actually changed the row from
    // qualified=false → true. Concurrent hooks will be no-ops.
    const updated = await db.update(referralsTable)
      .set({ qualified: true, qualifiedAt: new Date(), qualifiedOrderId: qualifyingOrderId })
      .where(and(eq(referralsTable.id, ref.id), eq(referralsTable.qualified, false)))
      .returning({ id: referralsTable.id });
    if (updated.length === 0) return;

    const stats = await getReferralStats(ref.referrerPhone);
    const sid = process.env["TWILIO_ACCOUNT_SID"];
    const token = process.env["TWILIO_AUTH_TOKEN"];
    const fromNumber = process.env["TWILIO_PHONE_NUMBER"];
    if (!sid || !token || !fromNumber) return;
    const firstName = ref.referredName.split(" ")[0] ?? ref.referredName;
    let body: string;
    if (stats.creditsAvailable > 0) {
      body =
        `🎉 ${firstName} just completed their first pickup! ` +
        `You've earned a FREE pickup (up to $${REFERRAL_CREDIT_USD}). ` +
        `Use it on your next order — just text "clean" to schedule.`;
    } else {
      const nextThreshold = (Math.floor(stats.qualified / REFERRAL_THRESHOLD) + 1) * REFERRAL_THRESHOLD;
      const need = Math.max(0, nextThreshold - stats.qualified);
      body =
        `🎉 ${firstName} just completed their first pickup — that's ${stats.qualified} qualified referral${stats.qualified !== 1 ? "s" : ""}! ` +
        (need > 0 ? `${need} more to earn your next free pickup.` : `Thanks for spreading the word!`);
    }
    try {
      const client = twilio(sid, token);
      await client.messages.create({ to: ref.referrerPhone, from: fromNumber, body });
    } catch { /* best-effort */ }
  } catch { /* best-effort — never block payment status updates */ }
}

/**
 * Redeem one available credit by marking an order as paid via referral credit.
 * Atomic: re-checks creditsAvailable inside the update guard so concurrent
 * applies cannot over-spend. Returns the updated order or a string reason.
 */
export async function applyReferralCredit(orderId: number): Promise<
  | { ok: true; order: typeof ordersTable.$inferSelect; remaining: number }
  | { ok: false; reason: string }
> {
  const [order] = await db.select().from(ordersTable)
    .where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) return { ok: false, reason: "Order not found." };
  if (order.referralCreditApplied) {
    return { ok: false, reason: `Order #${orderId} already has a referral credit applied.` };
  }
  const stats = await getReferralStats(order.phoneNumber);
  if (stats.creditsAvailable < 1) {
    return {
      ok: false,
      reason: `${order.name} (${order.phoneNumber}) has no available referral credits ` +
        `(${stats.qualified} qualified, ${stats.creditsUsed} used).`,
    };
  }
  const [updated] = await db.update(ordersTable)
    .set({ paid: true, referralCreditApplied: true })
    .where(and(eq(ordersTable.id, orderId), eq(ordersTable.referralCreditApplied, false)))
    .returning();
  if (!updated) return { ok: false, reason: "Race condition — credit already applied. Try again." };
  return { ok: true, order: updated, remaining: stats.creditsAvailable - 1 };
}
