import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface MapStop {
  index: number;
  colony: string;
  town: string;
  lat: number;
  lng: number;
  ungeocoded: boolean;
  orderCount: number;
}

interface RouteMapProps {
  start: { address: string; lat: number | null; lng: number | null };
  end: { address: string; lat: number | null; lng: number | null };
  stops: MapStop[];
}

// Build the pin marker as a real DOM node so the numeric label is set via
// textContent (defence in depth — labels come from server-computed stop
// indices, but Leaflet's `html` option does parse strings as HTML).
function numberedIcon(label: string, color: string): L.DivIcon {
  const el = document.createElement("div");
  el.style.cssText =
    `background:${color};color:white;width:28px;height:28px;` +
    `border-radius:50%;display:flex;align-items:center;justify-content:center;` +
    `font-weight:700;font-size:12px;border:2px solid white;` +
    `box-shadow:0 1px 3px rgba(0,0,0,0.4);`;
  el.textContent = label;
  return L.divIcon({
    className: "route-pin",
    html: el,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

// Popup body builder — uses textContent everywhere so SMS-sourced fields
// (colony, town, addresses) can't inject HTML/JS. bindPopup accepts a DOM
// node as well as a string; passing the node bypasses HTML parsing entirely.
function popupNode(title: string, ...lines: string[]): HTMLElement {
  const wrap = document.createElement("div");
  const h = document.createElement("strong");
  h.textContent = title;
  wrap.appendChild(h);
  for (const line of lines) {
    wrap.appendChild(document.createElement("br"));
    const span = document.createElement("span");
    span.textContent = line;
    wrap.appendChild(span);
  }
  return wrap;
}

const PRIMARY = "hsl(215, 50%, 28%)";
const DEPOT = "hsl(8, 70%, 46%)";

export function RouteMap({ start, end, stops }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);

  // Build the geocoded stop list + full polyline path including start/end.
  const { path, geoStops, hasAnyPoint } = useMemo(() => {
    const geo = stops.filter((s) => !s.ungeocoded && Number.isFinite(s.lat) && Number.isFinite(s.lng));
    const p: [number, number][] = [];
    if (start.lat != null && start.lng != null) p.push([start.lat, start.lng]);
    for (const s of geo) p.push([s.lat, s.lng]);
    if (end.lat != null && end.lng != null) p.push([end.lat, end.lng]);
    return { path: p, geoStops: geo, hasAnyPoint: p.length > 0 };
  }, [start, end, stops]);

  // Initialise the map once, then re-sync markers/polyline whenever the path changes.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      scrollWheelZoom: false,
    }).setView([41.732, -74.605], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Clear previous overlays (markers + lines) before redrawing.
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker || layer instanceof L.Polyline) {
        map.removeLayer(layer);
      }
    });
    if (!hasAnyPoint) return;
    // Depot pins (start/end) in warm red so they read distinct from stops.
    if (start.lat != null && start.lng != null) {
      L.marker([start.lat, start.lng], { icon: numberedIcon("A", DEPOT) })
        .addTo(map)
        .bindPopup(popupNode("Start", start.address));
    }
    if (end.lat != null && end.lng != null) {
      L.marker([end.lat, end.lng], { icon: numberedIcon("B", DEPOT) })
        .addTo(map)
        .bindPopup(popupNode("End", end.address));
    }
    // Numbered stop pins in the brand navy.
    for (const s of geoStops) {
      const orderLabel = `${s.orderCount} order${s.orderCount !== 1 ? "s" : ""}`;
      L.marker([s.lat, s.lng], { icon: numberedIcon(String(s.index), PRIMARY) })
        .addTo(map)
        .bindPopup(popupNode(`${s.index}. ${s.colony}`, `${s.town}, NY`, orderLabel));
    }
    // The polyline is straight-line (haversine) — same caveat as the existing
    // distance metric; the "Open in Google Maps" button still gives the real
    // road-following directions.
    if (path.length >= 2) {
      L.polyline(path, { color: PRIMARY, weight: 3, opacity: 0.7, dashArray: "6 6" }).addTo(map);
    }
    const bounds = L.latLngBounds(path.map(([la, ln]) => L.latLng(la, ln)));
    map.fitBounds(bounds, { padding: [30, 30] });
  }, [path, geoStops, hasAnyPoint, start, end]);

  if (!hasAnyPoint) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
        Map unavailable — no geocoded stops to show.
      </div>
    );
  }

  const srSummary = `Route map with ${geoStops.length} stop${geoStops.length !== 1 ? "s" : ""} between depot start and end.`;

  return (
    <>
      <span className="sr-only">{srSummary}</span>
      <div
        ref={containerRef}
        className="h-72 w-full rounded-md border border-border overflow-hidden"
        role="img"
        aria-label={srSummary}
      />
    </>
  );
}
