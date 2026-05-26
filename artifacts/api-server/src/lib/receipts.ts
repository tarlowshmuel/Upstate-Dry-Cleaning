import { db } from "@workspace/db";
import { ordersTable } from "@workspace/db/schema";
import type { Order, OrderLineItem } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { notifyCustomer } from "./customer-notify";
import { computeOrderTotals, formatDollars, getOrderLineItems } from "./pricing";
import { logger } from "./logger";

// Outstanding (itemized) receipt — sent when an order is first priced and
// re-sent on every pricing edit. Idempotency is enforced by the
// `receipt_sent_at` timestamp on the order: any pricing edit nulls it,
// then the next save fires this and sets it again.
//
// Wording locked by the user. Keep this in sync across SMS admin path and
// dashboard path — they both call this single function (parity rule).
export function buildOutstandingReceiptBody(
  order: Order,
  lines: ReadonlyArray<OrderLineItem>,
): string {
  const { itemsSubtotalCents, feeCents, grandTotalCents, isOverridden } = computeOrderTotals(
    order,
    lines,
  );
  const lineRows = lines.map(
    (l) =>
      `${l.quantity} × ${l.itemName} @ ${formatDollars(l.unitPriceCents)} = ${formatDollars(
        l.quantity * l.unitPriceCents,
      )}`,
  );
  const parts = [
    `Upstate Dry Cleaning — Receipt`,
    `Order #${order.orderNumber}`,
    ``,
    ...lineRows,
    ``,
    `Items subtotal: ${formatDollars(itemsSubtotalCents)}`,
    `Pickup & delivery: ${formatDollars(feeCents)}`,
    `Total: ${formatDollars(grandTotalCents)}`,
  ];
  if (isOverridden) {
    parts.push(`Adjusted total set by Upstate Dry Cleaning.`);
  }
  parts.push(
    ``,
    `Pay by Zelle to (929) 345-0940 (memo: ${order.orderNumber}), or cash to the driver.`,
    `Reply HELP for help, STOP to opt out.`,
  );
  return parts.join("\n");
}

export function buildPaidConfirmationBody(
  order: Order,
  lines: ReadonlyArray<OrderLineItem>,
): string {
  const { grandTotalCents } = computeOrderTotals(order, lines);
  const hasTotal = grandTotalCents > 0;
  const amount = hasTotal ? ` (${formatDollars(grandTotalCents)})` : "";
  return (
    `Upstate Dry Cleaning — Order #${order.orderNumber}\n` +
    `Payment received${amount}. Thank you!`
  );
}

// Send the outstanding receipt and mark it sent. Caller is responsible for
// having already saved any pricing edits and nulled receipt_sent_at.
// Returns true if SMS actually went out, false if skipped (unpriced).
export async function sendOutstandingReceipt(orderId: number): Promise<{
  sent: boolean;
  reason?: string;
}> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) return { sent: false, reason: "Order not found" };
  if (order.pricedAt == null) return { sent: false, reason: "Order is not priced yet" };

  const lines = await getOrderLineItems(orderId);
  if (lines.length === 0) return { sent: false, reason: "Order has no line items" };

  const body = buildOutstandingReceiptBody(order, lines);
  const suffix = await notifyCustomer(order, body);
  const ok = !suffix.includes("FAILED") && !suffix.includes("not configured");
  if (ok) {
    await db
      .update(ordersTable)
      .set({ receiptSentAt: new Date() })
      .where(eq(ordersTable.id, orderId));
    logger.info({ orderId, orderNumber: order.orderNumber }, "Outstanding receipt sent");
  } else {
    logger.warn({ orderId, suffix }, "Outstanding receipt send failed");
  }
  return { sent: ok, reason: ok ? undefined : suffix.trim() };
}

// Send the paid-confirmation receipt and mark it sent. Idempotent: if
// paid_confirmation_sent_at is already set, this no-ops.
export async function sendPaidConfirmation(orderId: number): Promise<{
  sent: boolean;
  reason?: string;
}> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId)).limit(1);
  if (!order) return { sent: false, reason: "Order not found" };
  if (!order.paid) return { sent: false, reason: "Order is not marked paid" };
  if (order.paidConfirmationSentAt != null) {
    return { sent: false, reason: "Paid confirmation already sent" };
  }

  const lines = await getOrderLineItems(orderId);
  const body = buildPaidConfirmationBody(order, lines);
  const suffix = await notifyCustomer(order, body);
  const ok = !suffix.includes("FAILED") && !suffix.includes("not configured");
  if (ok) {
    await db
      .update(ordersTable)
      .set({ paidConfirmationSentAt: new Date() })
      .where(eq(ordersTable.id, orderId));
    logger.info({ orderId, orderNumber: order.orderNumber }, "Paid confirmation sent");
  } else {
    logger.warn({ orderId, suffix }, "Paid confirmation send failed");
  }
  return { sent: ok, reason: ok ? undefined : suffix.trim() };
}
