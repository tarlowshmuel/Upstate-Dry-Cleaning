import { useEffect } from "react";
import { useRoute } from "wouter";
import {
  useListOrders,
  useGetOrderLineItems,
  getListOrdersQueryKey,
  getGetOrderLineItemsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";
import { formatCents } from "@/lib/money";

// Printable receipt view. Visible at /receipt/:id. Designed to print cleanly
// on a half-sheet of letter — no nav chrome, all-black ink-safe styling.
export default function ReceiptPage() {
  const [, params] = useRoute<{ id: string }>("/receipt/:id");
  const orderId = params ? parseInt(params.id, 10) : NaN;

  const { data: orders } = useListOrders({ query: { queryKey: getListOrdersQueryKey() } });
  const order = orders?.find((o) => o.id === orderId);
  const { data: pricing } = useGetOrderLineItems(orderId, {
    query: { queryKey: getGetOrderLineItemsQueryKey(orderId), enabled: !Number.isNaN(orderId) },
  });

  useEffect(() => {
    document.title = order ? `Receipt — ${order.orderNumber}` : "Receipt";
  }, [order]);

  if (Number.isNaN(orderId)) return <p className="p-6">Invalid receipt.</p>;
  if (!order) return <p className="p-6">Loading order…</p>;
  if (!pricing) return <p className="p-6">Loading items…</p>;

  if (!pricing.isPriced) {
    return (
      <div className="max-w-md mx-auto p-8 text-center">
        <p className="text-lg font-semibold">Order {order.orderNumber} is not priced yet.</p>
        <p className="text-sm text-muted-foreground mt-2">
          Add line items in the dashboard before printing a receipt.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white text-black min-h-screen">
      <div className="max-w-md mx-auto p-8">
        <div className="flex justify-end gap-2 print:hidden mb-4">
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>
            Back
          </Button>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="w-4 h-4 mr-1" /> Print
          </Button>
        </div>

        <div className="border-b-2 border-black pb-4 mb-4">
          <h1 className="text-2xl font-bold">Upstate Dry Cleaning</h1>
          <p className="text-sm">Sullivan County, NY · (845) 606-0022</p>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide opacity-60">Receipt</p>
            <p className="font-semibold text-lg">{order.orderNumber}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide opacity-60">Date</p>
            <p>{order.pricedAt ? new Date(order.pricedAt).toLocaleDateString() : "—"}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs uppercase tracking-wide opacity-60">Customer</p>
            <p>{order.name}</p>
            <p className="text-sm opacity-70">
              {order.colony}, Unit {order.unitNumber} · {order.town}
            </p>
            <p className="text-sm opacity-70">{order.phoneNumber}</p>
          </div>
        </div>

        <table className="w-full text-sm mb-4">
          <thead>
            <tr className="border-b border-black">
              <th className="text-left py-1">Item</th>
              <th className="text-right py-1 w-12">Qty</th>
              <th className="text-right py-1 w-20">Price</th>
              <th className="text-right py-1 w-20">Total</th>
            </tr>
          </thead>
          <tbody>
            {pricing.lines.map((l) => (
              <tr key={l.id} className="border-b border-dashed border-black/30">
                <td className="py-1">{l.itemName}</td>
                <td className="text-right py-1">{l.quantity}</td>
                <td className="text-right py-1">{formatCents(l.unitPriceCents)}</td>
                <td className="text-right py-1">{formatCents(l.quantity * l.unitPriceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="space-y-1 text-sm">
          <div className="flex justify-between">
            <span>Items subtotal</span>
            <span>{formatCents(pricing.totals.itemsSubtotalCents)}</span>
          </div>
          <div className="flex justify-between">
            <span>Pickup &amp; delivery</span>
            <span>{formatCents(pricing.totals.feeCents)}</span>
          </div>
          <div className="flex justify-between text-base font-bold border-t-2 border-black pt-1 mt-2">
            <span>Total</span>
            <span>{formatCents(pricing.totals.grandTotalCents)}</span>
          </div>
          {pricing.totals.isOverridden ? (
            <p className="text-xs italic opacity-70">Adjusted total set by Upstate Dry Cleaning.</p>
          ) : null}
        </div>

        <div className="mt-6 pt-4 border-t border-black/30 text-sm">
          <p className="font-semibold">
            {order.paid ? "Paid — thank you!" : "Payment due"}
          </p>
          {!order.paid ? (
            <p className="mt-1">
              Pay by Zelle to (929) 345-0940 (memo: {order.orderNumber}), or cash to the driver.
            </p>
          ) : (
            <p className="mt-1 opacity-70">
              {order.paidMethod ? `Paid via ${order.paidMethod}.` : "Payment received."}
            </p>
          )}
        </div>

        <p className="text-xs text-center mt-8 opacity-60">
          Thank you for choosing Upstate Dry Cleaning.
        </p>
      </div>
    </div>
  );
}
