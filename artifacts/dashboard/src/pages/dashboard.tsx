import {
  useListOrders,
  getListOrdersQueryKey,
  useUpdateOrderStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
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
import { Shirt, Phone, MapPin, Clock, Key, Inbox, Hash, Package, Navigation } from "lucide-react";
import { Button } from "@/components/ui/button";

function ItemsList({ text }: { text: string | null | undefined }) {
  if (!text || !text.trim()) return <span className="text-muted-foreground/40 text-sm">—</span>;
  return <span className="text-xs text-foreground">{text}</span>;
}

const DRIVER_START = "458 Riverside Drive, Sullivan County, NY";

function buildRouteUrl(orders: Array<{ colonyAddress: string | null; colony: string; town: string }>): string {
  const waypoints = orders
    .map((o) => [o.colonyAddress, o.colony, o.town, "NY"].filter(Boolean).join(", "))
    .map(encodeURIComponent)
    .join("|");
  const origin = encodeURIComponent(DRIVER_START);
  const destination = encodeURIComponent(DRIVER_START);
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&waypoints=${waypoints}&travelmode=driving`;
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
  { value: "paid", label: "Paid" },
  { value: "missed", label: "Missed" },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  picked_up: "bg-blue-100 text-blue-800 border-blue-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  paid: "bg-violet-100 text-violet-800 border-violet-200",
  missed: "bg-red-100 text-red-800 border-red-200",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "bg-muted text-muted-foreground border-border";
  const label = STATUSES.find((s) => s.value === status)?.label ?? status;
  return (
    <Badge variant="outline" className={`font-medium border ${cls}`}>
      {label}
    </Badge>
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

  const today = todayDateString();
  const todaysPickups = orders?.filter((o) => o.status === "pending" && o.pickupDate === today) ?? [];
  const routeUrl = todaysPickups.length > 0 ? buildRouteUrl(todaysPickups) : null;

  const counts = orders
    ? {
        pending: orders.filter((o) => o.status === "pending").length,
        picked_up: orders.filter((o) => o.status === "picked_up").length,
        total: orders.length,
        todaysPickups: todaysPickups.length,
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
            {routeUrl && (
              <Button
                asChild
                size="sm"
                className="gap-2"
              >
                <a href={routeUrl} target="_blank" rel="noopener noreferrer">
                  <Navigation className="w-4 h-4" />
                  Today's Route ({todaysPickups.length})
                </a>
              </Button>
            )}
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 border border-border/50 px-3 py-2 rounded-md font-mono">
              <Phone className="w-3.5 h-3.5 text-primary" />
              Text <span className="text-foreground font-semibold mx-1">"clean"</span> to your Twilio number
            </div>
          </div>
        </header>

        {/* Summary strip */}
        {counts && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Today's Pickups", value: counts.todaysPickups, color: "text-primary" },
              { label: "Total Orders", value: counts.total, color: "text-foreground" },
              { label: "Pending", value: counts.pending, color: "text-amber-600" },
              { label: "At Cleaners", value: counts.picked_up, color: "text-blue-600" },
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

        {/* Orders table */}
        <Card className="border-border/60 shadow-sm overflow-hidden">
          <CardHeader className="bg-muted/30 border-b border-border/50 py-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
              <Shirt className="w-4 h-4 text-primary" />
              All Orders
            </CardTitle>
            <CardDescription className="text-xs">
              Use the ID number with SMS commands — e.g. <span className="font-mono text-foreground">customer 5</span> or <span className="font-mono text-foreground">mark completed 5</span>
            </CardDescription>
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
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent border-b border-border/60">
                      {["ID", "Order", "Customer", "Location", "Items", "Access", "Status", "Pickup"].map((h) => (
                        <TableHead key={h} className="font-medium text-xs uppercase tracking-wider text-muted-foreground py-3">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow
                        key={order.id}
                        className="hover:bg-muted/40 transition-colors group border-b border-border/40 last:border-0"
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
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Admin SMS Commands</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { cmd: "today pickups", desc: "Today's scheduled pickups" },
                { cmd: "today returns", desc: "Orders at cleaners" },
                { cmd: "pending", desc: "All pending orders" },
                { cmd: "route", desc: "Today's route + Google Maps link" },
                { cmd: "stats", desc: "All-time item totals" },
                { cmd: "stats today", desc: "Items being picked up today" },
                { cmd: "stats week", desc: "Items this past week" },
                { cmd: "customer [id]", desc: "Order details" },
                { cmd: "mark completed [id]", desc: "Mark picked up" },
                { cmd: "mark paid [id]", desc: "Mark paid" },
                { cmd: "missed [id]", desc: "Mark missed" },
                { cmd: "help", desc: "List commands" },
              ].map(({ cmd, desc }) => (
                <div key={cmd} className="flex flex-col gap-0.5">
                  <span className="font-mono text-xs text-foreground font-medium">{cmd}</span>
                  <span className="text-xs text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
