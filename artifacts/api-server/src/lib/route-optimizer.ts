export interface Point {
  lat: number;
  lng: number;
}

/** Haversine distance in kilometers. */
export function haversineKm(a: Point, b: Point): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Solve open TSP from `start` through `stops`, ending at `end`.
 * Uses nearest-neighbor seeding + 2-opt improvement.
 * Returns the order of indices into `stops` (excluding start/end).
 */
export function optimizeRoute<T extends Point>(
  start: Point,
  stops: T[],
  end: Point,
): number[] {
  const n = stops.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Nearest neighbor from start.
  const remaining = new Set<number>(stops.map((_, i) => i));
  const order: number[] = [];
  let current: Point = start;
  while (remaining.size > 0) {
    let best = -1;
    let bestDist = Infinity;
    for (const i of remaining) {
      const d = haversineKm(current, stops[i]!);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    order.push(best);
    remaining.delete(best);
    current = stops[best]!;
  }

  // 2-opt improvement (bounded iterations).
  const pointAt = (idx: number): Point => {
    if (idx === -1) return start;
    if (idx === n) return end;
    return stops[order[idx]!]!;
  };
  const routeLen = (): number => {
    let total = 0;
    for (let i = -1; i < n; i++) total += haversineKm(pointAt(i), pointAt(i + 1));
    return total;
  };

  let improved = true;
  let iterations = 0;
  const maxIterations = 50;
  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;
    const baseline = routeLen();
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const reversed = [
          ...order.slice(0, i),
          ...order.slice(i, k + 1).reverse(),
          ...order.slice(k + 1),
        ];
        const before = order.slice();
        order.length = 0;
        order.push(...reversed);
        const newLen = routeLen();
        if (newLen + 1e-9 < baseline) {
          improved = true;
          break;
        } else {
          order.length = 0;
          order.push(...before);
        }
      }
      if (improved) break;
    }
  }

  return order;
}
