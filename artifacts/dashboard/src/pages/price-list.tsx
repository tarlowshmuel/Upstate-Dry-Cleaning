import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListPriceList,
  useCreatePriceListItem,
  useUpdatePriceListItem,
  useDeactivatePriceListItem,
  getListPriceListQueryKey,
  type PriceListItem,
} from "@workspace/api-client-react";
import { SiteNav } from "@/components/site-nav";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatCents, parseDollarsToCents } from "@/lib/money";

function PriceRow({ item }: { item: PriceListItem }) {
  const qc = useQueryClient();
  const [name, setName] = useState(item.name);
  const [priceInput, setPriceInput] = useState((item.priceCents / 100).toFixed(2));
  const update = useUpdatePriceListItem({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getListPriceListQueryKey() }),
      onError: () => toast.error("Could not save"),
    },
  });
  const deactivate = useDeactivatePriceListItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListPriceListQueryKey() });
        toast.success(`${item.name} hidden`);
      },
    },
  });

  const dirty =
    name.trim() !== item.name || parseDollarsToCents(priceInput) !== item.priceCents;

  return (
    <TableRow className={item.active ? "" : "opacity-50"}>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 max-w-[180px]"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">$</span>
          <Input
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            inputMode="decimal"
            className="h-8 w-24"
          />
        </div>
      </TableCell>
      <TableCell>
        <Switch
          checked={item.active}
          onCheckedChange={(checked) =>
            update.mutate({ id: item.id, data: { active: checked } })
          }
        />
      </TableCell>
      <TableCell className="text-right space-x-2">
        <Button
          size="sm"
          disabled={!dirty || update.isPending}
          onClick={() => {
            const priceCents = parseDollarsToCents(priceInput);
            if (priceCents == null) {
              toast.error("Enter a valid price like 4.00");
              return;
            }
            const trimmed = name.trim();
            if (!trimmed) {
              toast.error("Name can't be empty");
              return;
            }
            update.mutate({
              id: item.id,
              data: { name: trimmed, priceCents },
            });
          }}
        >
          Save
        </Button>
        {item.active ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={deactivate.isPending}
            onClick={() => deactivate.mutate({ id: item.id })}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function AddItemRow() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const create = useCreatePriceListItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListPriceListQueryKey() });
        setName("");
        setPriceInput("");
        toast.success("Item added");
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Could not add";
        toast.error(msg.includes("409") ? "An item with that name already exists" : "Could not add item");
      },
    },
  });

  return (
    <TableRow className="bg-muted/40">
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New item name…"
          className="h-8 max-w-[180px]"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">$</span>
          <Input
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className="h-8 w-24"
          />
        </div>
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <Button
          size="sm"
          disabled={create.isPending}
          onClick={() => {
            const priceCents = parseDollarsToCents(priceInput);
            const trimmed = name.trim();
            if (!trimmed || priceCents == null) {
              toast.error("Enter a name and a price");
              return;
            }
            create.mutate({ data: { name: trimmed, priceCents } });
          }}
        >
          <Plus className="w-4 h-4 mr-1" /> Add
        </Button>
      </TableCell>
    </TableRow>
  );
}

export default function PriceListPage() {
  const { data, isLoading } = useListPriceList({
    query: { queryKey: getListPriceListQueryKey() },
  });
  return (
    <div className="max-w-4xl mx-auto p-6">
      <SiteNav />
      <Card>
        <CardHeader>
          <CardTitle>Price List</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            These prices apply to <em>new</em> pricing entries. Past orders keep
            their snapshotted prices and are never changed by edits here.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((item) => (
                  <PriceRow key={item.id} item={item} />
                ))}
                <AddItemRow />
              </TableBody>
            </Table>
          )}
          <p className="px-6 py-3 text-xs text-muted-foreground border-t">
            Current ({(data ?? []).filter((i) => i.active).length} active):{" "}
            {(data ?? [])
              .filter((i) => i.active)
              .map((i) => `${i.name} ${formatCents(i.priceCents)}`)
              .join(" · ")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
