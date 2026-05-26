import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Shirt, Phone, CalendarDays, AlertCircle, RefreshCw, MapPin, Mail, ArrowLeft } from "lucide-react";

const BUSINESS_NAME = "Upstate Dry Cleaning";
const SMS_NUMBER = "(845) 606-0022";
const SMS_HREF = "+18456060022";
const CONTACT_EMAIL = "upstatedrycleaning@gmail.com";

type OrderRow = {
  id: number;
  orderNumber: string;
  name: string;
  phoneNumber: string;
  town: string;
  colony: string;
  unitNumber: string;
  status: string;
  paid: boolean;
  pickupDate: string | null;
  pickupLabel: string | null;
  dropoffLabel: string | null;
  items: string | null;
  notes: string | null;
};

type PickupOption = {
  date: string;
  label: string;
  shabbosWarning: boolean;
  dropoffLabel: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Scheduled",
  picked_up: "Picked up",
  at_cleaners: "At the cleaners",
  ready: "Ready for delivery",
  delivered: "Delivered",
};

export default function MyOrdersPage() {
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneSubmitted, setPhoneSubmitted] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reschedFor, setReschedFor] = useState<OrderRow | null>(null);

  async function lookup(phone: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/customer/orders?phone=${encodeURIComponent(phone)}`,
      );
      const j = await res.json();
      if (!res.ok) {
        setError(j?.error ?? "Lookup failed");
        return;
      }
      setOrders(j.orders);
      setPhoneSubmitted(j.phone);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  function refresh() {
    if (phoneSubmitted) void lookup(phoneSubmitted);
  }

  return (
    <PageShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl flex items-center gap-2">
            <Shirt className="w-6 h-6 text-primary" />
            My orders
          </CardTitle>
          <CardDescription>
            Enter the phone number you used to book and we'll show your open orders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!phoneInput.trim()) return;
              void lookup(phoneInput.trim());
            }}
            className="flex flex-col sm:flex-row gap-3 sm:items-end"
          >
            <div className="flex-1 space-y-1.5">
              <Label className="text-sm">Phone number</Label>
              <Input
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="(845) 555-1234"
                autoComplete="tel"
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? "Looking up…" : "Look up my orders"}
            </Button>
          </form>

          {error && (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {orders !== null && (
            <div className="mt-6">
              {orders.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No open orders for that number. Want to place one?{" "}
                  <Link href="/order" className="underline">
                    Schedule a pickup
                  </Link>
                  .
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">
                      {orders.length} open order{orders.length === 1 ? "" : "s"}
                    </p>
                    <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                      Refresh
                    </Button>
                  </div>
                  {orders.map((o) => (
                    <OrderCard key={o.id} order={o} onReschedule={() => setReschedFor(o)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {reschedFor && (
        <RescheduleDialog
          order={reschedFor}
          onClose={() => setReschedFor(null)}
          onDone={() => {
            setReschedFor(null);
            refresh();
          }}
        />
      )}
    </PageShell>
  );
}

function OrderCard({ order, onReschedule }: { order: OrderRow; onReschedule: () => void }) {
  const canReschedule = order.status === "pending";
  return (
    <Card className="border-border/60">
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-sm font-semibold">{order.orderNumber}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{order.name}</div>
          </div>
          <Badge variant={order.status === "ready" ? "default" : "secondary"}>
            {STATUS_LABEL[order.status] ?? order.status}
          </Badge>
        </div>

        <div className="text-sm space-y-1.5">
          <div className="flex items-start gap-2">
            <MapPin className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
            <div>
              {order.colony}, Unit {order.unitNumber}
              <span className="text-muted-foreground"> · {order.town}</span>
            </div>
          </div>
          {order.pickupLabel && (
            <div className="flex items-start gap-2">
              <CalendarDays className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
              <div>
                <span className="text-muted-foreground">Pickup:</span> {order.pickupLabel}
                {order.dropoffLabel && (
                  <>
                    <br />
                    <span className="text-muted-foreground">Drop-off by:</span> {order.dropoffLabel}
                  </>
                )}
              </div>
            </div>
          )}
          {order.items && (
            <div className="text-xs text-muted-foreground">📦 {order.items}</div>
          )}
          {order.notes && (
            <div className="text-xs text-muted-foreground">📝 {order.notes}</div>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          {canReschedule ? (
            <Button size="sm" variant="outline" onClick={onReschedule}>
              Reschedule
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              In progress — to change anything,{" "}
              <a href={`sms:${SMS_HREF}`} className="underline">
                text us
              </a>
              .
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RescheduleDialog({
  order,
  onClose,
  onDone,
}: {
  order: OrderRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [options, setOptions] = useState<PickupOption[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}api/customer/towns`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const t = (j.towns as Array<{ name: string; options: PickupOption[] }>).find(
          (x) => x.name === order.town,
        );
        setOptions(t?.options ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [order.town]);

  async function submit() {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/customer/orders/${order.id}/reschedule`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: order.phoneNumber, pickupDate: pick }),
        },
      );
      const j = await res.json();
      if (!res.ok) {
        setErr(j?.error ?? "Reschedule failed");
        return;
      }
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule {order.orderNumber}</DialogTitle>
          <DialogDescription>Pick a new pickup day in {order.town}.</DialogDescription>
        </DialogHeader>

        {options === null ? (
          <p className="text-sm text-muted-foreground">Loading options…</p>
        ) : options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming pickup days available. Please text us.
          </p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {options.map((opt) => {
              const active = pick === opt.date;
              return (
                <button
                  key={opt.date}
                  type="button"
                  onClick={() => setPick(opt.date)}
                  className={[
                    "text-left rounded-md border p-3 transition-colors",
                    active
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/50 hover:bg-muted/50",
                  ].join(" ")}
                >
                  <div className="font-medium text-sm">{opt.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Drop-off by {opt.dropoffLabel}
                  </div>
                  {opt.shabbosWarning && (
                    <Badge variant="outline" className="mt-2 text-amber-800 border-amber-300">
                      🕯️ Back after Shabbos
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!pick || busy}>
            {busy ? "Saving…" : "Reschedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <header className="mb-6 flex items-center gap-4">
          <img
            src={`${import.meta.env.BASE_URL}logo.png`}
            alt={BUSINESS_NAME}
            className="h-16 w-16 rounded-full object-cover shadow-sm border border-border/40 shrink-0"
          />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{BUSINESS_NAME}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">My orders</p>
            <Link
              href="/order"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
            >
              <ArrowLeft className="w-3 h-3" />
              Back to home
            </Link>
          </div>
          <div className="ml-auto hidden sm:flex flex-col items-end gap-0.5">
            <a
              href={`sms:${SMS_HREF}`}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Phone className="w-3.5 h-3.5" />
              {SMS_NUMBER}
            </a>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Mail className="w-3.5 h-3.5" />
              {CONTACT_EMAIL}
            </a>
          </div>
        </header>
        {children}
        <footer className="mt-6 text-center text-xs text-muted-foreground space-y-1">
          <div>
            <Link href="/order" className="underline">
              Schedule a pickup
            </Link>
            <span className="mx-2">·</span>
            <Link href="/legal" className="underline">
              Terms &amp; privacy
            </Link>
            <span className="mx-2">·</span>
            <a href={`mailto:${CONTACT_EMAIL}`} className="underline">
              {CONTACT_EMAIL}
            </a>
          </div>
          <div className="sm:hidden">
            <a href={`sms:${SMS_HREF}`} className="underline">
              Text {SMS_NUMBER}
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
