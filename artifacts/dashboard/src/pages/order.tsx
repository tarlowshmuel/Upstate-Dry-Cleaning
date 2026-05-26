import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Badge } from "@/components/ui/badge";
import { Shirt, CalendarDays, CheckCircle2, Phone, MapPin, AlertCircle, Gift, Mail } from "lucide-react";

const BUSINESS_NAME = "Upstate Dry Cleaning";
const SMS_NUMBER = "(845) 606-0022";
const SMS_HREF = "+18456060022";
const CONTACT_EMAIL = "upstatedrycleaning@gmail.com";

type PickupOption = {
  date: string;
  label: string;
  shabbosWarning: boolean;
  dropoffDate: string;
  dropoffLabel: string;
};
type TownInfo = {
  name: string;
  comingSoon: boolean;
  wave: "morning" | "afternoon" | null;
  options: PickupOption[];
};
type TownsResponse = {
  towns: TownInfo[];
  waveCutoffs: { morning: string; afternoon: string };
};

type ConfirmedOrder = {
  orderNumber: string;
  pickupLabel: string;
  dropoffLabel: string;
  shabbosWarning: boolean;
  town: string;
  colony: string;
  unitNumber: string;
  phoneNumber: string;
};

function emptyForm() {
  return {
    name: "",
    phone: "",
    town: "",
    colony: "",
    colonyAddress: "",
    unitNumber: "",
    gateAccess: "",
    items: "",
    notes: "",
    pickupDate: "",
  };
}

export default function OrderPage() {
  const [data, setData] = useState<TownsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmedOrder | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}api/customer/towns`)
      .then((r) => r.json())
      .then((j: TownsResponse) => {
        if (!cancelled) setData(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTown = useMemo(
    () => data?.towns.find((t) => t.name === form.town) ?? null,
    [data, form.town],
  );

  function update<K extends keyof ReturnType<typeof emptyForm>>(key: K, value: string) {
    setForm((f) => {
      // Changing town invalidates the previously-chosen pickup date (each
      // town has its own option set and wave cutoff), so clear it.
      if (key === "town" && value !== f.town) {
        return { ...f, town: value, pickupDate: "" };
      }
      return { ...f, [key]: value };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) return setError("Please enter your name.");
    if (!form.phone.trim()) return setError("Please enter your phone number.");
    if (!form.town) return setError("Please pick your town.");
    if (!form.colony.trim()) return setError("Please enter your colony/bungalow.");
    if (!form.unitNumber.trim()) return setError("Please enter your unit number.");
    if (!form.pickupDate) return setError("Please pick a pickup day.");

    setSubmitting(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/customer/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim(),
          town: form.town,
          colony: form.colony.trim(),
          colonyAddress: form.colonyAddress.trim() || null,
          unitNumber: form.unitNumber.trim(),
          gateAccess: form.gateAccess.trim() || null,
          items: form.items.trim() || null,
          notes: form.notes.trim() || null,
          pickupDate: form.pickupDate,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setError(j?.error ?? "Something went wrong. Please try again or text us.");
        return;
      }
      setConfirmed({
        orderNumber: j.order.orderNumber,
        pickupLabel: j.pickupLabel,
        dropoffLabel: j.dropoffLabel,
        shabbosWarning: j.shabbosWarning,
        town: j.order.town,
        colony: j.order.colony,
        unitNumber: j.order.unitNumber,
        phoneNumber: j.order.phoneNumber,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return (
      <PageShell>
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <CheckCircle2 className="w-7 h-7 text-green-700" />
              Order Confirmed
            </CardTitle>
            <CardDescription>
              Order <span className="font-mono font-semibold">{confirmed.orderNumber}</span> · we just texted{" "}
              <span className="font-mono">{confirmed.phoneNumber}</span> with the details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="rounded-md border border-border/40 bg-muted/30 p-4 space-y-2">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <div>
                  {confirmed.colony}, Unit {confirmed.unitNumber}
                  <br />
                  <span className="text-muted-foreground">{confirmed.town}</span>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <CalendarDays className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                <div>
                  <div>
                    <span className="text-muted-foreground">Pickup:</span> {confirmed.pickupLabel}
                  </div>
                  <div>
                    <span className="text-muted-foreground">Drop-off by:</span> {confirmed.dropoffLabel}
                  </div>
                </div>
              </div>
              {confirmed.shabbosWarning && (
                <div className="text-amber-800 text-xs flex items-start gap-2">
                  <span>🕯️</span>
                  <span>
                    Heads up: your order won't be back before Shabbos — drop-off is the following Monday.
                  </span>
                </div>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              You can reply to our text any time, or check on your order at{" "}
              <Link href="/my-orders" className="underline">
                /my-orders
              </Link>
              .
            </p>
            <ReferralCallout />
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  setConfirmed(null);
                  setForm(emptyForm());
                }}
                variant="outline"
              >
                Place another order
              </Button>
              <Button asChild>
                <Link href="/my-orders">View my orders</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl flex items-center gap-2">
            <Shirt className="w-6 h-6 text-primary" />
            Schedule a pickup
          </CardTitle>
          <CardDescription>
            Free pickup &amp; delivery in Sullivan County. Cash or Zelle on delivery. We'll text you a
            confirmation as soon as you book.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadError && (
            <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              Couldn't load town list: {loadError}
            </div>
          )}
          <div className="mb-5 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm flex items-start gap-2">
            <Gift className="w-4 h-4 mt-0.5 text-primary shrink-0" />
            <div>
              <span className="font-medium">Refer 3 neighbors, get a free pickup.</span>{" "}
              <span className="text-muted-foreground">
                When 3 friends complete their first paid pickup, your next order is on us (up to $30).{" "}
                <Link href="/legal" className="underline">
                  See terms
                </Link>
                .
              </span>
            </div>
          </div>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Your name" required>
                <Input
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder="Sarah Goldstein"
                  autoComplete="name"
                />
              </Field>
              <Field label="Phone number" required hint="We'll text the confirmation here">
                <Input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => update("phone", e.target.value)}
                  placeholder="(845) 555-1234"
                  autoComplete="tel"
                />
              </Field>
            </div>

            <Field label="Town" required>
              <Select value={form.town} onValueChange={(v) => update("town", v)}>
                <SelectTrigger>
                  <SelectValue placeholder={data ? "Pick your town" : "Loading…"} />
                </SelectTrigger>
                <SelectContent>
                  {(data?.towns ?? [])
                    .filter((t) => !t.comingSoon)
                    .map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {data && (
                <div className="text-xs text-muted-foreground mt-1.5">
                  Coming soon:{" "}
                  {data.towns.filter((t) => t.comingSoon).map((t) => t.name).join(", ") || "—"}
                </div>
              )}
            </Field>

            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Colony / bungalow" required>
                <Input
                  value={form.colony}
                  onChange={(e) => update("colony", e.target.value)}
                  placeholder="e.g. Vizhnitz"
                />
              </Field>
              <Field label="Unit / bungalow number" required>
                <Input
                  value={form.unitNumber}
                  onChange={(e) => update("unitNumber", e.target.value)}
                  placeholder="e.g. 14B"
                />
              </Field>
            </div>

            <Field label="Street address (optional)" hint="Helps the driver find you on day one">
              <Input
                value={form.colonyAddress}
                onChange={(e) => update("colonyAddress", e.target.value)}
                placeholder="123 Old Falls Road"
              />
            </Field>

            <Field label="Gate access (optional)" hint="Door code, gate buzzer, etc.">
              <Input
                value={form.gateAccess}
                onChange={(e) => update("gateAccess", e.target.value)}
                placeholder="Gate code #1234"
              />
            </Field>

            {selectedTown && !selectedTown.comingSoon && (
              <Field label="Pickup day" required>
                <div className="grid sm:grid-cols-2 gap-2">
                  {selectedTown.options.map((opt) => {
                    const active = form.pickupDate === opt.date;
                    return (
                      <button
                        key={opt.date}
                        type="button"
                        onClick={() => update("pickupDate", opt.date)}
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
                {selectedTown.wave && data && (
                  <div className="text-xs text-muted-foreground mt-2">
                    Same-day cutoff for {selectedTown.name}:{" "}
                    <span className="font-medium">
                      {selectedTown.wave === "morning"
                        ? data.waveCutoffs.morning
                        : data.waveCutoffs.afternoon}
                    </span>{" "}
                    on pickup day.
                  </div>
                )}
              </Field>
            )}

            <Field label="What are we picking up? (optional)" hint='e.g. "2 suits, 3 shirts, 1 coat"'>
              <Textarea
                rows={2}
                value={form.items}
                onChange={(e) => update("items", e.target.value)}
                placeholder="2 suits, 3 dress shirts, 1 coat"
              />
            </Field>

            <Field label="Notes for the driver (optional)">
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                placeholder="Bag is by the front door, please knock"
              />
            </Field>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                Prefer texting?{" "}
                <a href={`sms:${SMS_HREF}`} className="underline">
                  Text {SMS_NUMBER}
                </a>{" "}
                instead.
              </p>
              <Button type="submit" size="lg" disabled={submitting}>
                {submitting ? "Placing order…" : "Place my order"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ReferralCallout() {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm flex items-start gap-2">
      <Gift className="w-4 h-4 mt-0.5 text-primary shrink-0" />
      <div>
        <span className="font-medium">Tell your neighbors!</span>{" "}
        <span className="text-muted-foreground">
          Refer 3 friends — when each completes their first paid pickup, your next order is free (up to $30).
          Text <span className="font-mono">refer</span> to {SMS_NUMBER} to add one.
        </span>
      </div>
    </div>
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
            <p className="text-xs text-muted-foreground mt-0.5">
              Pickup &amp; delivery, Sullivan County
            </p>
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
            <Link href="/my-orders" className="underline">
              Check my orders
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
