import { db } from "@workspace/db";
import { orderLineItemsTable, settingsTable, SETTING_DEFAULTS, SETTING_KEYS } from "@workspace/db/schema";
import type { Order, OrderLineItem } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";

// All money calculations are integer cents. Never floats — JS floats lose
// precision on summing many decimals (0.1 + 0.2 ≠ 0.3). Format only at the
// presentation boundary.

export function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${whole}.${rem.toString().padStart(2, "0")}`;
}

export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, dec = ""] = s.split(".");
  const decPadded = (dec + "00").slice(0, 2);
  return parseInt(whole ?? "0", 10) * 100 + parseInt(decPadded, 10);
}

export type OrderTotals = {
  itemsSubtotalCents: number;
  feeCents: number;
  grandTotalCents: number;
  isOverridden: boolean;
};

export function computeOrderTotals(
  order: Pick<Order, "feeCentsSnapshot" | "totalOverrideCents" | "totalWasOverridden">,
  lines: ReadonlyArray<Pick<OrderLineItem, "quantity" | "unitPriceCents">>,
): OrderTotals {
  const itemsSubtotalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0);
  const feeCents = order.feeCentsSnapshot ?? 0;
  const computed = itemsSubtotalCents + feeCents;
  const isOverridden = order.totalWasOverridden && order.totalOverrideCents != null;
  const grandTotalCents = isOverridden ? (order.totalOverrideCents as number) : computed;
  return { itemsSubtotalCents, feeCents, grandTotalCents, isOverridden };
}

export async function getSettingsMap(): Promise<Record<string, number>> {
  const rows = await db.select().from(settingsTable);
  const out: Record<string, number> = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getFeeCents(): Promise<number> {
  const map = await getSettingsMap();
  return map[SETTING_KEYS.feeCents] ?? SETTING_DEFAULTS[SETTING_KEYS.feeCents]!;
}

export async function getOrderLineItems(orderId: number): Promise<OrderLineItem[]> {
  return db
    .select()
    .from(orderLineItemsTable)
    .where(eq(orderLineItemsTable.orderId, orderId))
    .orderBy(asc(orderLineItemsTable.sortOrder), asc(orderLineItemsTable.id));
}

// Convenience: load lines + compute totals in one call.
export async function loadOrderPricing(
  order: Order,
): Promise<{ lines: OrderLineItem[]; totals: OrderTotals; isPriced: boolean }> {
  const lines = await getOrderLineItems(order.id);
  const totals = computeOrderTotals(order, lines);
  const isPriced = order.pricedAt != null && lines.length > 0;
  return { lines, totals, isPriced };
}
