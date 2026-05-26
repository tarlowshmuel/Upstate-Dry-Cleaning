import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateOrder,
  useListTowns,
  getListOrdersQueryKey,
} from "@workspace/api-client-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { toast } from "sonner";

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
  pickupDate: "",
});

export function NewOrderDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [pickupTouched, setPickupTouched] = useState(false);
  const qc = useQueryClient();
  const { mutateAsync, isPending } = useCreateOrder();
  const { data: towns, isLoading: townsLoading, isError: townsError, refetch: refetchTowns } = useListTowns();

  function update<K extends keyof ReturnType<typeof emptyForm>>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Pick the next pickup date from the town's schedule. Only auto-fill if the
  // admin hasn't manually overridden the date — that way picking the town
  // first (the common case) gets the right date, but a deliberate edit isn't
  // clobbered if they change the town afterwards.
  function onTownChange(town: string) {
    setForm((f) => {
      const next: typeof f = { ...f, town };
      const sched = towns?.find((t) => t.name === town);
      if (sched?.nextPickupDate && !pickupTouched) {
        next.pickupDate = sched.nextPickupDate;
      }
      return next;
    });
  }

  const selectedTownSchedule = towns?.find((t) => t.name === form.town);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.town) {
      toast.error("Please pick a town");
      return;
    }
    if (form.pickupDate) {
      const [y, m, d] = form.pickupDate.split("-").map(Number);
      const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
      if (dow < 1 || dow > 4) {
        toast.error("Pickups only run Monday–Thursday");
        return;
      }
    }
    try {
      await mutateAsync({
        data: {
          name: form.name.trim(),
          phoneNumber: form.phoneNumber.trim(),
          town: form.town.trim(),
          colony: form.colony.trim(),
          colonyAddress: form.colonyAddress.trim(),
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
      setPickupTouched(false);
      setOpen(false);
    } catch (err) {
      toast.error("Failed to create order");
      console.error(err);
    }
  }

  const required =
    form.name && form.phoneNumber && form.town && form.colony && form.unitNumber && form.colonyAddress;

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
              <Select value={form.town} onValueChange={onTownChange} disabled={townsLoading || townsError}>
                <SelectTrigger id="no-town">
                  <SelectValue
                    placeholder={
                      townsLoading ? "Loading towns…" : townsError ? "Failed to load" : "Pick a town"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(towns ?? []).map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}{" "}
                      <span className="text-xs text-muted-foreground">
                        ({t.pickupDay}s)
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {townsError ? (
                <button
                  type="button"
                  onClick={() => refetchTowns()}
                  className="text-xs text-destructive underline"
                >
                  Retry loading towns
                </button>
              ) : null}
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
              <Label htmlFor="no-pickup">
                Pickup date
                {selectedTownSchedule && !pickupTouched && form.pickupDate ? (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    (auto · next {selectedTownSchedule.pickupDay})
                  </span>
                ) : (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    (Mon–Thu only)
                  </span>
                )}
              </Label>
              <Input
                id="no-pickup"
                type="date"
                value={form.pickupDate}
                onChange={(e) => {
                  setPickupTouched(true);
                  update("pickupDate", e.target.value);
                }}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="no-addr">Colony address *</Label>
            <Input
              id="no-addr"
              placeholder="e.g. 123 Main St"
              value={form.colonyAddress}
              onChange={(e) => update("colonyAddress", e.target.value)}
              required
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
