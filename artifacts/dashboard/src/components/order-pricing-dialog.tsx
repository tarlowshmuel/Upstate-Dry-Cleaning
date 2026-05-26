import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOrderLineItems,
  useReplaceOrderLineItems,
  useListPriceList,
  useGetSettings,
  getGetOrderLineItemsQueryKey,
  getListOrdersQueryKey,
  getListPriceListQueryKey,
  getGetSettingsQueryKey,
  type Order,
  type LineItemInput,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Receipt } from "lucide-react";
import { toast } from "sonner";
import { formatCents, parseDollarsToCents } from "@/lib/money";

// One editable line on the form. We carry the raw text inputs so the user can
// freely type "1.5" before validating to cents on save — avoids the classic
// "controlled input loses trailing zero" UX papercut.
type DraftLine = {
  key: string;
  priceListId: number | null;
  itemName: string;
  qtyInput: string;
  priceInput: string;
  isOverride: boolean;
};

function makeKey() {
  return Math.random().toString(36).slice(2);
}

export function OrderPricingDialog({
  order,
  open,
  onOpenChange,
}: {
  order: Order;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: priceList } = useListPriceList({
    query: { queryKey: getListPriceListQueryKey() },
  });
  const { data: settings } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });
  const { data: pricing, isLoading } = useGetOrderLineItems(order.id, {
    query: { queryKey: getGetOrderLineItemsQueryKey(order.id), enabled: open },
  });

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideInput, setOverrideInput] = useState("");

  // Hydrate the form from server state every time the dialog opens (or the
  // order id changes). Resetting on close would lose mid-edit state if the
  // user accidentally clicks outside.
  useEffect(() => {
    if (!open) return;
    if (!pricing) return;
    setLines(
      pricing.lines.length > 0
        ? pricing.lines.map((l) => ({
            key: makeKey(),
            priceListId: l.priceListId ?? null,
            itemName: l.itemName,
            qtyInput: String(l.quantity),
            priceInput: (l.unitPriceCents / 100).toFixed(2),
            isOverride: l.isOverride,
          }))
        : [],
    );
    setOverrideEnabled(order.totalWasOverridden);
    setOverrideInput(
      order.totalOverrideCents != null ? (order.totalOverrideCents / 100).toFixed(2) : "",
    );
  }, [open, pricing, order.id, order.totalWasOverridden, order.totalOverrideCents]);

  const activePriceList = useMemo(
    () => (priceList ?? []).filter((i) => i.active),
    [priceList],
  );

  // Computed totals on each render — single source of truth, no need to track
  // a "totals" piece of state that can drift from the lines.
  const itemsSubtotalCents = lines.reduce((sum, l) => {
    const qty = parseInt(l.qtyInput, 10);
    const price = parseDollarsToCents(l.priceInput);
    if (Number.isNaN(qty) || price == null) return sum;
    return sum + qty * price;
  }, 0);
  const feeCents = order.feeCentsSnapshot ?? settings?.feeCents ?? 600;
  const overrideCents = overrideEnabled ? parseDollarsToCents(overrideInput) : null;
  const grandTotalCents =
    overrideEnabled && overrideCents != null
      ? overrideCents
      : itemsSubtotalCents + feeCents;
  const belowMinimum =
    settings != null && lines.length > 0 && grandTotalCents < settings.orderMinimumCents;

  const replace = useReplaceOrderLineItems({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getListOrdersQueryKey() });
        qc.invalidateQueries({ queryKey: getGetOrderLineItemsQueryKey(order.id) });
        if (result.receiptSent) {
          toast.success("Saved and receipt sent");
        } else if (result.receiptSkippedReason) {
          toast.warning(`Saved, but receipt not sent: ${result.receiptSkippedReason}`);
        } else {
          toast.success("Saved (no receipt sent)");
        }
        onOpenChange(false);
      },
      onError: () => toast.error("Could not save"),
    },
  });

  function addLine(priceListId?: number) {
    const picked = activePriceList.find((i) => i.id === priceListId);
    setLines((prev) => [
      ...prev,
      {
        key: makeKey(),
        priceListId: picked?.id ?? null,
        itemName: picked?.name ?? "",
        qtyInput: "1",
        priceInput: picked ? (picked.priceCents / 100).toFixed(2) : "",
        isOverride: false,
      },
    ]);
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function handleSave(sendReceipt: boolean) {
    const payload: LineItemInput[] = [];
    for (const [i, l] of lines.entries()) {
      const qty = parseInt(l.qtyInput, 10);
      const price = parseDollarsToCents(l.priceInput);
      const name = l.itemName.trim();
      if (!name) {
        toast.error(`Line ${i + 1}: item name required`);
        return;
      }
      if (!Number.isInteger(qty) || qty < 1) {
        toast.error(`Line ${i + 1}: qty must be a positive whole number`);
        return;
      }
      if (price == null) {
        toast.error(`Line ${i + 1}: price must look like 4.00`);
        return;
      }
      payload.push({
        priceListId: l.priceListId,
        itemName: name,
        quantity: qty,
        unitPriceCents: price,
        isOverride: l.isOverride,
        sortOrder: i * 10,
      });
    }
    let totalOverride: number | null = null;
    if (overrideEnabled) {
      const parsed = parseDollarsToCents(overrideInput);
      if (parsed == null) {
        toast.error("Override total must look like 35.00");
        return;
      }
      totalOverride = parsed;
    }
    replace.mutate({
      id: order.id,
      data: { lines: payload, totalOverrideCents: totalOverride, sendReceipt },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Receipt className="w-5 h-5" />
            Price order {order.orderNumber}
          </DialogTitle>
          <DialogDescription>
            {order.name} · {order.colony} · Unit {order.unitNumber}
            {order.pricedAt ? (
              <span className="ml-2 text-xs text-muted-foreground">
                (Saving will text the customer a fresh receipt.)
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground italic py-4 text-center">
                  No line items yet — add the customer's items below.
                </p>
              ) : null}
              {lines.map((l) => (
                <div key={l.key} className="flex items-end gap-2 p-2 rounded border bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <Label className="text-xs">Item</Label>
                    <Select
                      value={l.priceListId ? String(l.priceListId) : "__custom__"}
                      onValueChange={(v) => {
                        if (v === "__custom__") {
                          updateLine(l.key, { priceListId: null });
                          return;
                        }
                        const id = parseInt(v, 10);
                        const picked = activePriceList.find((p) => p.id === id);
                        updateLine(l.key, {
                          priceListId: id,
                          itemName: picked?.name ?? l.itemName,
                          priceInput: picked ? (picked.priceCents / 100).toFixed(2) : l.priceInput,
                          isOverride: false,
                        });
                      }}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue placeholder="Pick an item" />
                      </SelectTrigger>
                      <SelectContent>
                        {activePriceList.map((p) => (
                          <SelectItem key={p.id} value={String(p.id)}>
                            {p.name} ({formatCents(p.priceCents)})
                          </SelectItem>
                        ))}
                        <SelectItem value="__custom__">Custom…</SelectItem>
                      </SelectContent>
                    </Select>
                    {l.priceListId == null ? (
                      <Input
                        value={l.itemName}
                        onChange={(e) => updateLine(l.key, { itemName: e.target.value })}
                        placeholder="Item name"
                        className="h-8 mt-1"
                      />
                    ) : null}
                  </div>
                  <div className="w-14">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      value={l.qtyInput}
                      onChange={(e) => updateLine(l.key, { qtyInput: e.target.value })}
                      inputMode="numeric"
                      className="h-8"
                    />
                  </div>
                  <div className="w-24">
                    <Label className="text-xs">
                      Price{" "}
                      {l.isOverride ? (
                        <span className="text-amber-600 font-semibold">(override)</span>
                      ) : null}
                    </Label>
                    <Input
                      value={l.priceInput}
                      onChange={(e) =>
                        updateLine(l.key, { priceInput: e.target.value, isOverride: true })
                      }
                      inputMode="decimal"
                      className="h-8"
                    />
                  </div>
                  <div className="w-20 text-right text-sm font-medium pb-1">
                    {(() => {
                      const q = parseInt(l.qtyInput, 10);
                      const p = parseDollarsToCents(l.priceInput);
                      if (Number.isNaN(q) || p == null) return "—";
                      return formatCents(q * p);
                    })()}
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    onClick={() => removeLine(l.key)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2 flex-wrap">
                <Button size="sm" variant="outline" onClick={() => addLine()}>
                  <Plus className="w-4 h-4 mr-1" /> Add line
                </Button>
                {activePriceList.slice(0, 6).map((p) => (
                  <Button
                    key={p.id}
                    size="sm"
                    variant="ghost"
                    className="text-xs"
                    onClick={() => addLine(p.id)}
                  >
                    + {p.name}
                  </Button>
                ))}
              </div>
            </div>

            <div className="border-t pt-4 space-y-2 bg-muted/20 -mx-6 px-6 py-4">
              <div className="flex justify-between text-sm">
                <span>Items subtotal</span>
                <span>{formatCents(itemsSubtotalCents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Pickup &amp; delivery</span>
                <span>{formatCents(feeCents)}</span>
              </div>
              <div className="flex items-center gap-2 pt-2 border-t">
                <Switch checked={overrideEnabled} onCheckedChange={setOverrideEnabled} />
                <Label className="text-sm">Override grand total</Label>
                {overrideEnabled ? (
                  <div className="flex items-center gap-1 ml-auto">
                    <span className="text-muted-foreground">$</span>
                    <Input
                      value={overrideInput}
                      onChange={(e) => setOverrideInput(e.target.value)}
                      inputMode="decimal"
                      className="h-8 w-24"
                    />
                  </div>
                ) : null}
              </div>
              <div className="flex justify-between text-base font-bold pt-2 border-t">
                <span>Grand total</span>
                <span>{formatCents(grandTotalCents)}</span>
              </div>
              {belowMinimum ? (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Below order minimum ({formatCents(settings?.orderMinimumCents ?? 0)}). Saving
                  anyway is allowed.
                </p>
              ) : null}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={replace.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleSave(false)}
            disabled={replace.isPending || lines.length === 0}
            title="Save without texting the customer"
          >
            Save draft
          </Button>
          <Button
            onClick={() => handleSave(true)}
            disabled={replace.isPending || lines.length === 0}
          >
            {replace.isPending ? "Saving…" : "Save & send receipt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
