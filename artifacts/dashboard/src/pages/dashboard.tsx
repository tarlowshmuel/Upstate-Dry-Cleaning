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
import { Shirt, Phone, MapPin, Clock, Key, Inbox, Hash, Package } from "lucide-react";

function parseItems(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, number>; }
  catch { return {}; }
}

function ItemsList({ json }: { json: string | null | undefined }) {
  const items = parseItems(json);
  const entries = Object.entries(items).filter(([, qty]) => qty > 0);
  if (entries.length === 0) return <span className="text-muted-foreground/40 text-sm">—</span>;
  return (
    <ul className="space-y-0.5">
      {entries.map(([name, qty]) => (
        <li key={name} className="text-xs text-foreground flex items-center gap-1.5">
          <span className="font-semibold text-primary">{qty}×</span>
          <span>{name}</span>
        </li>
      ))}
    </ul>
  );
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

  const counts = orders
    ? {
        pending: orders.filter((o) => o.status === "pending").length,
        picked_up: orders.filter((o) => o.status === "picked_up").length,
        total: orders.length,
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
          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 border border-border/50 px-3 py-2 rounded-md font-mono">
            <Phone className="w-3.5 h-3.5 text-primary" />
            Text <span className="text-foreground font-semibold mx-1">"clean"</span> to your Twilio number to place an order
          </div>
        </header>

        {/* Summary strip */}
        {counts && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Total Orders", value: counts.total, color: "text-foreground" },
              { label: "Pending Pickup", value: counts.pending, color: "text-amber-600" },
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
                      {["ID", "Order", "Customer", "Location", "Items", "Access", "Status", "Date"].map((h) => (
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
                        <TableCell className="py-4">
                          <div className="flex items-start gap-1.5">
                            <Package className="w-3 h-3 text-primary/60 mt-0.5 shrink-0" />
                            <ItemsList json={order.items} />
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

                        {/* Date */}
                        <TableCell className="py-4 w-[120px]">
                          <div className="flex flex-col gap-0.5 items-start">
                            <span className="text-sm font-medium text-foreground">
                              {format(new Date(order.createdAt), "MMM d, yyyy")}
                            </span>
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="w-3 h-3 text-primary/60" />
                              {format(new Date(order.createdAt), "h:mm a")}
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
                { cmd: "today pickups", desc: "Today's pending orders" },
                { cmd: "today returns", desc: "Orders at cleaners" },
                { cmd: "pending", desc: "All pending" },
                { cmd: "route", desc: "Today's route by town" },
                { cmd: "customer [id]", desc: "Order details" },
                { cmd: "mark completed [id]", desc: "Mark picked up" },
                { cmd: "mark paid [id]", desc: "Mark paid" },
                { cmd: "missed [id]", desc: "Mark missed" },
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
