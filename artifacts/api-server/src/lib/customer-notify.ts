import twilio from "twilio";
import { logger } from "./logger";
import type { ordersTable } from "@workspace/db/schema";

type OrderRow = typeof ordersTable.$inferSelect;

// Send an arbitrary SMS to the configured admin phone. Used by the customer
// HELP → "Other" flow to forward free-text help requests. Never throws; SMS
// failures are logged but must not blow up the webhook response.
export async function notifyAdmin(message: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;
  if (!sid || !token || !fromNumber || !adminPhone) {
    logger.warn("notifyAdmin skipped — Twilio env or ADMIN_PHONE_NUMBER not set");
    return false;
  }
  try {
    const client = twilio(sid, token);
    await client.messages.create({ to: adminPhone, from: fromNumber, body: message });
    logger.info({ to: adminPhone }, "Admin notified");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "notifyAdmin failed");
    return false;
  }
}

// ─── Customer-facing status message ───────────────────────────────────────────
// Returns null when this transition should NOT notify the customer.
// Per product spec: only picked_up, delivered, and missed trigger an SMS.
// at_cleaners and ready are internal driver states — silent to the customer.
export function customerStatusMessage(order: OrderRow, newStatus: string): string | null {
  const greeting = `Hi ${order.name.split(" ")[0] ?? order.name}!`;
  switch (newStatus) {
    case "picked_up":
      return `${greeting} ✅ We just picked up your order ${order.orderNumber} from ${order.colony}. It's on the way to the cleaners — we'll text you again when it's been delivered back to your unit.`;
    case "delivered":
      return `${greeting} 🧺 Your dry cleaning order ${order.orderNumber} has been delivered back to ${order.colony}, Unit ${order.unitNumber}. Thanks for choosing Upstate Dry Cleaning!${order.paid ? "" : " (Reminder: payment still due.)"}`;
    case "missed":
      return `${greeting} We weren't able to pick up your order ${order.orderNumber} today. Please text us to reschedule — sorry for the inconvenience!`;
    default:
      return null;
  }
}

// Send an arbitrary SMS to the customer. Returns a short suffix describing the
// outcome — useful for the SMS admin path which appends it to its reply. The
// dashboard path doesn't surface this string but the logger still captures it.
// Never throws — SMS failures must not block status changes.
export async function notifyCustomer(order: OrderRow, message: string): Promise<string> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !fromNumber) {
    logger.warn({ orderId: order.id }, "Customer notify skipped — TWILIO_PHONE_NUMBER not configured");
    return `\n(⚠️ Customer NOT notified — TWILIO_PHONE_NUMBER not configured.)`;
  }
  try {
    const client = twilio(sid, token);
    await client.messages.create({ to: order.phoneNumber, from: fromNumber, body: message });
    logger.info({ orderId: order.id, to: order.phoneNumber }, "Customer notified");
    return `\n📩 Customer notified.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ orderId: order.id, err: msg }, "Customer notify failed");
    return `\n⚠️ Customer notify FAILED: ${msg}`;
  }
}

// Combined helper — for any status change side effect, call this exactly once.
// Returns suffix or empty string. Use from BOTH the SMS admin path and the
// dashboard PATCH path to keep parity (see .agents/memory/sms-dashboard-parity.md).
export async function notifyCustomerStatusChange(
  order: OrderRow,
  newStatus: string,
): Promise<string> {
  const msg = customerStatusMessage(order, newStatus);
  if (!msg) return "";
  return notifyCustomer(order, msg);
}

// Cancellation / removal notification — fired when an order is hard-deleted
// from either the SMS admin path or the dashboard. Same parity rule applies:
// call from BOTH surfaces (see .agents/memory/sms-dashboard-parity.md).
export async function notifyCustomerCancellation(order: OrderRow): Promise<string> {
  const greeting = `Hi ${order.name.split(" ")[0] ?? order.name}!`;
  const msg =
    `${greeting} Your dry cleaning order ${order.orderNumber} has been cancelled. ` +
    `If this is a mistake or you'd like to reschedule, just text us back. ` +
    `— Upstate Dry Cleaning`;
  return notifyCustomer(order, msg);
}
