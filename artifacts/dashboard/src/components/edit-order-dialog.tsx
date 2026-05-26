import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateOrder,
  useDeleteOrder,
  getListOrdersQueryKey,
  type Order,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

type FormState = {
  name: string;
  phoneNumber: string;
  town: string;
  colony: string;
  colonyAddress: string;
  unitNumber: string;
  gateAccess: string;
  items: string;
  notes: string;
  pickupDate: string;
};

function fromOrder(o: Order): FormState {
  return {
    name: o.name ?? "",
    phoneNumber: o.phoneNumber ?? "",
    town: o.town ?? "",
    colony: o.colony ?? "",
    colonyAddress: o.colonyAddress ?? "",
    unitNumber: o.unitNumber ?? "",
    gateAccess: o.gateAccess ?? "",
    items: o.items ?? "",
    notes: o.notes ?? "",
    pickupDate: o.pickupDate ?? "",
  };
}

export function EditOrderDialog({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() => fromOrder(order));
  const qc = useQueryClient();
  const { mutateAsync, isPending } = useUpdateOrder();
  const { mutateAsync: deleteOrder, isPending: isDeleting } = useDeleteOrder();

  async function handleDelete() {
    try {
      await deleteOrder({ id: order.id });
      await qc.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      // Prefix-match all route variants — RoutePanel keys are
      // ["route", date, direction, wave], so "route" prefix invalidates them all.
      await qc.invalidateQueries({ queryKey: ["route"] });
      toast.success(`Order #${order.id} removed`);
      setOpen(false);
    } catch (err) {
      toast.error("Failed to remove order");
      console.error(err);
    }
  }

  // Re-sync from props whenever the dialog is opened so the user sees the
  // latest server state, not stale data from a previous open.
  useEffect(() => {
    if (open) setForm(fromOrder(order));
  }, [open, order]);

  function update<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Send only the fields the user actually changed since opening the
    // dialog. Avoids two problems: (1) lost-update — clobbering an SMS edit
    // that landed while the dialog was open; (2) re-validation failures on
    // legacy records whose existing phone/address don't match the stricter
    // PATCH schema even though we never edited them.
    const initial = fromOrder(order);
    const normalize = (s: string, nullable: boolean): string | null =>
      nullable ? (s.trim() || null) : s.trim();
    const fields = [
      ["name", false], ["phoneNumber", false], ["town", false],
      ["colony", false], ["unitNumber", false],
      ["colonyAddress", true], ["gateAccess", true],
      ["items", true], ["notes", true],
    ] as const;
    const diff: Record<string, string | null> = {};
    for (const [k, nullable] of fields) {
      const next = normalize(form[k], nullable);
      const prev = normalize(initial[k], nullable);
      if (next !== prev) diff[k] = next;
    }
    // pickupDate already stored as YYYY-MM-DD or "" — treat "" as null.
    const nextPickup = form.pickupDate || null;
    const prevPickup = initial.pickupDate || null;
    if (nextPickup !== prevPickup) diff.pickupDate = nextPickup;

    if (Object.keys(diff).length === 0) {
      toast.info("No changes to save");
      setOpen(false);
      return;
    }
    try {
      await mutateAsync({ id: order.id, data: diff });
      await qc.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      await qc.invalidateQueries({ queryKey: ["route"] });
      toast.success(`Order #${order.id} updated`);
      setOpen(false);
    } catch (err) {
      toast.error("Failed to update order");
      console.error(err);
    }
  }

  const required = form.name && form.phoneNumber && form.town && form.colony && form.unitNumber;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
        onClick={() => setOpen(true)}
        title={`Edit order #${order.id}`}
      >
        <Pencil className="w-3.5 h-3.5" />
      </Button>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit order #{order.id} — {order.orderNumber}</DialogTitle>
          <DialogDescription>
            Update any field. Order number, status, and paid flag are managed separately.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="eo-name">Name *</Label>
              <Input id="eo-name" value={form.name} onChange={(e) => update("name", e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eo-phone">Phone *</Label>
              <Input
                id="eo-phone"
                type="tel"
                placeholder="+19293450940"
                value={form.phoneNumber}
                onChange={(e) => update("phoneNumber", e.target.value)}
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="eo-town">Town *</Label>
              <Input id="eo-town" value={form.town} onChange={(e) => update("town", e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eo-colony">Colony *</Label>
              <Input id="eo-colony" value={form.colony} onChange={(e) => update("colony", e.target.value)} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="eo-unit">Unit # *</Label>
              <Input id="eo-unit" value={form.unitNumber} onChange={(e) => update("unitNumber", e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eo-pickup">Pickup date</Label>
              <Input
                id="eo-pickup"
                type="date"
                value={form.pickupDate}
                onChange={(e) => update("pickupDate", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="eo-addr">Colony address (optional)</Label>
            <Input
              id="eo-addr"
              placeholder="e.g. 458 Riverside Dr"
              value={form.colonyAddress}
              onChange={(e) => update("colonyAddress", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="eo-gate">Gate access (optional)</Label>
            <Input id="eo-gate" value={form.gateAccess} onChange={(e) => update("gateAccess", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="eo-items">Items</Label>
            <Textarea
              id="eo-items"
              rows={2}
              placeholder="e.g. 2 suits, 3 shirts, 1 coat"
              value={form.items}
              onChange={(e) => update("items", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="eo-notes">Notes</Label>
            <Textarea
              id="eo-notes"
              rows={2}
              placeholder="Driver instructions"
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
            />
          </div>
          <DialogFooter className="flex-row sm:justify-between gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={isPending || isDeleting}
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove order #{order.id}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes order <span className="font-mono">{order.orderNumber}</span> for{" "}
                    <span className="font-semibold">{order.name}</span>. The customer will <strong>not</strong> be
                    notified. This can&apos;t be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    disabled={isDeleting}
                    className="bg-destructive text-white hover:bg-destructive/90"
                  >
                    {isDeleting ? "Removing…" : "Yes, remove"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!required || isPending || isDeleting}>
                {isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
