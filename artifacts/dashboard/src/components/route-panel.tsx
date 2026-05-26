import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Navigation, MapPin, Phone, Key, Package, AlertTriangle, Route as RouteIcon, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

interface StopOrder {
  id: number;
  orderNumber: string;
  name: string;
  phoneNumber: string;
  unitNumber: string;
  gateAccess: string | null;
  notes: string | null;
  items: string | null;
}

interface Stop {
  index: number;
  town: string;
  colony: string;
  addressHint: string | null;
  units: string[];
  orderIds: number[];
  lat: number;
  lng: number;
  ungeocoded: boolean;
  orders: StopOrder[];
}

interface RouteResponse {
  date: string;
  dayName?: string;
  direction?: "pickup" | "delivery";
  wave?: "morning" | "afternoon";
  isOperatingDay?: boolean;
  start: { address: string; lat: number | null; lng: number | null };
  end: { address: string; lat: number | null; lng: number | null };
  stops: Stop[];
  totalDistanceKm: number;
  totalDistanceMiles: number;
  mapsUrl: string;
  warnings: string[];
}

type Direction = "pickup" | "delivery";
type Wave = "morning" | "afternoon";

const WAVE_LABEL: Record<Wave, string> = {
  morning: "Morning · bags out by 10 AM",
  afternoon: "Afternoon · bags out by 12 PM",
};

// Mon–Thu only. Sun/Fri/Sat are non-operating days.
const OPERATING_DAYS = new Set([1, 2, 3, 4]);

interface UnitGroup {
  unitNumber: string;
  name: string;
  phoneNumber: string;
  gateAccess: string | null;
  items: string[];
  notes: string[];
  orders: StopOrder[];
}

function groupByUnit(orders: StopOrder[]): UnitGroup[] {
  const map = new Map<string, UnitGroup>();
  for (const o of orders) {
    const key = `${o.unitNumber.trim().toLowerCase()}|${o.phoneNumber.trim()}`;
    let g = map.get(key);
    if (!g) {
      g = {
        unitNumber: o.unitNumber,
        name: o.name,
        phoneNumber: o.phoneNumber,
        gateAccess: o.gateAccess,
        items: [],
        notes: [],
        orders: [],
      };
      map.set(key, g);
    }
    g.orders.push(o);
    if (o.items) g.items.push(o.items);
    if (o.notes) g.notes.push(o.notes);
    if (!g.gateAccess && o.gateAccess) g.gateAccess = o.gateAccess;
  }
  return Array.from(map.values()).sort((a, b) => {
    const an = parseInt(a.unitNumber.replace(/\D/g, ""), 10);
    const bn = parseInt(b.unitNumber.replace(/\D/g, ""), 10);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    return a.unitNumber.localeCompare(b.unitNumber);
  });
}

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DayOption {
  date: string;
  label: string;
  sub: string;
  isToday: boolean;
  weekIndex: number;
}

function buildDayOptions(): DayOption[] {
  const days: DayOption[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Anchor week 0 to the Sunday on or before today.
  const weekAnchor = new Date(today);
  weekAnchor.setDate(today.getDate() - today.getDay());
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Walk forward up to 14 days to collect the next 7 operating days (Mon–Thu).
  for (let i = 0; i < 14 && days.length < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getDay();
    if (!OPERATING_DAYS.has(dow)) continue;
    const daysFromAnchor = Math.round((d.getTime() - weekAnchor.getTime()) / 86_400_000);
    days.push({
      date: toDateOnly(d),
      label: weekdays[dow]!,
      sub: `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: i === 0,
      weekIndex: Math.floor(daysFromAnchor / 7),
    });
  }
  return days;
}

async function fetchRoute(date: string, direction: Direction, wave: Wave): Promise<RouteResponse> {
  const res = await fetch(
    `${API_BASE}/route/today?date=${encodeURIComponent(date)}&direction=${direction}&wave=${wave}`,
    { credentials: "include" },
  );
  if (!res.ok) throw new Error("Failed to fetch route");
  return res.json();
}

export function RoutePanel() {
  const dayOptions = useMemo(buildDayOptions, []);
  const [selectedDate, setSelectedDate] = useState<string>(dayOptions[0]!.date);
  const [direction, setDirection] = useState<Direction>("pickup");
  const [wave, setWave] = useState<Wave>(() => (new Date().getHours() >= 11 ? "afternoon" : "morning"));
  const [collapsed, setCollapsed] = useState(false);
  const selectedOption = dayOptions.find((d) => d.date === selectedDate) ?? dayOptions[0]!;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["route", selectedDate, direction, wave],
    queryFn: () => fetchRoute(selectedDate, direction, wave),
    staleTime: 60_000,
  });

  const directionLabel = direction === "delivery" ? "Delivery Route" : "Pickup Route";
  const waveTag = wave === "morning" ? "Morning" : "Afternoon";
  const headerTitle = selectedOption.isToday
    ? `Today's ${waveTag} ${directionLabel}`
    : `${selectedOption.label}'s ${waveTag} ${directionLabel}`;

  const directionToggle = (
    <div className="inline-flex rounded-md border border-border overflow-hidden text-xs font-medium">
      {(["pickup", "delivery"] as const).map((d) => {
        const active = direction === d;
        return (
          <button
            key={d}
            type="button"
            onClick={() => setDirection(d)}
            className={cn(
              "px-3 py-1.5 transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-card hover:bg-muted text-foreground",
            )}
          >
            {d === "pickup" ? "Pickup (home → cleaners)" : "Delivery (cleaners → home)"}
          </button>
        );
      })}
    </div>
  );

  const waveToggle = (
    <div className="inline-flex rounded-md border border-border overflow-hidden text-xs font-medium">
      {(["morning", "afternoon"] as const).map((w) => {
        const active = wave === w;
        return (
          <button
            key={w}
            type="button"
            onClick={() => setWave(w)}
            className={cn(
              "px-3 py-1.5 transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-card hover:bg-muted text-foreground",
            )}
          >
            {WAVE_LABEL[w]}
          </button>
        );
      })}
    </div>
  );

  const daySelector = (
    <div className="flex flex-wrap items-stretch gap-1.5">
      {dayOptions.map((d, i) => {
        const active = d.date === selectedDate;
        const prev = dayOptions[i - 1];
        const showDivider = prev && prev.weekIndex !== d.weekIndex;
        return (
          <Fragment key={d.date}>
            {showDivider && (
              <div className="flex items-center gap-1.5 px-1" aria-hidden="true">
                <div className="h-8 w-px bg-border" />
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                  Next week
                </span>
                <div className="h-8 w-px bg-border" />
              </div>
            )}
            <button
              type="button"
              onClick={() => setSelectedDate(d.date)}
              className={cn(
                "px-2.5 py-1.5 rounded-md border text-xs font-medium leading-tight flex flex-col items-center min-w-12 transition-colors",
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card hover:bg-muted border-border text-foreground",
              )}
            >
              <span>{d.label}</span>
              <span className={cn("text-[10px]", active ? "opacity-90" : "text-muted-foreground")}>
                {d.sub}
              </span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );

  const headerBlock = (
    <CardHeader>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
              <RouteIcon className="w-4 h-4" /> {headerTitle}
            </CardTitle>
            <CardDescription className="mt-1">{selectedOption.label}, {selectedDate}</CardDescription>
          </div>
          {data && data.stops.length > 0 && (
            <Button asChild size="sm" className="gap-2">
              <a href={data.mapsUrl} target="_blank" rel="noopener noreferrer">
                <Navigation className="w-4 h-4" />
                Open in Google Maps
              </a>
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {directionToggle}
          {waveToggle}
        </div>
        {daySelector}
      </div>
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card>
        {headerBlock}
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        {headerBlock}
        <CardContent className="text-sm text-muted-foreground">Could not load route.</CardContent>
      </Card>
    );
  }

  if (data.stops.length === 0) {
    const nonOperating = data.isOperatingDay === false;
    const empty = direction === "delivery"
      ? "Nothing is at the cleaners to deliver right now."
      : `No pickups scheduled for ${selectedOption.isToday ? "today" : selectedOption.label}.`;
    return (
      <Card>
        {headerBlock}
        <CardContent className="text-sm text-muted-foreground">
          {nonOperating
            ? `No route on ${data.dayName ?? selectedOption.label} — the business runs Mon–Thu only.`
            : empty}
        </CardContent>
      </Card>
    );
  }

  const totalOrders = data.stops.reduce((sum, s) => sum + s.orders.length, 0);

  return (
    <Card>
      {headerBlock}
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed((c) => !c)}
            className="h-7 px-2 -ml-1 gap-1 text-xs font-medium"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand route list" : "Collapse route list"}
          >
            {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {collapsed ? "Show stops" : "Hide stops"}
          </Button>
          <Badge variant="secondary">{data.stops.length} stop{data.stops.length !== 1 ? "s" : ""}</Badge>
          <Badge variant="secondary">{totalOrders} order{totalOrders !== 1 ? "s" : ""}</Badge>
          {data.totalDistanceMiles > 0 && (
            <Badge variant="secondary">~{data.totalDistanceMiles} mi</Badge>
          )}
        </div>
        {data.warnings.length > 0 && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              {data.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          </div>
        )}
        {collapsed && (
          <ol className="flex flex-wrap gap-1.5">
            {data.stops.map((stop) => (
              <li
                key={`mini-${stop.town}-${stop.colony}`}
                className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs"
              >
                <span className="inline-flex w-5 h-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                  {stop.index}
                </span>
                <span className="font-medium">{stop.colony}</span>
                <span className="text-muted-foreground">· {stop.town}</span>
              </li>
            ))}
          </ol>
        )}
        {!collapsed && (
        <>
        <div className="text-xs text-muted-foreground font-mono">
          Start: {data.start.address}
        </div>
        <ol className="space-y-3">
          {data.stops.map((stop) => (
            <li key={`${stop.town}-${stop.colony}`} className="border rounded-md p-3 bg-card">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">
                  {stop.index}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-semibold">{stop.colony}</span>
                    <Badge variant="secondary" className="text-xs">
                      {stop.orders.length} order{stop.orders.length !== 1 ? "s" : ""}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{stop.town}, NY</span>
                    {stop.ungeocoded && (
                      <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">
                        no coords
                      </Badge>
                    )}
                  </div>
                  {stop.addressHint && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" />
                      {stop.addressHint}
                    </div>
                  )}
                  <ul className="mt-2 space-y-1.5">
                    {groupByUnit(stop.orders).map((group) => (
                      <li
                        key={group.unitNumber}
                        className="text-sm flex flex-col gap-0.5 pl-2 border-l-2 border-primary/30"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">Unit {group.unitNumber}</span>
                          <span className="text-muted-foreground">— {group.name}</span>
                          {group.orders.length > 1 && (
                            <Badge variant="outline" className="text-xs">
                              {group.orders.length} orders
                            </Badge>
                          )}
                          <a
                            href={`tel:${group.phoneNumber}`}
                            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-primary"
                          >
                            <Phone className="w-3 h-3" />
                            {group.phoneNumber}
                          </a>
                          {group.gateAccess && (
                            <span className="text-xs inline-flex items-center gap-1 text-amber-700">
                              <Key className="w-3 h-3" />
                              {group.gateAccess}
                            </span>
                          )}
                        </div>
                        {group.items.length > 0 && (
                          <div className="text-xs text-muted-foreground flex items-start gap-1">
                            <Package className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>{group.items.join("; ")}</span>
                          </div>
                        )}
                        {group.notes.length > 0 && (
                          <div className="text-xs text-muted-foreground italic">
                            {group.notes.map((n, i) => (
                              <div key={i}>📝 {n}</div>
                            ))}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground/70 font-mono">
                          {group.orders.map((o) => o.orderNumber).join(" · ")}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="text-xs text-muted-foreground font-mono">
          End: {data.end.address}
        </div>
        </>
        )}
      </CardContent>
    </Card>
  );
}
