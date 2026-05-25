import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateOrder, getListOrdersQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { toast } from "sonner";

function tomorrowDateString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const emptyForm = () => ({
  name: "",
  phoneNumber: "",
  town: "",
  colony: "",
  colonyAddress: "",
  unitNumber: "",
  gateAccess: "",
  items: "",
  notes: "",
  pickupDate: tomorrowDateString(),
});

export function NewOrderDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const qc = useQueryClient();
  const { mutateAsync, isPending } = useCreateOrder();

  function update<K extends keyof ReturnType<typeof emptyForm>>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await mutateAsync({
        data: {
          name: form.name.trim(),
          phoneNumber: form.phoneNumber.trim(),
          town: form.town.trim(),
          colony: form.colony.trim(),
          colonyAddress: form.colonyAddress.trim() || null,
          unitNumber: form.unitNumber.trim(),
          gateAccess: form.gateAccess.trim() || null,
          items: form.items.trim() || null,
          notes: form.notes.trim() || null,
          pickupDate: form.pickupDate || null,
        },
      });
      await qc.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      await qc.invalidateQueries({ queryKey: ["route", "today"] });
      toast.success("Order created");
      setForm(emptyForm());
      setOpen(false);
    } catch (err) {
      toast.error("Failed to create order");
      console.error(err);
    }
  }

  const required = form.name && form.phoneNumber && form.town && form.colony && form.unitNumber;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="w-4 h-4" /> New Order
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Pickup Order</DialogTitle>
          <DialogDescription>
            Manually create an order on behalf of a customer.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="no-name">Name *</Label>
              <Input id="no-name" value={form.name} onChange={(e) => update("name", e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="no-phone">Phone *</Label>
              <Input
                id="no-phone"
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
              <Label htmlFor="no-town">Town *</Label>
              <Input id="no-town" value={form.town} onChange={(e) => update("town", e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="no-colony">Colony *</Label>
              <Input id="no-colony" value={form.colony} onChange={(e) => update("colony", e.target.value)} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="no-unit">Unit # *</Label>
              <Input id="no-unit" value={form.unitNumber} onChange={(e) => update("unitNumber", e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="no-pickup">Pickup date</Label>
              <Input
                id="no-pickup"
                type="date"
                value={form.pickupDate}
                onChange={(e) => update("pickupDate", e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="no-addr">Colony address (optional)</Label>
            <Input
              id="no-addr"
              placeholder="e.g. 458 Riverside Dr"
              value={form.colonyAddress}
              onChange={(e) => update("colonyAddress", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="no-gate">Gate access (optional)</Label>
            <Input id="no-gate" value={form.gateAccess} onChange={(e) => update("gateAccess", e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="no-items">Items</Label>
            <Textarea
              id="no-items"
              rows={2}
              placeholder="e.g. 2 suits, 3 shirts, 1 coat"
              value={form.items}
              onChange={(e) => update("items", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="no-notes">Notes</Label>
            <Textarea
              id="no-notes"
              rows={2}
              placeholder="Driver instructions"
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!required || isPending}>
              {isPending ? "Creating…" : "Create order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
