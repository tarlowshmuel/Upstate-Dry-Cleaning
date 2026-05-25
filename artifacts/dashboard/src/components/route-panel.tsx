import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Navigation, MapPin, Phone, Key, Package, AlertTriangle, Route as RouteIcon } from "lucide-react";

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
  start: { address: string; lat: number | null; lng: number | null };
  end: { address: string; lat: number | null; lng: number | null };
  stops: Stop[];
  totalDistanceKm: number;
  totalDistanceMiles: number;
  mapsUrl: string;
  warnings: string[];
}

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
  // Group by unit + phone so multi-contact units (rare, but possible) aren't
  // collapsed into a single dispatcher contact.
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

async function fetchRoute(): Promise<RouteResponse> {
  const res = await fetch(`${API_BASE}/route/today`, { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch route");
  return res.json();
}

export function RoutePanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["route", "today"],
    queryFn: fetchRoute,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
            <RouteIcon className="w-4 h-4" /> Today's Optimized Route
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
            <RouteIcon className="w-4 h-4" /> Today's Optimized Route
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Could not load route.
        </CardContent>
      </Card>
    );
  }

  if (data.stops.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
            <RouteIcon className="w-4 h-4" /> Today's Optimized Route
          </CardTitle>
          <CardDescription>{data.date}</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No pickups scheduled for today.
        </CardContent>
      </Card>
    );
  }

  const totalOrders = data.stops.reduce((sum, s) => sum + s.orders.length, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div>
            <CardTitle className="text-base font-semibold flex items-center gap-2 font-serif">
              <RouteIcon className="w-4 h-4" /> Today's Optimized Route
            </CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{data.stops.length} stop{data.stops.length !== 1 ? "s" : ""}</Badge>
              <Badge variant="secondary">{totalOrders} order{totalOrders !== 1 ? "s" : ""}</Badge>
              {data.totalDistanceMiles > 0 && (
                <Badge variant="secondary">~{data.totalDistanceMiles} mi</Badge>
              )}
            </CardDescription>
          </div>
          <Button asChild size="sm" className="gap-2">
            <a href={data.mapsUrl} target="_blank" rel="noopener noreferrer">
              <Navigation className="w-4 h-4" />
              Open in Google Maps
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
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
      </CardContent>
    </Card>
  );
}
