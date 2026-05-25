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
                    {stop.orders.map((o) => (
                      <li key={o.id} className="text-sm flex flex-col gap-0.5 pl-2 border-l-2 border-primary/30">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">Unit {o.unitNumber}</span>
                          <span className="text-muted-foreground">— {o.name}</span>
                          <a
                            href={`tel:${o.phoneNumber}`}
                            className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-primary"
                          >
                            <Phone className="w-3 h-3" />
                            {o.phoneNumber}
                          </a>
                          {o.gateAccess && (
                            <span className="text-xs inline-flex items-center gap-1 text-amber-700">
                              <Key className="w-3 h-3" />
                              {o.gateAccess}
                            </span>
                          )}
                        </div>
                        {o.items && (
                          <div className="text-xs text-muted-foreground flex items-start gap-1">
                            <Package className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>{o.items}</span>
                          </div>
                        )}
                        {o.notes && (
                          <div className="text-xs text-muted-foreground italic">📝 {o.notes}</div>
                        )}
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
