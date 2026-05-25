import { db } from "@workspace/db";
import { coloniesTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT =
  process.env["GEOCODER_USER_AGENT"] ??
  "DryCleaningService/1.0 (admin@upstatedrycleaning.example)";

let lastCallAt = 0;
const MIN_INTERVAL_MS = 1100;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = lastCallAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export interface LatLng {
  lat: number;
  lng: number;
  displayLabel?: string;
}

async function nominatim(query: string): Promise<LatLng | null> {
  await rateLimit();
  const url = `${NOMINATIM_URL}?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, query }, "Nominatim non-OK response");
      return null;
    }
    const data = (await res.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
    }>;
    const hit = data[0];
    if (!hit?.lat || !hit?.lon) return null;
    return {
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      displayLabel: hit.display_name,
    };
  } catch (err) {
    logger.warn({ err, query }, "Nominatim fetch failed");
    return null;
  }
}

/**
 * Geocode a colony (cached forever in the colonies table).
 * Tries several query variations to maximize hit rate.
 */
export async function geocodeColony(
  town: string,
  colony: string,
  addressHint?: string | null,
): Promise<LatLng | null> {
  const [existing] = await db
    .select()
    .from(coloniesTable)
    .where(and(eq(coloniesTable.town, town), eq(coloniesTable.name, colony)))
    .limit(1);

  if (existing?.lat != null && existing.lng != null) {
    return {
      lat: existing.lat,
      lng: existing.lng,
      displayLabel: existing.displayLabel ?? undefined,
    };
  }

  // If the addressHint already mentions the town or "NY", use it verbatim —
  // re-appending ", <town>, NY" duplicates context and confuses Nominatim,
  // which has been observed to drop the zip and snap to a same-named street
  // in another part of NY State (e.g. "26 Park St, Liberty, NY 12754" → Albany).
  const hint = addressHint?.trim();
  const hintHasContext =
    !!hint && (hint.toLowerCase().includes(town.toLowerCase()) || /\bny\b/i.test(hint));
  const queries: string[] = [];
  if (hint) queries.push(hintHasContext ? hint : `${hint}, ${town}, NY`);
  queries.push(`${colony}, ${town}, NY`);
  queries.push(`${town}, NY`);

  let hit: LatLng | null = null;
  for (const q of queries) {
    hit = await nominatim(q);
    if (hit) break;
  }

  const now = new Date();
  try {
    if (existing) {
      await db
        .update(coloniesTable)
        .set({
          lat: hit?.lat ?? null,
          lng: hit?.lng ?? null,
          displayLabel: hit?.displayLabel ?? null,
          geocodedAt: now,
        })
        .where(eq(coloniesTable.id, existing.id));
    } else {
      await db
        .insert(coloniesTable)
        .values({
          town,
          name: colony,
          lat: hit?.lat ?? null,
          lng: hit?.lng ?? null,
          displayLabel: hit?.displayLabel ?? null,
          geocodedAt: now,
        })
        .onConflictDoNothing({ target: [coloniesTable.town, coloniesTable.name] });
    }
  } catch (err) {
    logger.warn({ err, town, colony }, "Failed to persist colony geocode");
  }

  return hit;
}

const addressGeoCache = new Map<string, LatLng | null>();

// Hand-curated overrides for landmarks that Nominatim/OSM either doesn't have
// or returns the wrong location for. Keyed by the canonical address string.
// Coordinates verified against the plaza area in Kiamesha Lake (Home Depot /
// ShopRite / Thompson Square Mall sit on the same lot off Concord Rd).
const ADDRESS_OVERRIDES: Record<string, LatLng> = {
  "16 Thompson Square, Monticello, NY 12701": {
    lat: 41.6683,
    lng: -74.6699,
    displayLabel: "Thompson Square Mall, Monticello, NY",
  },
};

/**
 * Geocode a single free-form address. Cached in-process for the lifetime of
 * the server — used primarily for the driver start/end addresses which never
 * change at runtime.
 */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  if (addressGeoCache.has(address)) return addressGeoCache.get(address)!;
  const override = ADDRESS_OVERRIDES[address];
  if (override) {
    addressGeoCache.set(address, override);
    return override;
  }
  const hit = await nominatim(address);
  addressGeoCache.set(address, hit);
  return hit;
}
