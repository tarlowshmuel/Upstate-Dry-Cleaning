import {
  useListOrders,
  getListOrdersQueryKey,
  useUpdateOrderStatus,
  useUpdateOrderPaid,
  useBulkMarkOrdersReady,
  useBulkMarkOrdersAtCleaners,
  useBulkMarkOrdersDelivered,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
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
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Shirt, Phone, MapPin, Clock, Key, Inbox, Hash, Package, DollarSign, CircleDashed, CheckCircle2, Sparkles, Receipt as ReceiptIcon, Printer, ChevronDown, Truck, Building2, PackageCheck } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { RoutePanel } from "@/components/route-panel";
import { NewOrderDialog } from "@/components/new-order-dialog";
import { EditOrderDialog } from "@/components/edit-order-dialog";
import { OrderPricingDialog } from "@/components/order-pricing-dialog";
import { SiteNav } from "@/components/site-nav";
import { formatCents } from "@/lib/money";
import type { Order } from "@workspace/api-client-react";

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
  { value: "at_cleaners", label: "At Cleaners" },
  { value: "ready", label: "Ready" },
  { value: "delivered", label: "Delivered" },
  { value: "missed", label: "Missed" },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800 border-amber-200",
  picked_up: "bg-sky-100 text-sky-800 border-sky-200",
  at_cleaners: "bg-indigo-100 text-indigo-800 border-indigo-200",
  ready: "bg-violet-100 text-violet-800 border-violet-200",
  delivered: "bg-emerald-100 text-emerald-800 border-emerald-200",
  missed: "bg-red-100 text-red-800 border-red-200",
};

function rowClass(order: { status: string; paid: boolean }): string {
  const complete = order.status === "delivered" && order.paid;
  const missed = order.status === "missed";
  const ready = order.status === "ready";
  if (complete) {
    return "bg-emerald-50/70 hover:bg-emerald-100/70 border-l-4 border-l-emerald-500";
  }
  if (missed) {
    return "bg-red-50/60 hover:bg-red-100/60 border-l-4 border-l-red-500";
  }
  if (ready) {
    // "Ready" stands out — these are the orders driver should grab on the next delivery wave.
    return "bg-violet-50/60 hover:bg-violet-100/70 border-l-4 border-l-violet-500";
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

// Paid cell: toggle button + inline method dropdown when paid. Toggling on is
// one click (no method prompt — matches user spec). Method is editable any
// time after; the dropdown carries `null` (—) for "method not recorded yet".
function PaidCell({ order }: { order: Order }) {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useUpdateOrderPaid({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
      },
    },
  });

  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant={order.paid ? "default" : "outline"}
        disabled={isPending}
        onClick={() => mutate({ id: order.id, data: { paid: !order.paid } })}
        className={
          order.paid
            ? "h-8 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600"
            : "h-8 gap-1.5 border-border/60 text-muted-foreground hover:text-foreground"
        }
      >
        {order.paid ? (
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
      {order.paid ? (
        <Select
          value={order.paidMethod ?? "__none__"}
          disabled={isPending}
          onValueChange={(v) => {
            const paidMethod = v === "__none__" ? null : (v as "zelle" | "cash");
            mutate({ id: order.id, data: { paid: true, paidMethod } });
          }}
        >
          <SelectTrigger className="h-7 text-xs px-2">
            <SelectValue placeholder="Method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zelle" className="text-xs">Zelle</SelectItem>
            <SelectItem value="cash" className="text-xs">Cash</SelectItem>
            <SelectItem value="__none__" className="text-xs text-muted-foreground">— Unspecified</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}

// Pricing cell: shows total + small actions. Unpriced orders show a prominent
// "Needs pricing" call-to-action (this is what the driver/admin hits to add
// line items and auto-send the receipt).
function PricingCell({ order }: { order: Order }) {
  const [open, setOpen] = useState(false);
  const isPriced = order.pricedAt != null;
  // grandTotalCents is computed server-side in the list endpoint from the live
  // line items + fee snapshot (or override). Always present for priced orders.
  const total = order.grandTotalCents;

  return (
    <div className="flex flex-col gap-1 items-start">
      {isPriced ? (
        <>
          <span className="text-sm font-semibold text-foreground">
            {total != null ? formatCents(total) : "Priced"}
            {order.totalWasOverridden ? (
              <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-600">
                override
              </span>
            ) : null}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setOpen(true)}
            >
              <ReceiptIcon className="w-3 h-3 mr-1" /> Edit
            </Button>
            <a
              href={`receipt/${order.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
              title="Open printable receipt"
            >
              <Printer className="w-3 h-3" />
            </a>
          </div>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100"
          onClick={() => setOpen(true)}
        >
          <DollarSign className="w-3 h-3" /> Add pricing
        </Button>
      )}
      <OrderPricingDialog order={order} open={open} onOpenChange={setOpen} />
    </div>
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
      onValueChange={(value) => {
        // "__done__" is a UI-only shortcut — fast-forward any order straight
        // to the terminal delivered state regardless of the current stage.
        const status = value === "__done__" ? "delivered" : value;
        mutate({ id: orderId, data: { status } });
      }}
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
        <SelectSeparator />
        <SelectItem
          value="__done__"
          className="text-xs font-semibold text-emerald-700 focus:text-emerald-800 focus:bg-emerald-50"
        >
          ✓ Done (mark delivered)
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

// Bulk-mark every at_cleaners order as "ready". The driver hits this when they
// load everything back into the van after picking up from the cleaners — beats
// clicking each row's status dropdown one at a time. Delegates to a server-side
// conditional UPDATE so stale client snapshots can't accidentally rewind orders
// that have since moved on. Each updated order still triggers the same per-order
// customer notification (SMS↔dashboard parity preserved).
// Single dropdown surface for all bulk status transitions. Each item delegates
// to a server-side conditional UPDATE so stale client snapshots can't rewind
// orders that have since moved on (see .agents/memory/bulk-status-transitions.md).
// Per-order customer notifications fire for every updated row, preserving
// SMS↔dashboard parity. Items that have nothing to act on are disabled rather
// than hidden — keeps menu position stable so the driver builds muscle memory.
type BulkAction = {
  key: "drop-off" | "ready" | "delivered";
  label: string;
  detail: string;
  icon: typeof Truck;
  fromStatus: "picked_up" | "at_cleaners" | "ready";
  toLabel: string;
};

const BULK_ACTIONS: BulkAction[] = [
  {
    key: "drop-off",
    label: "Drop off all at cleaners",
    detail: "Picked Up → At Cleaners",
    icon: Building2,
    fromStatus: "picked_up",
    toLabel: "at cleaners",
  },
  {
    key: "ready",
    label: "Mark all ready",
    detail: "At Cleaners → Ready",
    icon: PackageCheck,
    fromStatus: "at_cleaners",
    toLabel: "ready",
  },
  {
    key: "delivered",
    label: "Mark all delivered",
    detail: "Ready → Delivered",
    icon: Truck,
    fromStatus: "ready",
    toLabel: "delivered",
  },
];

function BulkActionsMenu({ counts }: { counts: Record<BulkAction["fromStatus"], number> }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleSuccess = (action: BulkAction, updated: number) => {
    queryClient.invalidateQueries({ queryKey: getListOrdersQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["route"] });
    setPending(null);
    if (updated === 0) {
      toast.info(`Nothing to mark ${action.toLabel}`);
    } else {
      toast.success(
        `${updated} order${updated === 1 ? "" : "s"} marked ${action.toLabel}`,
      );
    }
  };
  const handleError = () => toast.error("Could not update orders — please try again");

  const dropOff = useBulkMarkOrdersAtCleaners({
    mutation: { onSuccess: ({ updated }) => handleSuccess(BULK_ACTIONS[0]!, updated), onError: handleError },
  });
  const ready = useBulkMarkOrdersReady({
    mutation: { onSuccess: ({ updated }) => handleSuccess(BULK_ACTIONS[1]!, updated), onError: handleError },
  });
  const delivered = useBulkMarkOrdersDelivered({
    mutation: { onSuccess: ({ updated }) => handleSuccess(BULK_ACTIONS[2]!, updated), onError: handleError },
  });
  const mutationByKey = { "drop-off": dropOff, ready, delivered } as const;

  const isPending = dropOff.isPending || ready.isPending || delivered.isPending;
  const totalActionable = counts.picked_up + counts.at_cleaners + counts.ready;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 gap-1.5 bg-violet-100 hover:bg-violet-200 text-violet-900 border border-violet-200"
            disabled={isPending}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Mark all…
            {totalActionable > 0 ? (
              <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] bg-violet-200 text-violet-900">
                {totalActionable}
              </Badge>
            ) : null}
            <ChevronDown className="w-3.5 h-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Bulk status updates
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {BULK_ACTIONS.map((action) => {
            const count = counts[action.fromStatus];
            const Icon = action.icon;
            return (
              <DropdownMenuItem
                key={action.key}
                disabled={count === 0 || isPending}
                onSelect={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                  setPending(action);
                }}
                className="flex flex-col items-start gap-0.5 py-2"
              >
                <div className="flex items-center gap-2 w-full">
                  <Icon className="w-4 h-4 text-violet-700 shrink-0" />
                  <span className="font-medium flex-1">{action.label}</span>
                  <Badge
                    variant="secondary"
                    className={`h-5 px-1.5 text-[10px] ${count === 0 ? "opacity-40" : "bg-violet-100 text-violet-900"}`}
                  >
                    {count}
                  </Badge>
                </div>
                <span className="text-[11px] text-muted-foreground pl-6">{action.detail}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={pending != null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          {pending ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pending.label} — {counts[pending.fromStatus]} order
                  {counts[pending.fromStatus] === 1 ? "" : "s"}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Every order currently <span className="font-semibold">{pending.detail.split(" → ")[0]}</span>{" "}
                  will be moved to{" "}
                  <span className="font-semibold">{pending.detail.split(" → ")[1]}</span>.
                  Orders in any other status will not be touched.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    mutationByKey[pending.key].mutate();
                  }}
                >
                  {isPending ? "Updating…" : `Mark ${counts[pending.fromStatus]} ${pending.toLabel}`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function Dashboard() {
  const { data: orders, isLoading, isError } = useListOrders({
    query: { queryKey: getListOrdersQueryKey() },
  });

  const [range, setRange] = useState<"today" | "week" | "all">("all");
  const [sortBy, setSortBy] = useState<
    "newest" | "oldest" | "pickup_soonest" | "pickup_latest" | "name"
  >("newest");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "pending" | "picked_up" | "at_cleaners" | "ready" | "delivered" | "missed"
  >("all");
  const [paidFilter, setPaidFilter] = useState<"all" | "paid" | "unpaid">("all");

  const today = todayDateString();
  const todaysPickups = orders?.filter((o) => o.status === "pending" && o.pickupDate === today) ?? [];
  const bulkCounts = {
    picked_up: (orders ?? []).filter((o) => o.status === "picked_up").length,
    at_cleaners: (orders ?? []).filter((o) => o.status === "at_cleaners").length,
    ready: (orders ?? []).filter((o) => o.status === "ready").length,
  };

  const filteredOrders = (orders ?? [])
    .filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (paidFilter === "paid" && !o.paid) return false;
      if (paidFilter === "unpaid" && o.paid) return false;
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
    })
    .slice()
    .sort((a, b) => {
      switch (sortBy) {
        case "newest":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case "oldest":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "pickup_soonest": {
          if (!a.pickupDate && !b.pickupDate) return 0;
          if (!a.pickupDate) return 1;
          if (!b.pickupDate) return -1;
          return a.pickupDate.localeCompare(b.pickupDate);
        }
        case "pickup_latest": {
          if (!a.pickupDate && !b.pickupDate) return 0;
          if (!a.pickupDate) return 1;
          if (!b.pickupDate) return -1;
          return b.pickupDate.localeCompare(a.pickupDate);
        }
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return 0;
      }
    });

  const counts = orders
    ? {
        pending: orders.filter((o) => o.status === "pending").length,
        // "At cleaners" card aggregates the in-our-hands states (picked up
        // from home, at cleaners, ready) so it stays a useful at-a-glance number.
        atCleaners: orders.filter(
          (o) => o.status === "picked_up" || o.status === "at_cleaners" || o.status === "ready",
        ).length,
        ready: orders.filter((o) => o.status === "ready").length,
        todaysPickups: todaysPickups.length,
        unpaid: orders.filter((o) => !o.paid).length,
      }
    : null;

  return (
    <div className="min-h-screen w-full bg-background p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-700">
        <SiteNav />

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div className="flex items-center gap-4">
            <img
              src={`${import.meta.env.BASE_URL}logo.png`}
              alt="Upstate Dry Cleaning"
              className="h-16 w-16 rounded-full object-cover shadow-sm border border-border/40"
            />
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground font-serif">
                Upstate Dry Cleaning
              </h1>
              <p className="text-muted-foreground mt-1 text-sm">
                Operations &middot; Sullivan County, NY
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <NewOrderDialog />
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 border border-border/50 px-3 py-2 rounded-md font-mono">
              <Phone className="w-3.5 h-3.5 text-primary" />
              Text <span className="text-foreground font-semibold mx-1">"clean"</span> to your Twilio number
            </div>
          </div>
        </header>

        {/* Summary strip */}
        {counts && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: "Today's Pickups", value: counts.todaysPickups, color: "text-primary" },
              { label: "Pending", value: counts.pending, color: "text-amber-600" },
              { label: "At Cleaners", value: counts.atCleaners, color: "text-indigo-600" },
              { label: "Ready", value: counts.ready, color: "text-violet-600" },
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
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
                  <SelectTrigger className="h-8 w-[140px] text-xs border-border/60 bg-background">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">All statuses</SelectItem>
                    {STATUSES.map((s) => (
                      <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={paidFilter} onValueChange={(v) => setPaidFilter(v as typeof paidFilter)}>
                  <SelectTrigger className="h-8 w-[120px] text-xs border-border/60 bg-background">
                    <SelectValue placeholder="Payment" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-xs">Paid &amp; Unpaid</SelectItem>
                    <SelectItem value="paid" className="text-xs">Paid only</SelectItem>
                    <SelectItem value="unpaid" className="text-xs">Unpaid only</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                  <SelectTrigger className="h-8 w-[180px] text-xs border-border/60 bg-background">
                    <SelectValue placeholder="Sort by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest" className="text-xs">Newest first</SelectItem>
                    <SelectItem value="oldest" className="text-xs">Oldest first</SelectItem>
                    <SelectItem value="pickup_soonest" className="text-xs">Pickup date (soonest)</SelectItem>
                    <SelectItem value="pickup_latest" className="text-xs">Pickup date (latest)</SelectItem>
                    <SelectItem value="name" className="text-xs">Customer name (A–Z)</SelectItem>
                  </SelectContent>
                </Select>
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
                {(statusFilter !== "all" || paidFilter !== "all" || range !== "all" || sortBy !== "newest") ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setStatusFilter("all");
                      setPaidFilter("all");
                      setRange("all");
                      setSortBy("newest");
                    }}
                  >
                    Reset filters
                  </Button>
                ) : null}
                <BulkActionsMenu counts={bulkCounts} />
              </div>
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
                      {["ID", "Order", "Customer", "Location", "Items", "Access", "Status", "Total", "Paid", "Pickup"].map((h, i) => (
                        <TableHead key={h} className={`font-medium text-xs uppercase tracking-wider text-muted-foreground py-3 ${i === 0 ? "pl-6" : ""}`}>
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
                        <TableCell className="py-4 pl-6 w-[72px]">
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
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <span className="font-medium text-foreground text-sm truncate">{order.name}</span>
                              <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                                <Phone className="w-3 h-3 text-primary/60" />
                                {order.phoneNumber}
                              </span>
                            </div>
                            <EditOrderDialog order={order} />
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

                        {/* Pricing total + edit/receipt */}
                        <TableCell className="py-4 w-[130px]">
                          <PricingCell order={order} />
                        </TableCell>

                        {/* Paid toggle + method */}
                        <TableCell className="py-4 w-[130px]">
                          <PaidCell order={order} />
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
                { num: "5", label: "Missed pickups", desc: "Batch-mark missed + auto-notify customers" },
                { num: "6", label: "Route (any day)", desc: "Pick a day, get optimized stop order" },
                { num: "7", label: "Stats", desc: "Today / week / all-time totals" },
                { num: "8", label: "Look up an order", desc: "Search by name, phone, or ID" },
                { num: "9", label: "Update an order", desc: "Mark status, paid, or edit any field" },
                { num: "10", label: "New order (SMS)", desc: "Create an order over text" },
                { num: "13", label: "Earnings", desc: "Today / week / month / all-time revenue" },
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
              Inside Update, options <span className="font-mono text-foreground">6–11</span> let you edit items, name, phone, address, pickup date, and notes.
              Inline anywhere: <span className="font-mono text-foreground">sort newest|oldest|pickup|name</span>, <span className="font-mono text-foreground">range today|week|all</span>.
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
