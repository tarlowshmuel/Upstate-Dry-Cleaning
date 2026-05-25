import {
  useListOrders,
  getListOrdersQueryKey,
  useUpdateOrderStatus,
  useUpdateOrderPaid,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { format } from "date-fns";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Shirt, Phone, MapPin, Clock, Key, Inbox, Hash, Package, DollarSign, CircleDashed, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RoutePanel } from "@/components/route-panel";

function ItemsList({ text }: { text: string | null | undefined }) {
  if (!text || !text.trim()) return <span className="text-muted-foreground/40 text-sm">—</span>;
  return <span className="text-xs text-foreground">{text}</span>;
}

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "picked_up", label: "Picked Up" },
  { value: "delivered", label: "Delivered" },
  { value: "missed", label: "Missed" },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  picked_up: "bg-blue-100 text-blue-800 border-blue-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  missed: "bg-red-100 text-red-800 border-red-200",
};

function rowClass(order: { status: string; paid: boolean }): string {
  const complete = order.status === "delivered" && order.paid;
  const missed = order.status === "missed";
  if (complete) {
    return "bg-emerald-50/70 hover:bg-emerald-100/70 border-l-4 border-l-emerald-500";
  }
  if (missed) {
    return "bg-red-50/60 hover:bg-red-100/60 border-l-4 border-l-red-500";
  }
  // unfinished — soft amber tint
  return "bg-amber-50/40 hover:bg-amber-50/70 border-l-4 border-l-amber-400";
}

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground border-border";
  const label = STATUSES.find((s) => s.value === status)?.label ?? status;
  return (
    <Badge variant="outline" className={`font-medium border ${cls}`}>
      {label}
    </Badge>
  );
}

function PaidToggle({ orderId, paid }: { orderId: number; paid: boolean }) {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useUpdateOrderPaid({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      },
    },
  });

  return (
    <Button
      size="sm"
      variant={paid ? "default" : "outline"}
      disabled={isPending}
      onClick={() => mutate({ id: orderId, data: { paid: !paid } })}
      className={
        paid
          ? "h-8 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600"
          : "h-8 gap-1.5 border-border/60 text-muted-foreground hover:text-foreground"
      }
    >
      {paid ? (
        <>
          <CheckCircle2 className="w-3.5 h-3.5" />
          Paid
        </>
      ) : (
        <>
          <CircleDashed className="w-3.5 h-3.5" />
          Unpaid
        </>
      )}
    </Button>
  );
}

function StatusSelect({
  orderId,
  current,
}: {
  orderId: number;
  current: string;
}) {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useUpdateOrderStatus({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      },
    },
  });

  return (
    <Select
      value={current}
      disabled={isPending}
      onValueChange={(status) =>
        mutate({ id: orderId, data: { status } })
      }
    >
      <SelectTrigger className="h-8 w-[130px] text-xs border-border/60 bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s.value} value={s.value} className="text-xs">
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Dashboard() {
  const { data: orders, isLoading, isError } = useListOrders({
    query: { queryKey: getListOrdersQueryKey() },
  });

  const [range, setRange] = useState<"today" | "week" | "all">("all");

  const today = todayDateString();
  const todaysPickups = orders?.filter((o) => o.status === "pending" && o.pickupDate === today) ?? [];

  const filteredOrders = (orders ?? []).filter((o) => {
    if (range === "all") return true;
    if (!o.pickupDate) return false;
    if (range === "today") return o.pickupDate === today;
    if (range === "week") {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const min = new Date(now); min.setDate(min.getDate() - 7);
      const max = new Date(now); max.setDate(max.getDate() + 7);
      const p = new Date(o.pickupDate + "T00:00:00");
      return p >= min && p <= max;
    }
    return true;
  });

  const counts = orders
    ? {
        pending: orders.filter((o) => o.status === "pending").length,
        picked_up: orders.filter((o) => o.status === "picked_up").length,
        total: orders.length,
        todaysPickups: todaysPickups.length,
        unpaid: orders.filter((o) => !o.paid).length,
      }
    : null;

  return (
    <div className="min-h-screen w-full bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-700">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground font-serif">
              Operations
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Dry cleaning pickup management
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 border border-border/50 px-3 py-2 rounded-md font-mono">
              <Phone className="w-3.5 h-3.5 text-primary" />
              Text <span className="text-foreground font-semibold mx-1">"clean"</span> to your Twilio number
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/admin/logout`, {
                  method: "POST",
                  credentials: "include",
                });
                window.location.reload();
              }}
            >
              Sign out
            </Button>
          </div>
        </header>

        {/* Summary strip */}
        {counts && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: "Today's Pickups", value: counts.todaysPickups, color: "text-primary" },
              { label: "Total Orders", value: counts.total, color: "text-foreground" },
              { label: "Pending", value: counts.pending, color: "text-amber-600" },
              { label: "At Cleaners", value: counts.picked_up, color: "text-blue-600" },
              { label: "Unpaid", value: counts.unpaid, color: "text-rose-600" },
            ].map((stat) => (
              <Card key={stat.label} className="border-border/50 shadow-sm">
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{stat.label}</p>
                  <p className={`text-3xl font-bold font-serif mt-1 ${stat.color}`}>{stat.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Optimized route */}
        <RoutePanel />

        {/* Orders table */}
        <Card className="border-border/60 shadow-sm overflow-hidden">
          <CardHeader className="bg-muted/30 border-b border-border/50 py-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="space-y-1">
                <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
                  <Shirt className="w-4 h-4 text-primary" />
                  Orders
                  <span className="text-xs font-normal text-muted-foreground ml-1">
                    ({filteredOrders.length}
                    {orders && filteredOrders.length !== orders.length ? ` of ${orders.length}` : ""})
                  </span>
                </CardTitle>
                <CardDescription className="text-xs">
                  ID numbers shown here are the same IDs used in the SMS admin menu (text <span className="font-mono text-foreground">menu</span> to your Twilio number).
                </CardDescription>
              </div>
              <ToggleGroup
                type="single"
                value={range}
                onValueChange={(v) => v && setRange(v as "today" | "week" | "all")}
                className="bg-background border border-border/60 rounded-md p-0.5"
              >
                <ToggleGroupItem value="today" className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                  Today
                </ToggleGroupItem>
                <ToggleGroupItem value="week" className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                  This Week
                </ToggleGroupItem>
                <ToggleGroupItem value="all" className="h-8 px-3 text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
                  All Time
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-14 w-full rounded-md opacity-50" />
                ))}
              </div>
            ) : isError ? (
              <div className="p-12 text-center flex flex-col items-center justify-center text-destructive">
                <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                  <span className="font-bold">!</span>
                </div>
                <p className="font-medium text-sm">Failed to load orders. Refresh to retry.</p>
              </div>
            ) : !orders || orders.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-16 text-center animate-in fade-in zoom-in duration-500">
                <div className="w-14 h-14 bg-primary/10 rounded-full flex items-center justify-center mb-4 border border-primary/20">
                  <Inbox className="w-7 h-7 text-primary" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2 font-serif">No orders yet</h3>
                <p className="text-muted-foreground max-w-sm text-sm">
                  When customers text <span className="font-mono text-foreground">"clean"</span> to your Twilio number, orders appear here instantly.
                </p>
              </div>
            ) : filteredOrders.length === 0 ? (
              <div className="flex flex-col items-center justify-center p-16 text-center">
                <div className="w-14 h-14 bg-muted rounded-full flex items-center justify-center mb-4">
                  <Inbox className="w-7 h-7 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2 font-serif">No orders in this range</h3>
                <p className="text-muted-foreground max-w-sm text-sm">
                  Try a wider time range to see more orders.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-b border-border/60">
                      {["ID", "Order", "Customer", "Location", "Items", "Access", "Status", "Paid", "Pickup"].map((h) => (
                        <TableHead key={h} className="font-medium text-xs uppercase tracking-wider text-muted-foreground py-3">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredOrders.map((order) => (
                      <TableRow
                        key={order.id}
                        className={`transition-colors group border-b border-border/40 last:border-0 ${rowClass(order)}`}
                      >
                        {/* ID */}
                        <TableCell className="py-4 w-[56px]">
                          <span className="inline-flex items-center gap-1 font-mono text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                            <Hash className="w-3 h-3" />
                            {order.id}
                          </span>
                        </TableCell>

                        {/* Order number */}
                        <TableCell className="py-4 w-[120px]">
                          <span className="font-mono text-sm text-foreground tracking-tight">
                            {order.orderNumber}
                          </span>
                        </TableCell>

                        {/* Customer */}
                        <TableCell className="py-4">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-foreground text-sm">{order.name}</span>
                            <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                              <Phone className="w-3 h-3 text-primary/60" />
                              {order.phoneNumber}
                            </span>
                          </div>
                        </TableCell>

                        {/* Location */}
                        <TableCell className="py-4">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-sm text-foreground">
                              {order.colony}{order.unitNumber ? `, Unit ${order.unitNumber}` : ""}
                            </span>
                            {order.colonyAddress && (
                              <span className="text-xs text-muted-foreground">{order.colonyAddress}</span>
                            )}
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-primary/60" />
                              {order.town}
                            </span>
                          </div>
                        </TableCell>

                        {/* Items */}
                        <TableCell className="py-4 max-w-[200px]">
                          <div className="flex items-start gap-1.5">
                            <Package className="w-3 h-3 text-primary/60 mt-0.5 shrink-0" />
                            <ItemsList text={order.items} />
                          </div>
                        </TableCell>

                        {/* Gate access */}
                        <TableCell className="py-4 w-[120px]">
                          {order.gateAccess ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium bg-secondary px-2 py-1 rounded border border-border/50">
                              <Key className="w-3 h-3 text-muted-foreground" />
                              {order.gateAccess}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40 text-sm">—</span>
                          )}
                        </TableCell>

                        {/* Status */}
                        <TableCell className="py-4 w-[150px]">
                          <div className="flex flex-col gap-1.5">
                            <StatusBadge status={order.status} />
                            <StatusSelect orderId={order.id} current={order.status} />
                          </div>
                        </TableCell>

                        {/* Paid toggle */}
                        <TableCell className="py-4 w-[110px]">
                          <PaidToggle orderId={order.id} paid={order.paid} />
                        </TableCell>

                        {/* Pickup date */}
                        <TableCell className="py-4 w-[140px]">
                          <div className="flex flex-col gap-0.5 items-start">
                            {order.pickupDate ? (
                              <span className="text-sm font-medium text-foreground">
                                {format(new Date(order.pickupDate + "T00:00:00"), "EEE, MMM d")}
                              </span>
                            ) : (
                              <span className="text-sm text-muted-foreground/60">—</span>
                            )}
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3 text-primary/60" />
                              Ordered {format(new Date(order.createdAt), "MMM d")}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* SMS reference */}
        <Card className="border-border/50 shadow-sm bg-muted/20">
          <CardContent className="p-4">
            <div className="flex items-baseline justify-between mb-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Admin SMS Menu</p>
              <p className="text-xs text-muted-foreground">
                Text <span className="font-mono text-foreground">menu</span> to your Twilio number — reply with numbers to navigate.
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { num: "1", label: "Today's pickups", desc: "Orders scheduled today" },
                { num: "2", label: "Orders at cleaners", desc: "Picked up, awaiting return" },
                { num: "3", label: "Pending orders", desc: "All not-yet-picked-up" },
                { num: "4", label: "Unpaid orders", desc: "Owe money" },
                { num: "5", label: "Today's route", desc: "Stops in driving order with addresses" },
                { num: "6", label: "Stats", desc: "Today / week / all-time totals" },
                { num: "7", label: "Look up an order", desc: "Search by name, phone, or ID" },
                { num: "8", label: "Update an order", desc: "Search then mark picked up / paid / etc." },
              ].map(({ num, label, desc }) => (
                <div key={num} className="flex gap-2 items-start">
                  <span className="flex-shrink-0 w-6 h-6 rounded-md bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">
                    {num}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs text-foreground font-semibold">{label}</span>
                    <span className="text-xs text-muted-foreground">{desc}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border/40">
              Reply <span className="font-mono text-foreground">0</span> or <span className="font-mono text-foreground">menu</span> at any time to return to the main menu.
            </p>
          </CardContent>
        </Card>

        <footer className="mt-6 pb-4 text-center text-xs text-muted-foreground">
          <a href="legal" className="hover:text-foreground underline-offset-4 hover:underline">
            Privacy Policy &amp; Terms of Service
          </a>
        </footer>
      </div>
    </div>
  );
}
