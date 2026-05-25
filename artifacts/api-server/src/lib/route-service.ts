import type { Order } from "@workspace/db/schema";
import { geocodeAddress, geocodeColony } from "./geocode";
import { haversineKm, optimizeRoute, type Point } from "./route-optimizer";

const DRIVER_HOME =
  process.env["DRIVER_START_ADDRESS"] ?? "458 Riverside Drive, Fallsburg, NY";
const DRY_CLEANERS =
  process.env["DRY_CLEANERS_ADDRESS"] ?? "16 Thompson Square, Monticello, NY 12701";

// Backwards-compatible aliases (pickup-direction defaults).
const DRIVER_START = DRIVER_HOME;
const DRIVER_END = DRY_CLEANERS;

export type RouteDirection = "pickup" | "delivery";

/** Origin/destination for a route, given a direction.
 *  pickup:   home → customers → cleaners (drop bags off to be cleaned)
 *  delivery: cleaners → customers → home (drop clean bags back to customers)
 */
export function endpointsFor(direction: RouteDirection): { startAddr: string; endAddr: string } {
  return direction === "delivery"
    ? { startAddr: DRY_CLEANERS, endAddr: DRIVER_HOME }
    : { startAddr: DRIVER_HOME, endAddr: DRY_CLEANERS };
}

export interface OptimizedStop {
  town: string;
  colony: string;
  addressHint: string | null;
  units: string[];
  orderIds: number[];
  lat: number;
  lng: number;
  ungeocoded: boolean;
}

export interface OptimizedRoute {
  stops: OptimizedStop[];
  totalDistanceKm: number;
  totalDistanceMiles: number;
  mapsUrl: string;
  warnings: string[];
  start: { address: string; lat: number | null; lng: number | null };
  end: { address: string; lat: number | null; lng: number | null };
}

interface Cluster {
  town: string;
  colony: string;
  point: Point;
  orderIds: number[];
  units: string[];
  addressHint: string | null;
  ungeocoded: boolean;
}

function buildMapsUrl(clusters: Cluster[], startAddr: string, endAddr: string): string {
  const wp = clusters
    .map((c) => [c.addressHint, c.colony, c.town, "NY"].filter(Boolean).join(", "))
    .map(encodeURIComponent)
    .join("|");
  const origin = encodeURIComponent(startAddr);
  const destination = encodeURIComponent(endAddr);
  const wpParam = wp ? `&waypoints=${wp}` : "";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}${wpParam}&travelmode=driving`;
}

export async function computeOptimizedRoute(
  orders: Order[],
  direction: RouteDirection = "pickup",
): Promise<OptimizedRoute> {
  const { startAddr, endAddr } = endpointsFor(direction);
  const warnings: string[] = [];
  const startGeo = await geocodeAddress(startAddr).catch(() => null);
  const endGeo =
    endAddr === startAddr
      ? startGeo
      : await geocodeAddress(endAddr).catch(() => null);
  const startInfo = { address: startAddr, lat: startGeo?.lat ?? null, lng: startGeo?.lng ?? null };
  const endInfo = { address: endAddr, lat: endGeo?.lat ?? null, lng: endGeo?.lng ?? null };

  if (orders.length === 0) {
    return {
      stops: [],
      totalDistanceKm: 0,
      totalDistanceMiles: 0,
      mapsUrl: "",
      warnings,
      start: startInfo,
      end: endInfo,
    };
  }

  const clusterMap = new Map<string, Cluster>();
  for (const o of orders) {
    const key = `${o.town}|${o.colony}`;
    let c = clusterMap.get(key);
    if (!c) {
      const geo = await geocodeColony(o.town, o.colony, o.colonyAddress ?? undefined).catch(() => null);
      c = {
        town: o.town,
        colony: o.colony,
        point: geo ? { lat: geo.lat, lng: geo.lng } : { lat: NaN, lng: NaN },
        orderIds: [],
        units: [],
        addressHint: o.colonyAddress ?? null,
        ungeocoded: !geo,
      };
      clusterMap.set(key, c);
      if (!geo) warnings.push(`Could not geocode ${o.colony}, ${o.town}`);
    }
    c.orderIds.push(o.id);
    c.units.push(o.unitNumber);
  }

  for (const c of clusterMap.values()) {
    c.units.sort((a, b) => {
      const an = parseInt(a, 10);
      const bn = parseInt(b, 10);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      return a.localeCompare(b);
    });
  }

  const all = [...clusterMap.values()];
  const geocoded = all.filter((c) => !c.ungeocoded);
  const ungeocoded = all.filter((c) => c.ungeocoded);

  let ordered: Cluster[];
  if (!startGeo || geocoded.length === 0) {
    ordered = [...all].sort(
      (a, b) => a.town.localeCompare(b.town) || a.colony.localeCompare(b.colony),
    );
    if (!startGeo) warnings.push("Could not geocode driver start address");
  } else {
    const end: Point = endGeo ?? startGeo;
    const idx = optimizeRoute(startGeo, geocoded.map((c) => c.point), end);
    ordered = idx.map((i) => geocoded[i]!);
    ordered.push(...ungeocoded);
  }

  let totalKm = 0;
  let prev: Point | null = startGeo;
  const stops: OptimizedStop[] = ordered.map((c) => {
    if (prev && !c.ungeocoded) totalKm += haversineKm(prev, c.point);
    if (!c.ungeocoded) prev = c.point;
    return {
      town: c.town,
      colony: c.colony,
      addressHint: c.addressHint,
      units: c.units,
      orderIds: c.orderIds,
      lat: c.ungeocoded ? NaN : c.point.lat,
      lng: c.ungeocoded ? NaN : c.point.lng,
      ungeocoded: c.ungeocoded,
    };
  });
  if (prev && endGeo) totalKm += haversineKm(prev, endGeo);

  return {
    stops,
    totalDistanceKm: Math.round(totalKm * 10) / 10,
    totalDistanceMiles: Math.round(totalKm * 0.621371 * 10) / 10,
    mapsUrl: buildMapsUrl(ordered, startAddr, endAddr),
    warnings,
    start: startInfo,
    end: endInfo,
  };
}
