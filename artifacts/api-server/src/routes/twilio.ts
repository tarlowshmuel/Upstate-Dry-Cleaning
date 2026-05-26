import { Router, type RequestHandler } from "express";
import twilio from "twilio";
import { db } from "@workspace/db";
import { conversationsTable, ordersTable, referralsTable } from "@workspace/db/schema";
import { eq, and, gte, desc, asc, ilike, or, sql } from "drizzle-orm";
import { nextOrderNumber } from "../lib/order-number";
import { customerStatusMessage, notifyAdmin, notifyCustomer, notifyCustomerCancellation, notifyCustomerStatusChange } from "../lib/customer-notify";

const router = Router();

// ─── HELP flow helpers ────────────────────────────────────────────────────────
// Restores a customer's pre-HELP conversation state if one was stashed when
// they entered the help menu, otherwise wipes the conversation row. Keeps the
// help intercept non-destructive to mid-order/referral/reschedule flows.
async function exitHelpRestoringPrev(from: string, stash: string | null): Promise<void> {
  type Prev = {
    step: string | null; name: string | null; town: string | null;
    colony: string | null; colonyAddress: string | null;
    unitNumber: string | null; gateAccess: string | null;
    items: string | null; notes: string | null;
  };
  let prev: Prev | null = null;
  if (stash) {
    try {
      const parsed = JSON.parse(stash) as { prev?: Prev };
      prev = parsed.prev ?? null;
    } catch { prev = null; }
  }
  if (!prev || !prev.step) {
    await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
    return;
  }
  await db.update(conversationsTable)
    .set({
      step: prev.step,
      name: prev.name, town: prev.town, colony: prev.colony,
      colonyAddress: prev.colonyAddress, unitNumber: prev.unitNumber,
      gateAccess: prev.gateAccess, items: prev.items, notes: prev.notes,
      updatedAt: new Date(),
    })
    .where(eq(conversationsTable.phoneNumber, from));
}

// In-memory rate limit for HELP→Other admin forwarding. Single-process server,
// so a Map is enough; a restart clearing counts only helps legitimate users.
// Limits: 60s cooldown between forwards, max 3 forwards per phone per 24h.
const HELP_COOLDOWN_MS = 60_000;
const HELP_DAILY_MAX = 3;
const HELP_DAY_MS = 24 * 60 * 60 * 1000;
const helpForwardLog = new Map<string, number[]>();

function checkHelpRateLimit(from: string): { allowed: true } | { allowed: false; message: string } {
  const now = Date.now();
  const recent = (helpForwardLog.get(from) ?? []).filter((t) => now - t < HELP_DAY_MS);
  if (recent.length > 0 && now - recent[recent.length - 1]! < HELP_COOLDOWN_MS) {
    helpForwardLog.set(from, recent);
    return {
      allowed: false,
      message:
        `You just sent us a message — please give us a minute to respond before sending another. ` +
        `For urgent needs, call (845) 606-0022.`,
    };
  }
  if (recent.length >= HELP_DAILY_MAX) {
    helpForwardLog.set(from, recent);
    return {
      allowed: false,
      message:
        `You've reached the daily limit for help messages. ` +
        `Please call (845) 606-0022 and we'll get back to you as soon as we can.`,
    };
  }
  recent.push(now);
  helpForwardLog.set(from, recent);
  return { allowed: true };
}

// ─── Towns + Schedule ─────────────────────────────────────────────────────────
// Phase 1 Monday is now split into two waves so the driver can run a tight
// morning loop on the dense central-western core, then a shorter afternoon loop
// on the lighter eastern/southern edges. Drop-off is always pickup + 2 days.
//
// Phase 1 = currently servicing (bookable). Each Phase 1 town belongs to one
// wave with its own same-day cutoff:
//   morning   — bags out by 10 AM (5 towns, depot loop ends back at Fallsburg)
//   afternoon — bags out by 12 PM noon (3 towns, lighter eastern/southern edges)
//
// Phase 2 = on the roadmap, not bookable yet. Customer flow politely declines
// these and admin booking hides them. Flip `phase: 2 -> 1` (and pick a `wave`)
// to launch a town — nothing else needs to change.
export type RouteWave = "morning" | "afternoon";
type TownSchedule = {
  pickup: string;
  dropoff: string;
  phase: 1 | 2;
  wave?: RouteWave;
};
const TOWN_SCHEDULE: Record<string, TownSchedule> = {
  // ── Phase 1 · Monday MORNING wave (bags out by 10 AM) ───────────────────
  "Fallsburg":        { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "morning"   },
  "South Fallsburg":  { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "morning"   },
  "Woodbourne":       { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "morning"   },
  "Loch Sheldrake":   { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "morning"   },
  "Hurleyville":      { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "morning"   },
  // ── Phase 1 · Monday AFTERNOON wave (bags out by 12 PM noon) ────────────
  "Woodridge":        { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "afternoon" },
  "Glen Wild":        { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "afternoon" },
  "Dairyland":        { pickup: "Monday", dropoff: "Wednesday", phase: 1, wave: "afternoon" },
  // ── Phase 2 · coming soon, not bookable ──────────────────────────────────
  "Greenfield Park":  { pickup: "Monday",  dropoff: "Wednesday", phase: 2 },
  "Mountaindale":     { pickup: "Monday",  dropoff: "Wednesday", phase: 2 },
  "Rock Hill":        { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
  "Monticello":       { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
  "Kiamesha Lake":    { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
  "Ferndale":         { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
  "Liberty":          { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
  "Parksville":       { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
  "Livingston Manor": { pickup: "Tuesday", dropoff: "Thursday",  phase: 2 },
};

const TOWNS = Object.keys(TOWN_SCHEDULE);
const PHASE_1_TOWNS = TOWNS.filter((t) => TOWN_SCHEDULE[t]!.phase === 1);
function isPhase1(town: string): boolean {
  return TOWN_SCHEDULE[town]?.phase === 1;
}

// Driving order per wave — depot bookends both. The optimizer in
// lib/route-service.ts respects this town ordering when computing a route, so
// stops always appear in the order the driver actually visits them.
//   Morning   : depot (Fallsburg) → Woodbourne → Loch Sheldrake → Hurleyville
//               → South Fallsburg → Fallsburg → depot
//   Afternoon : depot → Glen Wild → Woodridge → Dairyland → depot
export const WAVE_ORDER: Record<RouteWave, string[]> = {
  morning: ["Woodbourne", "Loch Sheldrake", "Hurleyville", "South Fallsburg", "Fallsburg"],
  afternoon: ["Glen Wild", "Woodridge", "Dairyland"],
};

// Same-day cutoff per wave. Customer flow uses this to decide whether today
// still qualifies for pickup (vs. bumping to next Monday).
export const WAVE_CUTOFF_HOUR: Record<RouteWave, number> = {
  morning: 10,    // 10:00 AM
  afternoon: 12,  // 12:00 PM noon
};

function waveOf(town: string): RouteWave | null {
  return TOWN_SCHEDULE[town]?.wave ?? null;
}
export function townsForWave(wave: RouteWave): string[] {
  return Object.entries(TOWN_SCHEDULE)
    .filter(([, s]) => s.wave === wave)
    .map(([name]) => name);
}
function waveCutoffLabel(wave: RouteWave): string {
  return wave === "morning" ? "10:00 AM" : "12:00 PM (noon)";
}
function waveBagsOutLabel(wave: RouteWave): string {
  return wave === "morning" ? "bags out by 10 AM" : "bags out by 12 PM noon";
}

const DAY_NUM: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// Driver home & dry-cleaners addresses live in lib/route-service.ts (single source of truth).

const PAYMENT_PHONE = "(929) 345-0940";

// ─── Referral Program ────────────────────────────────────────────────────────
// Customer earns one $30 free pickup credit per 3 referred customers who
// complete a first paid pickup. Cap of 2 redemptions (i.e. 6 qualified referrals).
const REFERRAL_THRESHOLD = 3;
const REFERRAL_CREDIT_USD = 30;
const REFERRAL_MAX_REDEMPTIONS = 2;
const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://twilio-connect-shmueltarlow.replit.app";
const TERMS_URL = `${PUBLIC_URL}/legal`;

function welcomeIntro(): string {
  return [
    `⏰ Same-day pickup if you order in time: by 10 AM for most towns, by 12 PM noon for Glen Wild, Woodridge & Dairyland. You'll see your exact cutoff when you place your order.`,
    `💵 Payment: Cash or Zelle to ${PAYMENT_PHONE} on delivery.`,
    `🎁 Refer ${REFERRAL_THRESHOLD} neighbors who place a first paid pickup and get a FREE pickup (up to $${REFERRAL_CREDIT_USD}). Text "refer" to add one.`,
    `📄 Terms: ${TERMS_URL}`,
  ].join("\n");
}

// E.164 normalization (matches existing inline logic for admin new-order phone step).
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length < 10) return null;
  if (raw.trim().startsWith("+")) return `+${digits}`;
  // US-default: strip leading "1" if present, then re-add country code.
  const ten = digits.replace(/^1/, "");
  if (ten.length !== 10) return null;
  return `+1${ten}`;
}

function askForNotesMessage(): string {
  return (
    `Almost done! Any special notes for our driver? (e.g. "I won't be home 2–4pm, bag is by the door")\n\n` +
    `Reply with your note, or text "skip" to place your order.`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function twimlResponse(message: string): string {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  return twiml.toString();
}

// MMS variant: attaches a publicly-reachable image URL to the outgoing
// message. Used for the brand-introduction welcome so the customer sees the
// logo alongside the intro text. Falls back gracefully to text-only if the
// carrier or device doesn't support MMS — the body still arrives.
function twimlResponseWithMedia(message: string, mediaUrl: string): string {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = twiml.message(message);
  msg.media(mediaUrl);
  return twiml.toString();
}

// Logo is served by the dashboard's static /public at the published root,
// so PUBLIC_URL + /logo.png is fetchable by Twilio in production.
const LOGO_URL = `${PUBLIC_URL.replace(/\/$/, "")}/logo.png`;

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Business timezone helpers ─────────────────────────────────────────────
// The business operates in America/New_York. In production, the server runs
// in UTC, so naive `now.getDay()`/`now.getHours()` will incorrectly bump a
// 9:59 AM ET customer past the 10 AM morning cutoff. All scheduling-day and
// cutoff-hour decisions must go through `etParts()` so we get the wall-clock
// time the customer actually sees.
const BUSINESS_TZ = "America/New_York";
export function etParts(now: Date = new Date()): {
  year: number; month: number; day: number; hour: number; dayOfWeek: number;
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  // Intl may emit "24" instead of "00" for midnight in 24-hour mode.
  const rawHour = parseInt(parts.hour!, 10);
  return {
    year: parseInt(parts.year!, 10),
    month: parseInt(parts.month!, 10),
    day: parseInt(parts.day!, 10),
    hour: rawHour === 24 ? 0 : rawHour,
    dayOfWeek: dayMap[parts.weekday!]!,
  };
}
export function etTodayDateOnly(now: Date = new Date()): string {
  const { year, month, day } = etParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextPickupDate(town: string, now: Date = new Date()): Date | null {
  const schedule = TOWN_SCHEDULE[town];
  if (!schedule) return null;
  const target = DAY_NUM[schedule.pickup];
  if (target === undefined) return null;
  const et = etParts(now);
  let daysUntil = (target - et.dayOfWeek + 7) % 7;
  // Same-day cutoff: morning towns must place by 10 AM ET, afternoon by noon ET.
  // If we're past the cutoff on pickup day, bump to next week.
  // Phase 2 towns (no wave) fall back to midnight-before behavior.
  if (daysUntil === 0) {
    const wave = schedule.wave;
    if (wave) {
      if (et.hour >= WAVE_CUTOFF_HOUR[wave]) daysUntil = 7;
    } else {
      daysUntil = 7;
    }
  }
  // Build pickup date from the ET calendar day so we don't drift across the
  // UTC date boundary at night. DB column is date-only, so storing as
  // server-local midnight of the right day is fine for downstream matching.
  const d = new Date(et.year, et.month - 1, et.day);
  d.setDate(d.getDate() + daysUntil);
  return d;
}

function nextDropoffDate(pickupDate: Date): Date {
  // Both schedules are pickup + 2 days
  const d = new Date(pickupDate);
  d.setDate(d.getDate() + 2);
  return d;
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

// Customer-facing town picker. Shows Phase 1 (bookable) towns numbered, then
// a "Coming soon" footer listing Phase 2 towns so customers in those areas
// see we're expanding to them. The numbers only map to Phase 1 — picking a
// Phase 2 name isn't a valid selection (the flow rejects by number range).
function customerTownList(): string {
  const numbered = PHASE_1_TOWNS.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const phase2 = TOWNS.filter((t) => !isPhase1(t));
  if (phase2.length === 0) return numbered;
  return `${numbered}\n\n🚧 Coming soon: ${phase2.join(", ")}`;
}

// Admin booking pickers — only show Phase 1 since admins can't book unserviced
// areas either. Numbers stay aligned with PHASE_1_TOWNS indexing.
function adminTownList(): string {
  return PHASE_1_TOWNS.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

// Public read-only endpoint so the dashboard can show the towns + auto-fill
// pickup date when the admin picks a town in the New Order dialog. Only
// Phase 1 (currently servicing) towns are returned — Phase 2 is intentionally
// hidden from the dashboard booking UI.
router.get("/towns", (_req, res) => {
  const now = new Date();
  res.json(
    PHASE_1_TOWNS.map((name) => {
      const sched = TOWN_SCHEDULE[name]!;
      const next = nextPickupDate(name, now);
      return {
        name,
        pickupDay: sched.pickup,
        dropoffDay: sched.dropoff,
        nextPickupDate: next ? toDateOnly(next) : null,
      };
    }),
  );
});

// Parse free-form items text like "2 suits, 3 dress shirts, 1 coat" → { Suit: 2, Dress Shirt: 3, Coat: 1 }
function parseItemsText(text: string | null): Record<string, number> {
  if (!text) return {};
  const result: Record<string, number> = {};
  // Match: number followed by item name (until comma, "and", or end)
  const regex = /(\d+)\s+([a-zA-Z][a-zA-Z\s/-]*?)(?=\s*(?:,|;|and|$|\s+\d+\s+[a-zA-Z]))/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const qty = parseInt(match[1]!);
    let name = match[2]!.trim().toLowerCase();
    // Strip trailing plural 's' for normalization (suits → suit, dresses → dresse... handled below)
    if (name.endsWith("es") && (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes"))) {
      name = name.slice(0, -2);
    } else if (name.endsWith("s") && !name.endsWith("ss")) {
      name = name.slice(0, -1);
    }
    // Title case
    name = name.replace(/\b\w/g, c => c.toUpperCase());
    if (name && qty > 0) {
      result[name] = (result[name] ?? 0) + qty;
    }
  }
  return result;
}

type OrderRow = typeof ordersTable.$inferSelect;

function formatOrder(o: OrderRow): string {
  const gate = o.gateAccess ? `Gate: ${o.gateAccess}` : "No gate";
  const addr = o.colonyAddress ? `${o.colonyAddress}, ` : "";
  const notesLine = o.notes ? `\n📝 Notes: ${o.notes}` : "";
  const itemsLine = `\n📦 Items: ${o.items ?? "(not set)"}`;
  const pickup = o.pickupDate ? `Pickup: ${o.pickupDate}\n` : "";
  const paid = o.paid ? "PAID ✓" : "UNPAID";
  return `#${o.id} | ${o.orderNumber}\n${o.name} | ${o.phoneNumber}\n${addr}${o.colony}, ${o.town}\nUnit: ${o.unitNumber} | ${gate}${itemsLine}${notesLine}\n${pickup}Status: ${o.status} | ${paid}`;
}

// ─── Admin Menu System ─────────────────────────────────────────────────────────
const ADMIN_MAIN_MENU = [
  "🧺 ADMIN MENU",
  "",
  "1. Today's pickups",
  "2. Orders at cleaners",
  "3. Pending orders",
  "4. Unpaid orders",
  "5. Missed pickups",
  "6. Route (pick any day)",
  "7. Stats",
  "8. Look up an order",
  "9. Update an order",
  "10. New order",
  "11. Filtered list (uses current filters)",
  "12. Delivery route (cleaners → homes)",
  "13. Earnings (today/week/month/all)",
  "14. Bulk status update (drop off / ready / delivered)",
  "15. Settings (fee, minimum, wholesale %)",
  "16. Price list (edit prices)",
  "",
  'Sort: "sort newest|oldest|pickup|name"',
  'Range: "range today|week|all"',
  'Filter: "filter status pending|picked_up|at_cleaners|ready|delivered|missed|all"',
  '        "filter paid yes|no|all"',
  'Clear:  "reset"',
  'Credit: "credit <orderId>"  (apply a referral credit)',
  'Reply with a number (or "menu" anytime).',
].join("\n");

// ─── Admin preferences (sort / time range / status / paid filter) ────────────
// In-memory because admin is a single user; resets on restart, which is fine.
type SortKey = "newest" | "oldest" | "pickup-asc" | "name";
type RangeKey = "today" | "week" | "all";
type StatusFilter = "all" | "pending" | "picked_up" | "at_cleaners" | "ready" | "delivered" | "missed";
type PaidFilter = "all" | "paid" | "unpaid";
interface AdminPrefs { sort: SortKey; range: RangeKey; status: StatusFilter; paid: PaidFilter }
const adminPrefs = new Map<string, AdminPrefs>();
const DEFAULT_PREFS: AdminPrefs = { sort: "newest", range: "all", status: "all", paid: "all" };
function getPrefs(phone: string): AdminPrefs {
  let p = adminPrefs.get(phone);
  if (!p) { p = { ...DEFAULT_PREFS }; adminPrefs.set(phone, p); }
  return p;
}
function resetPrefs(phone: string): void {
  adminPrefs.set(phone, { ...DEFAULT_PREFS });
}
function sortOrders(orders: OrderRow[], sort: SortKey): OrderRow[] {
  const arr = [...orders];
  switch (sort) {
    case "newest":     return arr.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    case "oldest":     return arr.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
    case "pickup-asc": return arr.sort((a, b) => (a.pickupDate ?? "").localeCompare(b.pickupDate ?? ""));
    case "name":       return arr.sort((a, b) => a.name.localeCompare(b.name));
  }
}
function rangeWhereClause(range: RangeKey) {
  if (range === "today") return eq(ordersTable.pickupDate, toDateOnly(new Date()));
  if (range === "week") {
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7); weekAgo.setHours(0, 0, 0, 0);
    return gte(ordersTable.createdAt, weekAgo);
  }
  return undefined;
}
function prefsBadge(p: AdminPrefs): string {
  const parts = [`sort=${p.sort}`, `range=${p.range}`];
  if (p.status !== "all") parts.push(`status=${p.status}`);
  if (p.paid !== "all") parts.push(`paid=${p.paid}`);
  return `[${parts.join(" · ")}]`;
}

// Generic listing that applies every active filter (status + paid + range + sort).
async function actionFiltered(prefs: AdminPrefs): Promise<string> {
  const whereParts = [];
  if (prefs.status !== "all") whereParts.push(eq(ordersTable.status, prefs.status));
  if (prefs.paid === "paid") whereParts.push(eq(ordersTable.paid, true));
  if (prefs.paid === "unpaid") whereParts.push(eq(ordersTable.paid, false));
  const rangeWhere = rangeWhereClause(prefs.range);
  if (rangeWhere) whereParts.push(rangeWhere);
  const orders = await db
    .select().from(ordersTable)
    .where(whereParts.length === 0 ? undefined : whereParts.length === 1 ? whereParts[0] : and(...whereParts));
  if (orders.length === 0) return `No orders match the current filters ${prefsBadge(prefs)}.`;
  const sorted = sortOrders(orders, prefs.sort);
  return `FILTERED LIST (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

const ADMIN_STATS_MENU = [
  "📊 STATS — pick a range:",
  "",
  "1. Today",
  "2. This week",
  "3. All time",
  "",
  "0. Back to menu",
].join("\n");

const ADMIN_EARNINGS_MENU = [
  "📊 EARNINGS — pick a range:",
  "",
  "1. Today",
  "2. This week",
  "3. This month",
  "4. All time",
  "",
  "0. Back to menu",
].join("\n");

// Earnings summary used by both the earnings range submenu AND case "13"
// callers. Reuses the same computeEarningsReport the dashboard hits so SMS
// and dashboard never disagree — see .agents/memory/sms-dashboard-parity.md.
async function buildEarningsSmsSummary(
  range: "today" | "week" | "month" | "all",
): Promise<string> {
  const { computeEarningsReport } = await import("./earnings");
  const r = await computeEarningsReport(range);
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  const label = { today: "Today", week: "This week", month: "This month", all: "All time" }[range];
  const byDayLines = r.byRouteDay
    .slice(0, 5)
    .map((d) => `  ${d.date === "no-date" ? "(no date)" : d.date}: ${d.count} · ${fmt(d.revenueCents)}`)
    .join("\n");
  return [
    `📊 EARNINGS — ${label}`,
    ``,
    `Orders: ${r.orderCount}`,
    `Gross: ${fmt(r.grossRevenueCents)}`,
    `  Items: ${fmt(r.itemsRevenueCents)} (wholesale base)`,
    `  Fees: ${fmt(r.feesCollectedCents)} (kept in full)`,
    `Paid: ${fmt(r.paidCents)}  ·  Outstanding: ${fmt(r.outstandingCents)}`,
    `By method: Zelle ${fmt(r.byMethod.zelle)} · Cash ${fmt(r.byMethod.cash)} · Unspec ${fmt(r.byMethod.unknown)}`,
    `Profit est: ${fmt(r.profitEstimateCents)} (${r.wholesalePercent}% wholesale on items only)`,
    ``,
    byDayLines ? `By pickup day (top 5):\n${byDayLines}` : `(No orders in this range.)`,
  ].join("\n");
}

async function buildAdminBulkMenu(): Promise<string> {
  // Live counts so the operator sees how many orders each option will move
  // BEFORE confirming — matches the dashboard's BulkActionsMenu badge UX.
  const [pickedUp, atCleaners, ready] = await Promise.all([
    db.$count(ordersTable, eq(ordersTable.status, "picked_up")),
    db.$count(ordersTable, eq(ordersTable.status, "at_cleaners")),
    db.$count(ordersTable, eq(ordersTable.status, "ready")),
  ]);
  return [
    `📦 BULK STATUS UPDATE`,
    ``,
    `1. Drop all at cleaners  (${pickedUp} picked-up → at-cleaners)`,
    `2. Mark all ready        (${atCleaners} at-cleaners → ready)`,
    `3. Mark all delivered    (${ready} ready → delivered)`,
    ``,
    `Customers are notified per order, same as the dashboard.`,
    ``,
    `0. Back to menu`,
  ].join("\n");
}

async function buildAdminSettingsMenu(): Promise<string> {
  const { SETTING_KEYS, SETTING_DEFAULTS, settingsTable } = await import("@workspace/db/schema");
  const rows = await db.select().from(settingsTable);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.key] = r.value;
  const fee = map[SETTING_KEYS.feeCents] ?? SETTING_DEFAULTS[SETTING_KEYS.feeCents]!;
  const min = map[SETTING_KEYS.orderMinimumCents] ?? SETTING_DEFAULTS[SETTING_KEYS.orderMinimumCents]!;
  const wh = map[SETTING_KEYS.wholesalePercent] ?? SETTING_DEFAULTS[SETTING_KEYS.wholesalePercent]!;
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  return [
    `⚙️ SETTINGS`,
    ``,
    `1. Delivery fee       — currently ${fmt(fee)}`,
    `2. Order minimum      — currently ${fmt(min)}`,
    `3. Wholesale %        — currently ${wh}% (items only)`,
    ``,
    `Changes apply to NEW orders; existing orders keep their snapshot.`,
    ``,
    `0. Back to menu`,
  ].join("\n");
}

type SettingKey = "feeCents" | "orderMinimumCents" | "wholesalePercent";
async function updateOneSetting(key: SettingKey, value: number): Promise<void> {
  const { SETTING_KEYS, settingsTable } = await import("@workspace/db/schema");
  const dbKey = SETTING_KEYS[key];
  await db
    .insert(settingsTable)
    .values({ key: dbKey, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

async function buildPriceListIdsScratch(): Promise<string> {
  const { priceListTable } = await import("@workspace/db/schema");
  const rows = await db
    .select({ id: priceListTable.id })
    .from(priceListTable)
    .where(eq(priceListTable.active, true))
    .orderBy(asc(priceListTable.sortOrder), asc(priceListTable.id));
  return rows.map((r) => r.id).join(",");
}

async function buildAdminPriceListMenu(): Promise<string> {
  const { priceListTable } = await import("@workspace/db/schema");
  const rows = await db
    .select()
    .from(priceListTable)
    .where(eq(priceListTable.active, true))
    .orderBy(asc(priceListTable.sortOrder), asc(priceListTable.id));
  const lines = rows.map(
    (r, i) => `${i + 1}. ${r.name} — $${(r.priceCents / 100).toFixed(2)}`,
  );
  return [
    `💲 PRICE LIST (${rows.length} active)`,
    ``,
    ...(lines.length ? lines : ["(no active items)"]),
    ``,
    `Reply with a number to edit, "+" to add a new item, or "0" to go back.`,
  ].join("\n");
}

function adminUpdateMenu(order: OrderRow): string {
  return [
    `✏️ UPDATE Order #${order.id} — ${order.name}`,
    `Status: ${order.status} | ${order.paid ? "PAID" : "UNPAID"}`,
    ``,
    `── Status ──`,
    `1. Mark picked up (from home) 📩`,
    `2. Mark dropped at cleaners`,
    `3. Mark ready (back from cleaners)`,
    `4. Mark delivered 📩`,
    `5. Mark missed 📩`,
    `6. Mark paid`,
    `7. Mark unpaid`,
    ``,
    `── Edit fields ──`,
    `8. Items`,
    `9. Name`,
    `10. Phone`,
    `11. Address (town · colony · unit/gate)`,
    `12. Pickup date`,
    `13. Notes`,
    ``,
    `── Danger ──`,
    `14. Cancel order (texts customer)`,
    ``,
    `0. Back to menu`,
    `(📩 = customer notified)`,
  ].join("\n");
}

async function setAdminStep(phone: string, step: string, scratch: string | null = null): Promise<void> {
  await db
    .insert(conversationsTable)
    .values({ phoneNumber: phone, step, items: scratch })
    .onConflictDoUpdate({
      target: conversationsTable.phoneNumber,
      set: { step, items: scratch, updatedAt: new Date() },
    });
}

// ─── Admin Actions (data fetchers) ─────────────────────────────────────────────
async function actionTodayPickups(prefs: AdminPrefs): Promise<string> {
  const today = toDateOnly(new Date());
  const orders = await db
    .select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, today)));
  if (orders.length === 0) return "No pickups scheduled for today.";
  const sorted = sortOrders(orders, prefs.sort);
  return `TODAY'S PICKUPS (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

async function actionTodayReturns(prefs: AdminPrefs): Promise<string> {
  // "At cleaners" view = anything in our hands but not yet delivered: picked up
  // from home, sitting at the cleaners, or ready to go back. Excludes pending
  // (still at customer) and delivered/missed.
  const orders = await db
    .select().from(ordersTable)
    .where(
      or(
        eq(ordersTable.status, "picked_up"),
        eq(ordersTable.status, "at_cleaners"),
        eq(ordersTable.status, "ready"),
      )!,
    );
  if (orders.length === 0) return "No orders at the cleaners.";
  const sorted = sortOrders(orders, prefs.sort);
  return `AT CLEANERS (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

async function actionPending(prefs: AdminPrefs): Promise<string> {
  const baseWhere = eq(ordersTable.status, "pending");
  const rangeWhere = rangeWhereClause(prefs.range);
  const orders = await db
    .select().from(ordersTable)
    .where(rangeWhere ? and(baseWhere, rangeWhere) : baseWhere);
  if (orders.length === 0) return `No pending orders ${prefsBadge(prefs)}.`;
  const sorted = sortOrders(orders, prefs.sort);
  return `PENDING (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

async function actionUnpaid(prefs: AdminPrefs): Promise<string> {
  const baseWhere = eq(ordersTable.paid, false);
  const rangeWhere = rangeWhereClause(prefs.range);
  const orders = await db
    .select().from(ordersTable)
    .where(rangeWhere ? and(baseWhere, rangeWhere) : baseWhere);
  if (orders.length === 0) return `All orders paid 🎉 ${prefsBadge(prefs)}.`;
  const sorted = sortOrders(orders, prefs.sort);
  return `UNPAID (${orders.length}) ${prefsBadge(prefs)}:\n\n` + sorted.map(formatOrder).join("\n\n---\n\n");
}

// ─── Missed pickups ───────────────────────────────────────────────────────────
// Any pending order whose pickup date is today-or-earlier counts as at-risk.
async function actionMissed(): Promise<{ message: string; ids: string }> {
  const today = toDateOnly(new Date());
  const orders = await db.select().from(ordersTable)
    .where(and(eq(ordersTable.status, "pending"), sql`${ordersTable.pickupDate} <= ${today}`))
    .orderBy(ordersTable.pickupDate);
  if (orders.length === 0) {
    return { message: "✅ No missed pickups.\n\n0. Back to menu", ids: "" };
  }
  const lines = orders.map((o, i) =>
    `${i + 1}. ${o.orderNumber} — ${o.name} · ${o.colony}, ${o.town} (pickup ${o.pickupDate})`
  ).join("\n");
  return {
    message:
      `🚨 MISSED / AT-RISK (${orders.length}):\n\n${lines}\n\n` +
      `Reply with numbers to mark missed (e.g. "1,3"), "all" for everything, or "0" to cancel.\n` +
      `(Customers will be auto-notified to reschedule.)`,
    ids: orders.map((o) => o.id).join(","),
  };
}
async function actionMarkMissedBatch(ids: number[]): Promise<string> {
  let ok = 0, skipped = 0;
  for (const id of ids) {
    // Conditional update — only flip orders that are still pending. Avoids
    // regressing orders that moved on (picked_up/delivered) since the list
    // was generated.
    const updated = await db.update(ordersTable)
      .set({ status: "missed" })
      .where(and(eq(ordersTable.id, id), eq(ordersTable.status, "pending")))
      .returning();
    if (updated.length === 0) { skipped++; continue; }
    const o = updated[0]!;
    const msg = customerStatusMessage(o, "missed");
    if (msg) await notifyCustomer(o, msg);
    ok++;
  }
  return `✅ Marked ${ok} order${ok !== 1 ? "s" : ""} missed; customer${ok !== 1 ? "s" : ""} notified.` +
         (skipped ? ` (${skipped} skipped — already updated since list was generated)` : "");
}

// ─── Route day picker ─────────────────────────────────────────────────────────
// ─── Operating-day rules ─────────────────────────────────────────────────────
// The business runs Mon–Thu only (pickup Mon/Tue, dropoff Wed/Thu).
// Sun/Fri/Sat have no routes at all.
const ROUTE_DAYS = new Set([1, 2, 3, 4]); // Mon, Tue, Wed, Thu
const WD_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function isRouteDay(d: Date): boolean { return ROUTE_DAYS.has(d.getDay()); }
function isoToDate(iso: string): Date {
  const [y, m, day] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y!, (m ?? 1) - 1, day ?? 1);
}

type RouteDir = "pickup" | "delivery";
function routeHeader(dir: RouteDir): string {
  return dir === "delivery" ? "🚚 DELIVERY ROUTE" : "🚚 ROUTE";
}
function buildRouteDayMenu(dir: RouteDir = "pickup"): { message: string; dates: string[] } {
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Anchor on the ET calendar day, not the server's local day — otherwise a
  // late-evening UTC server would show tomorrow's date as "today" to an ET admin.
  const et = etParts();
  const today = new Date(et.year, et.month - 1, et.day);
  const header = dir === "delivery"
    ? "🚚 DELIVERY ROUTE — pick a day (cleaners → homes):"
    : "🚚 ROUTE — pick a day:";
  const lines: string[] = [header, ""];
  const dates: string[] = [];
  // Walk forward up to 14 days to collect the next 7 operating days (Mon–Thu).
  for (let i = 0; i < 14 && dates.length < 7; i++) {
    const d = new Date(today); d.setDate(today.getDate() + i);
    if (!isRouteDay(d)) continue;
    const label = `${wd[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}${i === 0 ? " (Today)" : ""}`;
    lines.push(`${dates.length + 1}. ${label}`);
    dates.push(toDateOnly(d));
  }
  lines.push("", "(Sun/Fri/Sat are not operating days.)", "", "0. Back to menu");
  return { message: lines.join("\n"), dates };
}

// Returns the wave-filtered orders plus any "orphan" orders — orders eligible
// for today's route by date/status but whose town isn't assigned to any wave.
// Orphans must surface as a warning so they don't silently disappear when an
// admin renames a town or a Phase 2 leftover sits in the queue.
async function fetchRouteOrders(date: string, dir: RouteDir, wave: RouteWave): Promise<{
  orders: typeof ordersTable.$inferSelect[];
  orphans: typeof ordersTable.$inferSelect[];
}> {
  const waveTownSet = new Set(townsForWave(wave));
  const otherWaveTownSet = new Set(townsForWave(wave === "morning" ? "afternoon" : "morning"));
  const rows = dir === "delivery"
    // Delivery = anything currently at the cleaners, ready to be returned home.
    // We don't filter by pickupDate — once an order is "picked_up", it sits at
    // the cleaners until delivered, regardless of which day it was collected.
    ? await db.select().from(ordersTable).where(eq(ordersTable.status, "ready"))
    : await db.select().from(ordersTable)
        .where(and(eq(ordersTable.status, "pending"), eq(ordersTable.pickupDate, date)));
  const orders = rows.filter((o) => waveTownSet.has(o.town));
  const orphans = rows.filter((o) => !waveTownSet.has(o.town) && !otherWaveTownSet.has(o.town));
  return { orders, orphans };
}

function formatRouteMessage(
  dir: RouteDir,
  dateLabel: string,
  wave: RouteWave,
  orders: { id: number; unitNumber: string; name: string; gateAccess: string | null; phoneNumber: string }[],
  route: { stops: { colony: string; addressHint: string | null; town: string; orderIds: number[] }[]; totalDistanceMiles: number; start: { address: string }; end: { address: string }; warnings: string[] },
): string {
  const waveTag = wave === "morning" ? "MORNING" : "AFTERNOON";
  let msg = `${routeHeader(dir)} ${waveTag} (${waveBagsOutLabel(wave)}) — ${dateLabel} — ${route.stops.length} stop${route.stops.length !== 1 ? "s" : ""}`;
  if (route.totalDistanceMiles > 0) msg += ` · ~${route.totalDistanceMiles} mi`;
  msg += `\nStart: ${route.start.address}\n`;
  route.stops.forEach((s, i) => {
    const oh = orders.filter((o) => s.orderIds.includes(o.id));
    msg += `\n${i + 1}. ${s.colony}${s.addressHint ? ` (${s.addressHint})` : ""}, ${s.town}\n`;
    oh.forEach((o) => {
      const gate = o.gateAccess ? ` · Gate ${o.gateAccess}` : "";
      msg += `   • Unit ${o.unitNumber} — ${o.name}${gate}\n     📞 ${o.phoneNumber}\n`;
    });
  });
  msg += `\nEnd: ${route.end.address}`;
  if (route.warnings.length > 0) msg += `\n\n⚠️ ${route.warnings.join("; ")}`;
  return msg;
}

async function actionRouteForDate(date: string, dir: RouteDir, wave: RouteWave): Promise<string> {
  const d = isoToDate(date);
  if (!isRouteDay(d)) {
    return `No route on ${WD_FULL[d.getDay()]} (${date}). The business runs Mon–Thu only.`;
  }
  const { orders, orphans } = await fetchRouteOrders(date, dir, wave);
  const orphanWarning = orphans.length > 0
    ? `\n\n⚠️ ${orphans.length} order${orphans.length !== 1 ? "s" : ""} not in any wave (towns: ${[...new Set(orphans.map((o) => o.town))].join(", ")}). Reassign the town(s) or update the order(s).`
    : "";
  if (orders.length === 0) {
    const base = dir === "delivery"
      ? `No ${wave} deliveries — nothing from that wave is currently at the cleaners.`
      : `No ${wave} pickups for ${date}.`;
    return base + orphanWarning;
  }
  const { computeOptimizedRoute } = await import("../lib/route-service");
  const route = await computeOptimizedRoute(orders, dir, { townOrder: WAVE_ORDER[wave] });
  return formatRouteMessage(dir, date, wave, orders, route) + orphanWarning;
}

function buildWavePickerMenu(dir: RouteDir, date: string): string {
  const d = isoToDate(date);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dateLabel = `${wd[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
  const header = dir === "delivery" ? "🚚 DELIVERY ROUTE" : "🚚 ROUTE";
  return [
    `${header} — ${dateLabel} — which wave?`,
    ``,
    `1. Morning  (bags out by 10 AM)`,
    `   Woodbourne → Loch Sheldrake → Hurleyville → S. Fallsburg → Fallsburg`,
    ``,
    `2. Afternoon (bags out by 12 PM noon)`,
    `   Glen Wild → Woodridge → Dairyland`,
    ``,
    `0. Back to menu`,
  ].join("\n");
}

// ─── New-order (admin-initiated) flow scratch ─────────────────────────────────
// Multi-step state stashed as JSON in conversationsTable.items.
interface NewOrderScratch {
  phone?: string;
  name?: string;
  town?: string;
  colony?: string;
  address?: string;
  unit?: string;
  gate?: string | null;
  items?: string;
}
function readScratch(s: string | null): NewOrderScratch {
  if (!s) return {};
  try { return JSON.parse(s) as NewOrderScratch; } catch { return {}; }
}
function writeScratch(o: NewOrderScratch): string { return JSON.stringify(o); }

async function actionStats(range: "today" | "week" | "all"): Promise<string> {
  let whereClause;
  let label = "ALL TIME";
  if (range === "today") {
    const today = toDateOnly(new Date());
    whereClause = eq(ordersTable.pickupDate, today);
    label = "TODAY";
  } else if (range === "week") {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    weekAgo.setHours(0, 0, 0, 0);
    whereClause = gte(ordersTable.createdAt, weekAgo);
    label = "THIS WEEK";
  }

  const orders = whereClause
    ? await db.select().from(ordersTable).where(whereClause)
    : await db.select().from(ordersTable);

  if (orders.length === 0) return `No orders for ${label.toLowerCase()}.`;

  const totals: Record<string, number> = {};
  let totalItemCount = 0;
  const statusCounts: Record<string, number> = {};
  for (const o of orders) {
    statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1;
    const parsed = parseItemsText(o.items);
    for (const [name, qty] of Object.entries(parsed)) {
      totals[name] = (totals[name] ?? 0) + qty;
      totalItemCount += qty;
    }
  }

  const sortedItems = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const itemLines = sortedItems.map(([name, qty]) => `  ${qty}x ${name}`).join("\n");
  const statusLines = Object.entries(statusCounts).map(([s, c]) => `  ${s}: ${c}`).join("\n");

  return [
    `📊 STATS — ${label}`,
    ``,
    `Orders: ${orders.length}`,
    `Total items: ${totalItemCount}`,
    ``,
    `By status:`,
    statusLines,
    ``,
    `Items breakdown:`,
    itemLines || "  (no parseable items)",
  ].join("\n");
}

async function actionUpdateBrowse(): Promise<{ message: string; ids: string }> {
  const recent = await db.select().from(ordersTable)
    .where(sql`${ordersTable.status} <> 'delivered'`)
    .orderBy(desc(ordersTable.createdAt))
    .limit(10);
  if (recent.length === 0) {
    return {
      message: `✏️ UPDATE — no active orders.\n\nReply with a name, phone digits, or order # (DRY-…) to search older orders.\n\n0. Back to menu`,
      ids: "",
    };
  }
  const lines = recent.map((o, i) =>
    `${i + 1}. ${o.orderNumber} — ${o.name} (${o.status}${o.paid ? ", paid" : ""})`
  ).join("\n");
  return {
    message: `✏️ UPDATE — pick a recent order:\n\n${lines}\n\nOr reply with a name or order # (DRY-…) to search.\n\n0. Back to menu`,
    ids: recent.map((o) => o.id).join(","),
  };
}

async function actionLookup(id: number): Promise<string> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) return `No order found with ID ${id}.`;
  return formatOrder(order);
}

// Search by ID (exact), phone fragment (digits), or name (text). Returns matches newest-first.
async function searchOrders(rawQuery: string): Promise<OrderRow[]> {
  const q = rawQuery.trim();
  if (!q) return [];

  // Pure digits: try ID first if short, then phone fragment.
  if (/^\d+$/.test(q)) {
    if (q.length <= 5) {
      const byId = await db.select().from(ordersTable)
        .where(eq(ordersTable.id, parseInt(q, 10))).limit(1);
      if (byId.length) return byId;
    }
    const byDigits = await db.select().from(ordersTable)
      .where(sql`regexp_replace(${ordersTable.phoneNumber}, '\\D', '', 'g') LIKE ${'%' + q + '%'}`)
      .orderBy(desc(ordersTable.createdAt))
      .limit(20);
    return byDigits;
  }

  // Text: case-insensitive name / colony / order-number match.
  return await db.select().from(ordersTable)
    .where(or(
      ilike(ordersTable.name, `%${q}%`),
      ilike(ordersTable.colony, `%${q}%`),
      ilike(ordersTable.orderNumber, `%${q}%`),
    ))
    .orderBy(desc(ordersTable.createdAt))
    .limit(20);
}

function formatMatchList(matches: OrderRow[]): string {
  return matches.map((o, i) => {
    const paid = o.paid ? "paid" : "unpaid";
    return `${i + 1}. #${o.id} ${o.name} — ${o.colony}, ${o.town} (${o.status}, ${paid})`;
  }).join("\n");
}

// ─── Referral Helpers ────────────────────────────────────────────────────────
// Stats + qualification logic live in lib/referrals so the dashboard's PATCH
// /orders/:id/paid endpoint can share the qualification hook.
import {
  getReferralStats,
  qualifyReferralsFor,
  applyReferralCredit,
  type ReferralStats,
} from "../lib/referrals";

function formatReferralStatus(stats: ReferralStats): string {
  const lines = [
    `🎁 YOUR REFERRALS`,
    ``,
    `Referred: ${stats.total} (${stats.qualified} qualified, ${stats.pending} pending)`,
    `Credits earned: ${stats.creditsEarned} of ${REFERRAL_MAX_REDEMPTIONS} max`,
    `Credits used: ${stats.creditsUsed}`,
    `Credits available: ${stats.creditsAvailable} × $${REFERRAL_CREDIT_USD} FREE pickup`,
    ``,
  ];
  if (stats.atCap) {
    lines.push(`You've hit the lifetime cap — thanks for spreading the word! 🙌`);
  } else {
    const nextThreshold = (Math.floor(stats.qualified / REFERRAL_THRESHOLD) + 1) * REFERRAL_THRESHOLD;
    const need = Math.max(0, nextThreshold - stats.qualified);
    if (need === 0) {
      lines.push(`Your next credit unlocks as soon as one more referred neighbor completes their first paid pickup.`);
    } else {
      lines.push(`${need} more qualified referral${need !== 1 ? "s" : ""} = your next free pickup.`);
    }
    lines.push(``, `Text "refer" to add another, or "clean" to schedule a pickup.`);
  }
  return lines.join("\n");
}

// ─── Customer Notifications ───────────────────────────────────────────────────
// Helpers live in ../lib/customer-notify so the dashboard PATCH path can call
// them too — keeping SMS↔dashboard side effects in lockstep.
// See: .agents/memory/sms-dashboard-parity.md

async function actionApplyUpdate(id: number, choice: string): Promise<string> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  if (!order) return `Order #${id} not found.`;

  let newStatus: "picked_up" | "at_cleaners" | "ready" | "delivered" | "missed" | null = null;
  let paidUpdate: boolean | null = null;
  let baseReply = "";

  switch (choice) {
    case "1":
      newStatus = "picked_up";
      baseReply = `✅ Order #${id} (${order.name}) — marked picked up from home.`;
      break;
    case "2":
      newStatus = "at_cleaners";
      baseReply = `✅ Order #${id} (${order.name}) — marked dropped at cleaners.`;
      break;
    case "3":
      newStatus = "ready";
      baseReply = `✅ Order #${id} (${order.name}) — marked ready (back from cleaners).`;
      break;
    case "4":
      newStatus = "delivered";
      baseReply = `✅ Order #${id} (${order.name}) — marked delivered.`;
      break;
    case "5":
      newStatus = "missed";
      baseReply = `✅ Order #${id} (${order.name}) — marked missed.`;
      break;
    case "6":
      paidUpdate = true;
      baseReply = `✅ Order #${id} (${order.name}) — marked PAID.`;
      break;
    case "7":
      paidUpdate = false;
      baseReply = `✅ Order #${id} (${order.name}) — marked UNPAID.`;
      break;
    default:
      return "Invalid choice.";
  }

  if (newStatus) {
    await db.update(ordersTable).set({ status: newStatus }).where(eq(ordersTable.id, id));
    const updatedOrder = { ...order, status: newStatus };
    const suffix = await notifyCustomerStatusChange(updatedOrder, newStatus);
    return baseReply + suffix;
  }

  if (paidUpdate !== null) {
    // Shared with the dashboard PATCH /orders/:id/paid path — single source of
    // truth for paid side effects (paidAt stamp, paid-confirmation SMS dedup,
    // referral qualification). See .agents/memory/sms-dashboard-parity.md.
    const { markOrderPaid } = await import("../lib/paid-toggle");
    await markOrderPaid(id, { paid: paidUpdate });
    return baseReply;
  }

  return baseReply;
}

// ─── Admin Menu Handler ────────────────────────────────────────────────────────
async function handleAdminCommand(from: string, text: string, raw: string): Promise<string> {
  // Universal "menu" / "back" / empty resets to main menu
  if (text === "menu" || text === "back" || text === "0" || text === "help" || text === "") {
    await setAdminStep(from, "admin_main");
    return ADMIN_MAIN_MENU;
  }

  // ── Inline sort/range commands — usable from any state ────────────────────
  const sortMatch = text.match(/^sort\s+(newest|oldest|pickup|name)$/);
  if (sortMatch) {
    const map: Record<string, SortKey> = {
      newest: "newest", oldest: "oldest", pickup: "pickup-asc", name: "name",
    };
    getPrefs(from).sort = map[sortMatch[1]!]!;
    await setAdminStep(from, "admin_main");
    return `✅ Sort set to ${sortMatch[1]}.\n\n${ADMIN_MAIN_MENU}`;
  }
  const rangeMatch = text.match(/^range\s+(today|week|all)$/);
  if (rangeMatch) {
    getPrefs(from).range = rangeMatch[1] as RangeKey;
    await setAdminStep(from, "admin_main");
    return `✅ Range set to ${rangeMatch[1]}.\n\n${ADMIN_MAIN_MENU}`;
  }
  const statusFilterMatch = text.match(/^filter\s+status\s+(pending|picked_up|at_cleaners|ready|delivered|missed|all)$/);
  if (statusFilterMatch) {
    getPrefs(from).status = statusFilterMatch[1] as StatusFilter;
    await setAdminStep(from, "admin_main");
    return `✅ Status filter: ${statusFilterMatch[1]}.\n\n${ADMIN_MAIN_MENU}`;
  }
  const paidFilterMatch = text.match(/^filter\s+paid\s+(yes|no|paid|unpaid|all)$/);
  if (paidFilterMatch) {
    const v = paidFilterMatch[1]!;
    const mapped: PaidFilter = v === "yes" || v === "paid" ? "paid" : v === "no" || v === "unpaid" ? "unpaid" : "all";
    getPrefs(from).paid = mapped;
    await setAdminStep(from, "admin_main");
    return `✅ Payment filter: ${mapped}.\n\n${ADMIN_MAIN_MENU}`;
  }
  if (text === "reset" || text === "reset filters" || text === "clear filters") {
    resetPrefs(from);
    await setAdminStep(from, "admin_main");
    return `✅ Filters reset to defaults.\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Apply a referral credit to an order ───────────────────────────────────
  // Syntax: "credit <orderId>"  (e.g. "credit 17" or "credit DRY-2014")
  const creditMatch = text.match(/^credit\s+(?:dry-)?(\d+)$/);
  if (creditMatch) {
    const orderId = parseInt(creditMatch[1]!, 10);
    const result = await applyReferralCredit(orderId);
    await setAdminStep(from, "admin_main");
    if (!result.ok) return `❌ ${result.reason}\n\n${ADMIN_MAIN_MENU}`;
    const o = result.order;
    // Best-effort customer SMS — same envelope vars as notifyCustomer.
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;
      if (sid && token && fromNumber) {
        const client = twilio(sid, token);
        await client.messages.create({
          to: o.phoneNumber, from: fromNumber,
          body: `🎁 Good news! Order #${o.orderNumber} is FREE — covered by a referral credit you earned. No payment needed. Thanks for spreading the word!`,
        });
      }
    } catch { /* best-effort */ }
    return (
      `✅ Referral credit applied to #${o.orderNumber} (${o.name}).\n` +
      `Order marked PAID. Customer notified.\n` +
      `Remaining credits for this customer: ${result.remaining}.\n\n` +
      `${ADMIN_MAIN_MENU}`
    );
  }

  // Load admin session (if any)
  const [session] = await db
    .select().from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  const step = session?.step;

  // ── Update browse: pick from recent list, or fall through to a search query
  if (step === "admin_update_browse") {
    const browseIds = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    // If reply is a small number that maps to the shown list, pick from list.
    if (/^\d+$/.test(text) && browseIds.length > 0) {
      const pick = parseInt(text, 10);
      if (pick >= 1 && pick <= browseIds.length) {
        const id = browseIds[pick - 1]!;
        const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
        if (!order) {
          await setAdminStep(from, "admin_main");
          return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
        }
        await setAdminStep(from, "admin_update_action", String(id));
        return adminUpdateMenu(order);
      }
    }
    // Otherwise treat as a search query.
    await setAdminStep(from, "admin_update_search");
    // Fall through into the search handler below by re-running it inline:
  }

  // ── Lookup flow: collecting search query ───────────────────────────────────
  if (step === "admin_lookup" || step === "admin_update_search" || step === "admin_update_browse") {
    const nextFlow = step === "admin_lookup" ? "lookup" : "update";
    const matches = await searchOrders(raw);
    if (matches.length === 0) {
      return `No orders matched "${raw}".\nTry a name, phone digits, or order ID — or reply 0 to go back.`;
    }
    if (matches.length === 1) {
      const o = matches[0]!;
      if (nextFlow === "lookup") {
        await setAdminStep(from, "admin_main");
        return `${formatOrder(o)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
      }
      await setAdminStep(from, "admin_update_action", String(o.id));
      return adminUpdateMenu(o);
    }
    const ids = matches.map((m) => m.id).join(",");
    const pickStep = nextFlow === "lookup" ? "admin_lookup_pick" : "admin_update_pick";
    await setAdminStep(from, pickStep, ids);
    return `Found ${matches.length} matches — reply with a number:\n\n${formatMatchList(matches)}\n\n0. Back to menu`;
  }

  // ── Lookup/Update picker: choosing from match list ─────────────────────────
  if (step === "admin_lookup_pick" || step === "admin_update_pick") {
    const nextFlow = step === "admin_lookup_pick" ? "lookup" : "update";
    const ids = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    if (!/^\d+$/.test(text)) return `Please reply with a number 1-${ids.length}, or "0" to go back.`;
    const pick = parseInt(text, 10);
    if (pick < 1 || pick > ids.length) {
      return `Please reply with a number 1-${ids.length}, or "0" to go back.`;
    }
    const id = ids[pick - 1]!;
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) {
      await setAdminStep(from, "admin_main");
      return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
    }
    if (nextFlow === "lookup") {
      await setAdminStep(from, "admin_main");
      return `${formatOrder(order)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    await setAdminStep(from, "admin_update_action", String(id));
    return adminUpdateMenu(order);
  }

  // ── Update flow: applying action ───────────────────────────────────────────
  if (step === "admin_update_action") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    // Field-edit options 8-13: load order and jump to the right step.
    const fieldEdit: Record<string, { step: string; prompt: (o: OrderRow) => string }> = {
      "8": {
        step: "admin_update_items",
        prompt: (o) =>
          `📦 Items for #${o.id} (${o.name}).\n\nList with quantities, comma-separated.\n` +
          `Text "clear" to remove, or "0" to cancel.` +
          (o.items ? `\n\nCurrent: ${o.items}` : ""),
      },
      "9": {
        step: "admin_edit_name",
        prompt: (o) => `📛 New name for #${o.id}?\n\nCurrent: ${o.name}\n\n"0" to cancel.`,
      },
      "10": {
        step: "admin_edit_phone",
        prompt: (o) =>
          `📞 New phone for #${o.id}? (e.g. +19293450940)\n\nCurrent: ${o.phoneNumber}\n\n"0" to cancel.`,
      },
      "11": {
        step: "admin_edit_addr_town",
        prompt: (o) =>
          `🏘️ New town for #${o.id}?\n\nCurrent: ${o.town}\n\n${adminTownList()}\n\n"0" to cancel.`,
      },
      "12": {
        step: "admin_edit_pickup",
        prompt: (o) =>
          `📅 New pickup date for #${o.id}? (YYYY-MM-DD)\n\n` +
          `Current: ${o.pickupDate ?? "—"}\n\n` +
          `Text "clear" to remove date, or "0" to cancel.`,
      },
      "13": {
        step: "admin_edit_notes",
        prompt: (o) =>
          `📝 New driver notes for #${o.id}?\n\nCurrent: ${o.notes ?? "—"}\n\n` +
          `Text "clear" to remove, or "0" to cancel.`,
      },
    };
    if (fieldEdit[text]) {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        await setAdminStep(from, "admin_main");
        return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      }
      const { step: nextStep, prompt } = fieldEdit[text]!;
      await setAdminStep(from, nextStep, String(id));
      return prompt(order);
    }
    // Option 14: remove (hard delete) — gated behind YES confirmation step.
    if (text === "14") {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        await setAdminStep(from, "admin_main");
        return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      }
      await setAdminStep(from, "admin_delete_confirm", String(id));
      return (
        `⚠️ REMOVE order #${order.id} — ${order.orderNumber} (${order.name})?\n\n` +
        `This permanently deletes the order and texts the customer that it was cancelled. ` +
        `This can't be undone.\n\n` +
        `Reply "YES" to confirm, or "0" to cancel.`
      );
    }
    if (!["1", "2", "3", "4", "5", "6", "7"].includes(text)) {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      return `Please reply 1-14, or "0" to go back.\n\n${order ? adminUpdateMenu(order) : ""}`;
    }
    // "6 = Mark paid" detours through a payment-method prompt so SMS records
    // cash/zelle the same way the dashboard does (parity with paidMethod
    // column). All other choices fall through to the immediate apply path.
    if (text === "6") {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
      if (!order) {
        await setAdminStep(from, "admin_main");
        return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      }
      await setAdminStep(from, "admin_paid_method", String(id));
      return (
        `💰 How did #${order.id} (${order.name}) pay?\n\n` +
        `1. Zelle\n` +
        `2. Cash\n` +
        `3. Skip (mark paid, no method recorded)\n` +
        `0. Cancel`
      );
    }
    const result = await actionApplyUpdate(id, text);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Paid method picker (after update→6) ───────────────────────────────────
  if (step === "admin_paid_method") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    let method: "zelle" | "cash" | null;
    if (text === "1") method = "zelle";
    else if (text === "2") method = "cash";
    else if (text === "3") method = null;
    else return `Please reply 1, 2, 3, or "0" to cancel.`;
    const { markOrderPaid } = await import("../lib/paid-toggle");
    const result = await markOrderPaid(id, { paid: true, paidMethod: method });
    await setAdminStep(from, "admin_main");
    if (!result) return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
    const label = method ? method.toUpperCase() : "no method";
    return `✅ Order #${id} (${result.order.name}) — marked PAID (${label}).\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Earnings range picker ─────────────────────────────────────────────────
  if (step === "admin_earnings_pick") {
    let range: "today" | "week" | "month" | "all" | null = null;
    if (text === "1") range = "today";
    else if (text === "2") range = "week";
    else if (text === "3") range = "month";
    else if (text === "4") range = "all";
    else return `Please reply 1-4, or "0" to go back.\n\n${ADMIN_EARNINGS_MENU}`;
    const summary = await buildEarningsSmsSummary(range);
    await setAdminStep(from, "admin_main");
    return `${summary}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Bulk status transitions ────────────────────────────────────────────────
  if (step === "admin_bulk_pick") {
    const { bulkTransitionStatus } = await import("../lib/bulk-status");
    let result: { updated: number; label: string } | null = null;
    if (text === "1") {
      const r = await bulkTransitionStatus({ from: "picked_up", to: "at_cleaners" });
      result = { updated: r.updated, label: "dropped at cleaners" };
    } else if (text === "2") {
      const r = await bulkTransitionStatus({ from: "at_cleaners", to: "ready" });
      result = { updated: r.updated, label: "marked ready" };
    } else if (text === "3") {
      const r = await bulkTransitionStatus({ from: "ready", to: "delivered" });
      result = { updated: r.updated, label: "marked delivered" };
    } else {
      return `Please reply 1-3, or "0" to go back.\n\n${await buildAdminBulkMenu()}`;
    }
    await setAdminStep(from, "admin_main");
    const word = result.updated === 1 ? "order" : "orders";
    return `✅ ${result.updated} ${word} ${result.label}. Customers notified.\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Settings: pick which to edit ──────────────────────────────────────────
  if (step === "admin_settings_pick") {
    if (text === "1") {
      await setAdminStep(from, "admin_settings_fee");
      return `💵 New delivery fee in dollars? (e.g. "5" for $5.00; "0" allowed)\n\nReply "cancel" to abort.`;
    }
    if (text === "2") {
      await setAdminStep(from, "admin_settings_min");
      return `📉 New order minimum in dollars? (e.g. "10" for $10.00; "0" for no minimum)\n\nReply "cancel" to abort.`;
    }
    if (text === "3") {
      await setAdminStep(from, "admin_settings_wholesale");
      return `🧺 New wholesale percentage? 0-100 (e.g. "50" — items only, never delivery)\n\nReply "cancel" to abort.`;
    }
    return `Please reply 1-3, or "0" to go back.\n\n${await buildAdminSettingsMenu()}`;
  }
  if (step === "admin_settings_fee") {
    if (text === "cancel") {
      await setAdminStep(from, "admin_main");
      return `Cancelled.\n\n${ADMIN_MAIN_MENU}`;
    }
    const dollars = Number(text);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 1000) {
      return `Enter a number between 0 and 1000, or "cancel".`;
    }
    const cents = Math.round(dollars * 100);
    await updateOneSetting("feeCents", cents);
    await setAdminStep(from, "admin_main");
    return `✅ Delivery fee set to $${(cents / 100).toFixed(2)} (applies to NEW orders only — existing orders keep their snapshot).\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }
  if (step === "admin_settings_min") {
    if (text === "cancel") {
      await setAdminStep(from, "admin_main");
      return `Cancelled.\n\n${ADMIN_MAIN_MENU}`;
    }
    const dollars = Number(text);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 10000) {
      return `Enter a number between 0 and 10000, or "cancel".`;
    }
    const cents = Math.round(dollars * 100);
    await updateOneSetting("orderMinimumCents", cents);
    await setAdminStep(from, "admin_main");
    return `✅ Order minimum set to $${(cents / 100).toFixed(2)}.\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }
  if (step === "admin_settings_wholesale") {
    if (text === "cancel") {
      await setAdminStep(from, "admin_main");
      return `Cancelled.\n\n${ADMIN_MAIN_MENU}`;
    }
    const pct = Number(text);
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      return `Enter a whole number 0-100, or "cancel".`;
    }
    await updateOneSetting("wholesalePercent", pct);
    await setAdminStep(from, "admin_main");
    return `✅ Wholesale percentage set to ${pct}% (affects earnings report only; items revenue only — delivery fees stay 100% yours).\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Price list: list / pick item to edit / add new ────────────────────────
  if (step === "admin_pricelist_pick") {
    const ids = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    if (text === "+" || text.toLowerCase() === "add" || text === "new") {
      await setAdminStep(from, "admin_pricelist_new_name");
      return `🆕 New price-list item name? (e.g. "Tuxedo")\n\n"0" to cancel.`;
    }
    const n = parseInt(text, 10);
    if (isNaN(n) || n < 1 || n > ids.length) {
      return `Reply with an item number (1-${ids.length}), "+" to add a new item, or "0" to go back.`;
    }
    const pickedId = ids[n - 1]!;
    const { priceListTable } = await import("@workspace/db/schema");
    const [item] = await db.select().from(priceListTable).where(eq(priceListTable.id, pickedId)).limit(1);
    if (!item) {
      await setAdminStep(from, "admin_main");
      return `That item no longer exists.\n\n${ADMIN_MAIN_MENU}`;
    }
    await setAdminStep(from, "admin_pricelist_edit", String(pickedId));
    return (
      `✏️ ${item.name} — current price $${(item.priceCents / 100).toFixed(2)}\n\n` +
      `Reply with the new price in dollars (e.g. "12.50"),\n` +
      `or "delete" to deactivate this item,\n` +
      `or "cancel" to abort.`
    );
  }
  if (step === "admin_pricelist_edit") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that item.\n\n" + ADMIN_MAIN_MENU;
    }
    if (text === "cancel") {
      await setAdminStep(from, "admin_main");
      return `Cancelled.\n\n${ADMIN_MAIN_MENU}`;
    }
    const { priceListTable } = await import("@workspace/db/schema");
    if (text.toLowerCase() === "delete" || text.toLowerCase() === "remove") {
      const [row] = await db
        .update(priceListTable)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(priceListTable.id, id))
        .returning();
      await setAdminStep(from, "admin_main");
      if (!row) return `That item no longer exists.\n\n${ADMIN_MAIN_MENU}`;
      return `🗑️ "${row.name}" deactivated (historical orders keep their prices).\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    const dollars = Number(text);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 10000) {
      return `Enter a price in dollars (e.g. "12.50"), "delete" to deactivate, or "cancel" to abort.`;
    }
    const cents = Math.round(dollars * 100);
    const [row] = await db
      .update(priceListTable)
      .set({ priceCents: cents, updatedAt: new Date() })
      .where(eq(priceListTable.id, id))
      .returning();
    await setAdminStep(from, "admin_main");
    if (!row) return `That item no longer exists.\n\n${ADMIN_MAIN_MENU}`;
    return `✅ "${row.name}" updated to $${(cents / 100).toFixed(2)} (new orders only — past receipts keep snapshotted prices).\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }
  if (step === "admin_pricelist_new_name") {
    if (text === "cancel") {
      await setAdminStep(from, "admin_main");
      return `Cancelled.\n\n${ADMIN_MAIN_MENU}`;
    }
    const name = raw.trim();
    if (!name || name.length > 60) {
      return `Enter a name 1-60 chars, or "cancel" to abort.`;
    }
    await setAdminStep(from, "admin_pricelist_new_price", name);
    return `💲 Price for "${name}" in dollars? (e.g. "12.50")\n\nReply "cancel" to abort.`;
  }
  if (step === "admin_pricelist_new_price") {
    const name = session?.items ?? "";
    if (!name) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that item.\n\n" + ADMIN_MAIN_MENU;
    }
    if (text === "cancel") {
      await setAdminStep(from, "admin_main");
      return `Cancelled.\n\n${ADMIN_MAIN_MENU}`;
    }
    const dollars = Number(text);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 10000) {
      return `Enter a price in dollars (e.g. "12.50"), or "cancel" to abort.`;
    }
    const cents = Math.round(dollars * 100);
    const { priceListTable } = await import("@workspace/db/schema");
    try {
      const [row] = await db
        .insert(priceListTable)
        .values({ name, priceCents: cents, updatedAt: new Date() })
        .returning();
      await setAdminStep(from, "admin_main");
      return `✅ Added "${row!.name}" at $${(cents / 100).toFixed(2)}.\n\n———\n\n${ADMIN_MAIN_MENU}`;
    } catch (err) {
      await setAdminStep(from, "admin_main");
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique/i.test(msg)) {
        return `❌ An item named "${name}" already exists. Pick option 16 again and edit it instead.\n\n${ADMIN_MAIN_MENU}`;
      }
      throw err;
    }
  }

  // ── Delete confirmation ────────────────────────────────────────────────────
  if (step === "admin_delete_confirm") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    if (text.toLowerCase() !== "yes") {
      await setAdminStep(from, "admin_main");
      return `Cancelled — order not removed.\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
    if (!order) {
      await setAdminStep(from, "admin_main");
      return `That order no longer exists.\n\n${ADMIN_MAIN_MENU}`;
    }
    await db.delete(ordersTable).where(eq(ordersTable.id, id));
    const notifySuffix = await notifyCustomerCancellation(order);
    await setAdminStep(from, "admin_main");
    return `🗑️ Removed order #${order.id} — ${order.orderNumber} (${order.name}).${notifySuffix}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Single-field edits ────────────────────────────────────────────────────
  const editFieldSteps = new Set([
    "admin_edit_name", "admin_edit_phone", "admin_edit_pickup", "admin_edit_notes",
    "admin_edit_addr_town", "admin_edit_addr_colony", "admin_edit_addr_street",
    "admin_edit_addr_unit", "admin_edit_addr_gate",
  ]);
  if (step && editFieldSteps.has(step)) {
    // Scratch is either a bare numeric id (single-field flows) or a JSON
    // payload `{id, town?, colony?, unit?}` (address subflow). Using JSON
    // instead of `id|town|colony|unit` so user-typed values that contain
    // delimiter characters can't corrupt later parsing.
    let id = NaN;
    let addr: { id: number; town?: string; colony?: string; street?: string | null; unit?: string } = { id: NaN };
    const sc = session?.items ?? "";
    if (sc.startsWith("{")) {
      try {
        addr = JSON.parse(sc);
        id = Number(addr.id);
      } catch { /* fall through to lost-track */ }
    } else {
      id = parseInt(sc, 10);
    }
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }

    if (step === "admin_edit_name") {
      if (!raw.trim()) return `Name can't be empty. Try again, or "0" to cancel.`;
      await db.update(ordersTable).set({ name: raw.trim() }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — name set to "${raw.trim()}"\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    if (step === "admin_edit_phone") {
      const digits = raw.replace(/[^\d+]/g, "");
      if (!/^\+?\d{10,15}$/.test(digits)) {
        return `Please send a valid phone (e.g. +19293450940), or "0" to cancel.`;
      }
      const phone = digits.startsWith("+") ? digits : `+1${digits.replace(/^1/, "")}`;
      await db.update(ordersTable).set({ phoneNumber: phone }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — phone set to ${phone}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    if (step === "admin_edit_pickup") {
      const value = (text === "clear" || text === "none") ? null : raw.trim();
      if (value !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return `Date must be YYYY-MM-DD (e.g. 2026-06-03). Try again, or "0" to cancel.`;
        }
        const [y, m, d] = value.split("-").map(Number);
        const dt = new Date(Date.UTC(y!, m! - 1, d!));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
          return `Not a real calendar date. Try again, or "0" to cancel.`;
        }
      }
      await db.update(ordersTable).set({ pickupDate: value }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — pickup date ${value ? `set to ${value}` : "cleared"}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    if (step === "admin_edit_notes") {
      const value = (text === "clear" || text === "none") ? null : raw;
      await db.update(ordersTable).set({ notes: value }).where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — notes ${value ? "updated" : "cleared"}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }

    // Address: 4 sub-steps — town → colony → unit → gate. State carried as
    // JSON in `items`; bare-id scratch from option 9 is upgraded to JSON on
    // the town step.
    if (step === "admin_edit_addr_town") {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > PHASE_1_TOWNS.length) {
        return `Reply 1-${PHASE_1_TOWNS.length}, or "0" to cancel.\n\n${adminTownList()}`;
      }
      const town = PHASE_1_TOWNS[n - 1]!;
      await setAdminStep(from, "admin_edit_addr_colony", JSON.stringify({ id, town }));
      return `🏠 Colony / building / development name?\n\n"0" to cancel.`;
    }
    if (step === "admin_edit_addr_colony") {
      if (!raw.trim()) return `Colony can't be empty. Try again, or "0" to cancel.`;
      await setAdminStep(from, "admin_edit_addr_street",
        JSON.stringify({ ...addr, colony: raw.trim() }));
      return `🛣️ Street address? (e.g. "115 Brickman Rd")\n\nText "skip" to leave blank, or "0" to cancel.`;
    }
    if (step === "admin_edit_addr_street") {
      const street = (text === "skip" || text === "clear" || !raw.trim()) ? null : raw.trim();
      await setAdminStep(from, "admin_edit_addr_unit",
        JSON.stringify({ ...addr, street }));
      return `🚪 Unit number / apartment?\n\n"0" to cancel.`;
    }
    if (step === "admin_edit_addr_unit") {
      if (!raw.trim()) return `Unit can't be empty. Try again, or "0" to cancel.`;
      await setAdminStep(from, "admin_edit_addr_gate",
        JSON.stringify({ ...addr, unit: raw.trim() }));
      return `🔑 Gate code or access notes? (or "none" to skip)\n\n"0" to cancel.`;
    }
    if (step === "admin_edit_addr_gate") {
      const town = addr.town;
      const colony = addr.colony;
      const unit = addr.unit;
      const street = addr.street ?? null;
      if (!town || !colony || !unit) {
        await setAdminStep(from, "admin_main");
        return `Address edit lost its state — please start over.\n\n${ADMIN_MAIN_MENU}`;
      }
      const gate = (text === "none" || text === "clear" || !raw.trim()) ? null : raw.trim();
      await db.update(ordersTable)
        .set({ town, colony, colonyAddress: street, unitNumber: unit, gateAccess: gate })
        .where(eq(ordersTable.id, id));
      await setAdminStep(from, "admin_main");
      return `✅ #${id} — address updated:\n  ${town} · ${colony} · Unit ${unit}` +
             (street ? `\n  Street: ${street}` : "") +
             (gate ? `\n  Gate: ${gate}` : "") +
             `\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
  }

  // ── Update flow: capturing items ───────────────────────────────────────────
  if (step === "admin_update_items") {
    const id = parseInt(session?.items ?? "", 10);
    if (isNaN(id)) {
      await setAdminStep(from, "admin_main");
      return "Lost track of that order.\n\n" + ADMIN_MAIN_MENU;
    }
    const value = text === "clear" || text === "none" ? null : raw;
    await db.update(ordersTable).set({ items: value }).where(eq(ordersTable.id, id));
    await setAdminStep(from, "admin_main");
    const summary = value ? `Items set to: ${value}` : `Items cleared.`;
    return `✅ Order #${id} — ${summary}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Stats submenu ──────────────────────────────────────────────────────────
  if (step === "admin_stats") {
    let range: "today" | "week" | "all" | null = null;
    if (text === "1") range = "today";
    else if (text === "2") range = "week";
    else if (text === "3") range = "all";
    else return `Please reply 1-3, or "0" to go back.\n\n${ADMIN_STATS_MENU}`;
    const result = await actionStats(range);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Missed pickups: batch-mark selection ──────────────────────────────────
  if (step === "admin_missed_pick") {
    const ids = (session?.items ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    let picks: number[] = [];
    if (text === "all") {
      picks = ids;
    } else {
      const nums = text.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
      for (const n of nums) {
        if (n >= 1 && n <= ids.length) picks.push(ids[n - 1]!);
      }
    }
    if (picks.length === 0) {
      return `Reply with numbers (e.g. "1,3"), "all", or "0" to cancel.`;
    }
    const result = await actionMarkMissedBatch(picks);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── Route day picker → wave picker → render ───────────────────────────────
  if (step === "admin_route_pick_day" || step === "admin_delivery_pick_day") {
    const dir: RouteDir = step === "admin_delivery_pick_day" ? "delivery" : "pickup";
    const dates = (session?.items ?? "").split(",").filter(Boolean);
    if (!/^\d+$/.test(text)) return `Please reply 1-${dates.length}, or "0" to go back.`;
    const pick = parseInt(text, 10);
    if (pick < 1 || pick > dates.length) return `Please reply 1-${dates.length}, or "0" to go back.`;
    const date = dates[pick - 1]!;
    const nextStep = dir === "delivery" ? "admin_delivery_pick_wave" : "admin_route_pick_wave";
    await setAdminStep(from, nextStep, date);
    return buildWavePickerMenu(dir, date);
  }
  if (step === "admin_route_pick_wave" || step === "admin_delivery_pick_wave") {
    const dir: RouteDir = step === "admin_delivery_pick_wave" ? "delivery" : "pickup";
    const date = (session?.items ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      await setAdminStep(from, "admin_main");
      return `Lost track of which day — please start again.\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    if (!/^[12]$/.test(text)) return `Reply 1 (Morning) or 2 (Afternoon), or "0" to go back.`;
    const wave: RouteWave = text === "1" ? "morning" : "afternoon";
    const result = await actionRouteForDate(date, dir, wave);
    await setAdminStep(from, "admin_main");
    return `${result}\n\n———\n\n${ADMIN_MAIN_MENU}`;
  }

  // ── New order flow (admin-initiated) ──────────────────────────────────────
  if (step?.startsWith("admin_new_")) {
    const scratch = readScratch(session?.items ?? null);

    if (step === "admin_new_phone") {
      const digits = raw.replace(/[^\d+]/g, "");
      if (!/^\+?\d{10,15}$/.test(digits)) {
        return `Please send a valid phone (e.g. +19293450940), or "0" to cancel.`;
      }
      scratch.phone = digits.startsWith("+") ? digits : `+1${digits.replace(/^1/, "")}`;
      await setAdminStep(from, "admin_new_name", writeScratch(scratch));
      return `📛 Customer name?`;
    }
    if (step === "admin_new_name") {
      scratch.name = raw;
      await setAdminStep(from, "admin_new_town", writeScratch(scratch));
      return `🏘️ Which town?\n\n${adminTownList()}`;
    }
    if (step === "admin_new_town") {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 1 || n > PHASE_1_TOWNS.length) {
        return `Reply 1-${PHASE_1_TOWNS.length}.\n\n${adminTownList()}`;
      }
      scratch.town = PHASE_1_TOWNS[n - 1]!;
      await setAdminStep(from, "admin_new_colony", writeScratch(scratch));
      return `🏢 Colony / neighborhood name?`;
    }
    if (step === "admin_new_colony") {
      scratch.colony = raw;
      await setAdminStep(from, "admin_new_location", writeScratch(scratch));
      return `📍 Address details — 3 lines:\n\n1. Street address\n2. Unit / house number\n3. Gate code (or skip)\n\nExample:\n123 Main St\nUnit 4\n1234#`;
    }
    if (step === "admin_new_location") {
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length < 2) return `Need at least 2 lines (street, unit). Try again or "0" to cancel.`;
      const [street, unit, gate] = lines;
      scratch.address = street!;
      scratch.unit = unit!;
      scratch.gate = !gate || /^(none|no|skip)$/i.test(gate) ? null : gate;
      await setAdminStep(from, "admin_new_items", writeScratch(scratch));
      return `📦 Items? (e.g. "2 suits, 3 shirts" — or "skip")`;
    }
    if (step === "admin_new_items") {
      scratch.items = /^(skip|none|no)$/i.test(text) ? undefined : raw;
      await setAdminStep(from, "admin_new_notes", writeScratch(scratch));
      return `📝 Any notes for the driver? (or "skip")`;
    }
    if (step === "admin_new_notes") {
      const notes = /^(skip|none|no)$/i.test(text) ? null : raw;
      const pickup = nextPickupDate(scratch.town!);
      if (!pickup) {
        await setAdminStep(from, "admin_main");
        return `❌ No service schedule for ${scratch.town}.\n\n${ADMIN_MAIN_MENU}`;
      }
      const orderNumber = await nextOrderNumber();
      await db.insert(ordersTable).values({
        orderNumber,
        phoneNumber: scratch.phone!,
        name: scratch.name!,
        town: scratch.town!,
        colony: scratch.colony!,
        colonyAddress: scratch.address ?? null,
        unitNumber: scratch.unit!,
        gateAccess: scratch.gate ?? null,
        items: scratch.items ?? null,
        notes,
        pickupDate: toDateOnly(pickup),
        status: "pending",
      });
      await setAdminStep(from, "admin_main");
      return [
        `✅ Order ${orderNumber} created for ${scratch.name}.`,
        `📍 ${scratch.colony}, Unit ${scratch.unit} · ${scratch.town}`,
        `📅 Pickup: ${formatLongDate(pickup)}`,
        `📞 ${scratch.phone}`,
        ``,
        `———`,
        ``,
        ADMIN_MAIN_MENU,
      ].join("\n");
    }
  }

  // ── Main menu (default) ────────────────────────────────────────────────────
  const prefs = getPrefs(from);
  switch (text) {
    case "1": {
      await setAdminStep(from, "admin_main");
      return `${await actionTodayPickups(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "2": {
      await setAdminStep(from, "admin_main");
      return `${await actionTodayReturns(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "3": {
      await setAdminStep(from, "admin_main");
      return `${await actionPending(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "4": {
      await setAdminStep(from, "admin_main");
      return `${await actionUnpaid(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "5": {
      const { message, ids } = await actionMissed();
      await setAdminStep(from, ids ? "admin_missed_pick" : "admin_main", ids);
      return message;
    }
    case "6": {
      const { message, dates } = buildRouteDayMenu();
      await setAdminStep(from, "admin_route_pick_day", dates.join(","));
      return message;
    }
    case "7": {
      await setAdminStep(from, "admin_stats");
      return ADMIN_STATS_MENU;
    }
    case "8": {
      await setAdminStep(from, "admin_lookup");
      return `🔍 Search for an order — reply with any of:\n  • Customer name (e.g. "Sarah")\n  • Phone digits (e.g. "9293450")\n  • Order ID (e.g. "5")\n  • Order # (e.g. "DRY-12345")\n\n0. Back to menu`;
    }
    case "9": {
      const { message, ids } = await actionUpdateBrowse();
      await setAdminStep(from, "admin_update_browse", ids);
      return message;
    }
    case "11": {
      await setAdminStep(from, "admin_main");
      return `${await actionFiltered(prefs)}\n\n———\n\n${ADMIN_MAIN_MENU}`;
    }
    case "10": {
      await setAdminStep(from, "admin_new_phone", writeScratch({}));
      return `📱 NEW ORDER — what's the customer's phone? (e.g. +19293450940)\n\n0. Cancel`;
    }
    case "12": {
      const { message, dates } = buildRouteDayMenu("delivery");
      await setAdminStep(from, "admin_delivery_pick_day", dates.join(","));
      return message;
    }
    case "13": {
      await setAdminStep(from, "admin_earnings_pick");
      return ADMIN_EARNINGS_MENU;
    }
    case "14": {
      await setAdminStep(from, "admin_bulk_pick");
      return await buildAdminBulkMenu();
    }
    case "15": {
      await setAdminStep(from, "admin_settings_pick");
      return await buildAdminSettingsMenu();
    }
    case "16": {
      await setAdminStep(from, "admin_pricelist_pick", await buildPriceListIdsScratch());
      return await buildAdminPriceListMenu();
    }
    default:
      await setAdminStep(from, "admin_main");
      return `I didn't recognize that. Pick a number:\n\n${ADMIN_MAIN_MENU}`;
  }
}


// ─── Confirmation SMS ─────────────────────────────────────────────────────────
function buildConfirmationSms(order: {
  orderNumber: string;
  town: string;
  colony: string;
  colonyAddress: string | null;
  unitNumber: string;
  notes: string | null;
  pickupDate: Date;
}): string {
  const dropoff = nextDropoffDate(order.pickupDate);
  const addr = order.colonyAddress ? `${order.colonyAddress}, ` : "";
  const notesBlock = order.notes ? [``, `📝 Notes: ${order.notes}`] : [];
  const wave = waveOf(order.town);
  const cutoffLine = wave
    ? `⏰ Same-day cutoff: ${waveCutoffLabel(wave)} on your pickup day. After that, your order moves to next week.`
    : `⏰ Order cutoff: 12:00 AM the night before your pickup day.`;
  const bagsOutLine = wave
    ? `📋 Please have your items bagged and ready by ${wave === "morning" ? "10:00 AM" : "12:00 PM noon"} on pickup day. Unprepared orders cannot be picked up. Thank you! 🙏`
    : `📋 Please have your items bagged and ready by 10:00 AM on pickup day. Unprepared orders cannot be picked up. Thank you! 🙏`;

  return [
    `✅ Order Confirmed — ${order.orderNumber}`,
    ``,
    `📍 ${addr}${order.colony}, Unit ${order.unitNumber}`,
    `   ${order.town}`,
    ...notesBlock,
    ``,
    `📅 Pickup: ${formatLongDate(order.pickupDate)}`,
    `📅 Drop-off by: ${formatLongDate(dropoff)}`,
    ``,
    cutoffLine,
    ``,
    bagsOutLine,
  ].join("\n");
}

// ─── Twilio signature validation ──────────────────────────────────────────────
// Validates `X-Twilio-Signature` so that only requests genuinely signed with
// our TWILIO_AUTH_TOKEN can hit the webhook. Without this, anyone who knows
// the URL + admin phone number could spoof admin SMS commands.
//
// In production we hard-fail on missing token or invalid signature.
// In dev (no TWILIO_AUTH_TOKEN configured) we log a warning and allow the
// request so curl-based testing still works.
const verifyTwilioSignature: RequestHandler = (req, res, next) => {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === "production") {
      req.log.error("TWILIO_AUTH_TOKEN not set in production — rejecting webhook");
      res.status(500).send("Webhook validation not configured");
      return;
    }
    req.log.warn("TWILIO_AUTH_TOKEN not set — skipping Twilio signature check (dev only)");
    next();
    return;
  }

  const signature = req.header("X-Twilio-Signature") ?? "";
  if (!signature) {
    req.log.warn({ ip: req.ip }, "Missing X-Twilio-Signature header — rejecting");
    res.status(403).send("Forbidden");
    return;
  }

  // Twilio signs the absolute URL it POSTed to (including query string) plus
  // the form-encoded parameters. Behind our reverse proxy, req.protocol/host
  // can be wrong, so we reconstruct from the configured PUBLIC_URL.
  const url = `${PUBLIC_URL.replace(/\/$/, "")}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, string>;

  const valid = twilio.validateRequest(token, signature, url, params);
  if (!valid) {
    req.log.warn({ url, ip: req.ip }, "Invalid Twilio signature — rejecting");
    res.status(403).send("Forbidden");
    return;
  }
  next();
};

// ─── Webhook ──────────────────────────────────────────────────────────────────
router.post("/webhook/twilio", verifyTwilioSignature, async (req, res) => {
  const body = req.body as { Body?: string; From?: string };
  const from = (body.From ?? "").trim();
  const raw = (body.Body ?? "").trim();
  const text = raw.toLowerCase().trim();

  res.setHeader("Content-Type", "text/xml");

  if (!from) {
    res.send(twimlResponse("Unable to process your request."));
    return;
  }

  // ── Admin branch ─────────────────────────────────────────────────────────
  const adminPhone = process.env.ADMIN_PHONE_NUMBER;
  if (adminPhone && from === adminPhone) {
    const reply = await handleAdminCommand(from, text, raw);
    res.send(twimlResponse(reply));
    return;
  }

  // ── HELP keyword (Twilio CTA compliance + customer support) ──────────────
  // Always intercept "help" / "info" regardless of where the customer is in
  // any other flow — that's the whole point of HELP per carrier rules.
  // Shows a numbered menu; option 4 ("Other") opens a free-text channel that
  // forwards the next message straight to the admin phone.
  if (text === "help" || text === "info") {
    // Preserve any in-flight conversation state (mid-order booking, referral,
    // reschedule) by stashing it into items as JSON. The HELP exit paths
    // restore it so the customer can pick up where they left off.
    const [existing] = await db.select().from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, from)).limit(1);
    const isHelpStep = existing?.step === "help_menu" || existing?.step === "help_other";
    const stash = existing && !isHelpStep
      ? JSON.stringify({
          prev: {
            step: existing.step, name: existing.name, town: existing.town,
            colony: existing.colony, colonyAddress: existing.colonyAddress,
            unitNumber: existing.unitNumber, gateAccess: existing.gateAccess,
            items: existing.items, notes: existing.notes,
          },
        })
      : (existing?.items ?? null); // keep an already-stashed prev across re-entry
    await db.insert(conversationsTable)
      .values({ phoneNumber: from, step: "help_menu", items: stash })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: { step: "help_menu", items: stash, updatedAt: new Date() },
      });
    res.send(twimlResponse(
      `Upstate Dry Cleaning — SMS pickup & delivery in Sullivan County, NY.\n\n` +
      `How can we help?\n\n` +
      `1. How to schedule a pickup\n` +
      `2. Reschedule or cancel an order\n` +
      `3. Pricing & payment\n` +
      `4. Other — describe your issue\n\n` +
      `Reply with a number 1-4. Reply STOP to unsubscribe. Msg & data rates may apply.`,
    ));
    return;
  }

  // ── Referral commands (intercept before "clean" so they can't be hijacked) ──
  if (text === "credits" || text === "referrals" || text === "my referrals") {
    const stats = await getReferralStats(from);
    res.send(twimlResponse(formatReferralStatus(stats)));
    return;
  }
  if (text === "refer") {
    const stats = await getReferralStats(from);
    if (stats.atCap) {
      res.send(twimlResponse(
        `🙌 You've already hit the lifetime cap of ${REFERRAL_MAX_REDEMPTIONS} free pickups from referrals. ` +
        `Text "credits" to see your status.`,
      ));
      return;
    }
    await db.insert(conversationsTable)
      .values({ phoneNumber: from, step: "refer_name", items: "{}" })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: {
          step: "refer_name",
          name: null, town: null, colony: null, colonyAddress: null,
          unitNumber: null, gateAccess: null, items: "{}",
          updatedAt: new Date(),
        },
      });
    res.send(twimlResponse(
      `🎁 Add a referral!\n\n` +
      `Refer ${REFERRAL_THRESHOLD} neighbors who complete a first paid pickup = one FREE pickup (up to $${REFERRAL_CREDIT_USD}).\n\n` +
      `What's the neighbor's full name? (or text "cancel" to stop)`,
    ));
    return;
  }

  // ── Start fresh ───────────────────────────────────────────────────────────
  if (text === "clean") {
    // Returning customer? Look up the most recent order for this phone.
    const [lastOrder] = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.phoneNumber, from))
      .orderBy(desc(ordersTable.id))
      .limit(1);

    // Returning customer whose saved town is now Phase 2 (or was never serviced):
    // don't offer the "use saved address" shortcut — it would bypass the town
    // picker and let them book a non-serviced area. Fall through to the fresh
    // flow with a kind heads-up.
    if (lastOrder && !isPhase1(lastOrder.town)) {
      await db
        .insert(conversationsTable)
        .values({ phoneNumber: from, step: "name" })
        .onConflictDoUpdate({
          target: conversationsTable.phoneNumber,
          set: {
            step: "name",
            name: null, town: null, colony: null, colonyAddress: null,
            unitNumber: null, gateAccess: null, items: null,
            updatedAt: new Date(),
          },
        });
      const firstName = lastOrder.name.split(" ")[0] ?? lastOrder.name;
      res.send(twimlResponse(
        `Welcome back, ${firstName}! 👋\n\n` +
        `Heads up — we don't service ${lastOrder.town} yet, but it's on our roadmap and we'll text you the moment we launch there. ` +
        `In the meantime, if you'd like to book a pickup at a different address in our current service area:\n\n` +
        `What is your full name?`
      ));
      return;
    }

    if (lastOrder) {
      await db
        .insert(conversationsTable)
        .values({
          phoneNumber: from,
          step: "returning_confirm",
          name: lastOrder.name,
          town: lastOrder.town,
          colony: lastOrder.colony,
          colonyAddress: lastOrder.colonyAddress,
          unitNumber: lastOrder.unitNumber,
          gateAccess: lastOrder.gateAccess,
        })
        .onConflictDoUpdate({
          target: conversationsTable.phoneNumber,
          set: {
            step: "returning_confirm",
            name: lastOrder.name,
            town: lastOrder.town,
            colony: lastOrder.colony,
            colonyAddress: lastOrder.colonyAddress,
            unitNumber: lastOrder.unitNumber,
            gateAccess: lastOrder.gateAccess,
            items: null,
            updatedAt: new Date(),
          },
        });
      const firstName = lastOrder.name.split(" ")[0] ?? lastOrder.name;
      const gateLine = lastOrder.gateAccess ? `Gate: ${lastOrder.gateAccess}` : "No gate";
      res.send(twimlResponse(
        `Welcome back, ${firstName}! 👋\n\n` +
        `${welcomeIntro()}\n\n` +
        `Use your saved address?\n\n` +
        `${lastOrder.colonyAddress ?? ""}\n` +
        `${lastOrder.colony}, Unit ${lastOrder.unitNumber}\n` +
        `${lastOrder.town}\n` +
        `${gateLine}\n\n` +
        `Reply YES to use it, or NO to enter a new address.`
      ));
      return;
    }

    await db
      .insert(conversationsTable)
      .values({ phoneNumber: from, step: "name" })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: {
          step: "name",
          name: null, town: null, colony: null, colonyAddress: null,
          unitNumber: null, gateAccess: null, items: null,
          updatedAt: new Date(),
        },
      });
    res.send(twimlResponseWithMedia(
      `Welcome to Upstate Dry Cleaning! 👔\n\n` +
      `${welcomeIntro()}\n\n` +
      `What is your full name?`,
      LOGO_URL,
    ));
    return;
  }

  // ── Load conversation ─────────────────────────────────────────────────────
  const [convo] = await db
    .select().from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, from))
    .limit(1);

  // ── HELP menu choice (set by the "help"/"info" intercept above) ──────────
  if (convo?.step === "help_menu") {
    if (text === "1") {
      await exitHelpRestoringPrev(from, convo.items);
      res.send(twimlResponse(
        `To schedule a pickup, just text the word "clean" to this number. ` +
        `We'll ask for your name, address, and preferred pickup day, then confirm by SMS.\n\n` +
        `Pickups must be requested by midnight the night before your service day. ` +
        `Reply STOP to unsubscribe at any time.`,
      ));
      return;
    }
    if (text === "2") {
      await exitHelpRestoringPrev(from, convo.items);
      res.send(twimlResponse(
        `To reschedule or cancel an order, reply to the confirmation message we sent ` +
        `you, or text "help" and choose option 4 to message us directly.\n\n` +
        `If we marked an order as "missed" we'll text you a reschedule offer automatically.`,
      ));
      return;
    }
    if (text === "3") {
      await exitHelpRestoringPrev(from, convo.items);
      res.send(twimlResponse(
        `Pricing is communicated at or before pickup based on your items. ` +
        `Payment is due upon delivery via Zelle to (929) 345-0940, or as otherwise arranged.\n\n` +
        `Questions about a specific charge? Text "help" and choose option 4.`,
      ));
      return;
    }
    if (text === "4" || text === "other") {
      // Keep items (the prev-state stash) intact so cancel/forward can restore.
      await db.update(conversationsTable)
        .set({ step: "help_other", updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `Sure — please describe what you need help with in your next message, ` +
        `and we'll get back to you as soon as we can.\n\n` +
        `(Reply "cancel" if you'd rather not.)`,
      ));
      return;
    }
    res.send(twimlResponse(
      `Please reply with a number 1-4:\n\n` +
      `1. How to schedule a pickup\n` +
      `2. Reschedule or cancel an order\n` +
      `3. Pricing & payment\n` +
      `4. Other — describe your issue`,
    ));
    return;
  }

  // ── HELP "Other" — forward the customer's free-text message to admin ─────
  if (convo?.step === "help_other") {
    if (text === "cancel" || text === "stop" || text === "0" || text === "menu") {
      await exitHelpRestoringPrev(from, convo.items);
      res.send(twimlResponse(`No problem — closed. Text "help" anytime.`));
      return;
    }
    // Basic quality gate before we burn an admin SMS on it.
    if (raw.trim().length < 3) {
      res.send(twimlResponse(
        `Please type a brief description of what you need help with, or reply "cancel".`,
      ));
      return;
    }
    // Rate limit to prevent admin-spam abuse: max 3 forwards per phone per
    // 24h, with a 60s cooldown between forwards. In-memory is fine — single
    // process, and a reboot resetting counts only HELPS legitimate users.
    const rl = checkHelpRateLimit(from);
    if (!rl.allowed) {
      await exitHelpRestoringPrev(from, convo.items);
      res.send(twimlResponse(rl.message));
      return;
    }
    await exitHelpRestoringPrev(from, convo.items);
    // Truncate forwarded body so a long pasted blob can't fill admin SMS
    // segments. Leaflet/popup-style escaping not needed (plain SMS body).
    const snippet = raw.length > 500 ? raw.slice(0, 500) + "…[truncated]" : raw;
    const forwarded = await notifyAdmin(
      `📨 HELP request from ${from}:\n\n"${snippet}"\n\nReply to that number to respond.`,
    );
    res.send(twimlResponse(
      forwarded
        ? `Thanks — we got your message and a team member will reach out as soon as we can. ` +
          `If it's urgent you can also call (845) 606-0022.`
        : `Thanks — your message was received but our notification system is temporarily down. ` +
          `Please call or text (845) 606-0022 directly. Sorry for the inconvenience!`,
    ));
    return;
  }

  // ── Reschedule flow: pick a new pickup day for a missed order ────────────
  // Triggered when a customer with a missed order texts back. We don't intercept
  // if they're already mid-order-flow (returning_confirm/name/town/etc.).
  const orderFlowSteps = new Set([
    "returning_confirm", "name", "town", "colony", "location_details", "notes",
    "refer_name", "refer_phone", "refer_confirm",
  ]);
  if (!convo || !orderFlowSteps.has(convo.step ?? "")) {
    if (convo?.step === "reschedule_offer") {
      if (text === "yes" || text === "y" || text === "reschedule") {
        // Bind to the SPECIFIC order id captured when we sent the offer, not
        // "latest missed" — otherwise a newer missed order would silently
        // hijack the reschedule.
        const offeredId = parseInt(convo.items ?? "", 10);
        const [missed] = isNaN(offeredId)
          ? [undefined]
          : await db.select().from(ordersTable)
              .where(and(
                eq(ordersTable.id, offeredId),
                eq(ordersTable.phoneNumber, from),
                eq(ordersTable.status, "missed"),
              )).limit(1);
        if (!missed) {
          await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
          res.send(twimlResponse(`Sorry, that order is no longer eligible to reschedule. Text "clean" to start a new one.`));
          return;
        }
        const choices: { date: Date; label: string }[] = [];
        let cursor = new Date();
        for (let i = 0; i < 3; i++) {
          const next = nextPickupDate(missed.town, cursor);
          if (!next) break;
          choices.push({ date: next, label: formatLongDate(next) });
          cursor = new Date(next); cursor.setDate(cursor.getDate() + 1);
        }
        if (choices.length === 0) {
          res.send(twimlResponse(`Sorry, we don't have a pickup schedule for ${missed.town}. Please call (845) 606-0022.`));
          return;
        }
        const lines = choices.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
        const dates = choices.map((c) => toDateOnly(c.date)).join(",");
        await db.update(conversationsTable)
          .set({ step: "reschedule_pick", items: `${missed.id}|${dates}`, updatedAt: new Date() })
          .where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`Great! Pick a new pickup day for order ${missed.orderNumber}:\n\n${lines}\n\nReply with a number, or "cancel" to skip.`));
        return;
      }
      if (text === "no" || text === "n" || text === "cancel") {
        await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`No problem. Text "clean" anytime to place a new order.`));
        return;
      }
      res.send(twimlResponse(`Reply YES to pick a new pickup day, or NO to skip.`));
      return;
    }
    if (convo?.step === "reschedule_pick") {
      if (text === "cancel" || text === "no") {
        await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`Cancelled. Text "clean" anytime to place a new order.`));
        return;
      }
      const [idStr, dateCsv] = (convo.items ?? "").split("|");
      const orderId = parseInt(idStr ?? "", 10);
      const dates = (dateCsv ?? "").split(",").filter(Boolean);
      const pick = parseInt(text, 10);
      if (isNaN(pick) || pick < 1 || pick > dates.length) {
        res.send(twimlResponse(`Please reply with a number 1-${dates.length}, or "cancel".`));
        return;
      }
      const newDate = dates[pick - 1]!;
      // Conditional update: only flip if the order is still missed and still
      // owned by this phone — guards against a stale conversation reviving an
      // order that was already handled in the dashboard.
      const updated = await db.update(ordersTable)
        .set({ status: "pending", pickupDate: newDate })
        .where(and(
          eq(ordersTable.id, orderId),
          eq(ordersTable.phoneNumber, from),
          eq(ordersTable.status, "missed"),
        ))
        .returning();
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      if (updated.length === 0) {
        res.send(twimlResponse(`Sorry, that order can no longer be rescheduled (it may have been updated). Text "clean" to start a new order.`));
        return;
      }
      res.send(twimlResponse(`✅ Rescheduled! Your new pickup is ${formatLongDate(new Date(newDate + "T00:00:00"))}. Please have your bag out by 10:00 AM. Thanks!`));
      return;
    }

    // Not already in a reschedule conversation — offer one if a missed order exists.
    if (text !== "clean") {
      const [missed] = await db.select().from(ordersTable)
        .where(and(eq(ordersTable.phoneNumber, from), eq(ordersTable.status, "missed")))
        .orderBy(desc(ordersTable.id)).limit(1);
      if (missed) {
        // Persist the offered order id in items so the YES branch binds to
        // the same order, not whatever "latest missed" happens to be then.
        await db.insert(conversationsTable)
          .values({ phoneNumber: from, step: "reschedule_offer", items: String(missed.id) })
          .onConflictDoUpdate({
            target: conversationsTable.phoneNumber,
            set: { step: "reschedule_offer", items: String(missed.id), updatedAt: new Date() },
          });
        res.send(twimlResponse(
          `Hi! We missed picking up your order ${missed.orderNumber}. ` +
          `Would you like to reschedule it for the next pickup day?\n\n` +
          `Reply YES to pick a new day, or text "clean" to start a brand-new order.`
        ));
        return;
      }
    }
  }

  if (!convo) {
    res.send(twimlResponse('Text "clean" to start a dry cleaning pickup request.'));
    return;
  }

  const step = convo.step;

  if (step === "returning_confirm") {
    if (text === "yes" || text === "y") {
      await db.update(conversationsTable)
        .set({ step: "notes", updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(askForNotesMessage()));
      return;
    }
    if (text === "no" || text === "n") {
      await db.update(conversationsTable)
        .set({
          step: "name",
          name: null, town: null, colony: null, colonyAddress: null,
          unitNumber: null, gateAccess: null, items: null,
          updatedAt: new Date(),
        })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse("No problem! What is your full name?"));
      return;
    }
    res.send(twimlResponse("Please reply YES to use your saved address or NO to enter a new one."));
    return;
  }

  if (step === "name") {
    await db.update(conversationsTable)
      .set({ name: raw, step: "town", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(`Thanks, ${raw}! Which town are you in?\n\nReply with the number:\n\n${customerTownList()}`));
    return;
  }

  if (step === "town") {
    // Phase 2 town typed by name (e.g. "Monticello") — kindly decline and
    // wipe conversation so they can text again once we launch their area.
    const typedTown = TOWNS.find((t) => t.toLowerCase() === text.toLowerCase());
    if (typedTown && !isPhase1(typedTown)) {
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `Sorry, we don't service ${typedTown} yet — but it's on our roadmap! ` +
        `We'll text you the moment we launch in your area. ` +
        `In the meantime, tell your neighbors in our service area to text "clean" to (845) 606-0022. 🚀`
      ));
      return;
    }
    const num = parseInt(text);
    if (isNaN(num) || num < 1 || num > PHASE_1_TOWNS.length) {
      res.send(twimlResponse(`Please reply with a number between 1 and ${PHASE_1_TOWNS.length}.\n\n${customerTownList()}`));
      return;
    }
    const selectedTown = PHASE_1_TOWNS[num - 1]!;
    await db.update(conversationsTable)
      .set({ town: selectedTown, step: "colony", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(`${selectedTown} — got it!\n\nWhat is the name of your colony or neighborhood?`));
    return;
  }

  if (step === "colony") {
    await db.update(conversationsTable)
      .set({ colony: raw, step: "location_details", updatedAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(
      `Got it! Please reply with the following on separate lines:\n\n` +
      `1. Street address\n` +
      `2. Unit or house number\n` +
      `3. Gate code (optional — leave out if no gate)\n\n` +
      `Example:\n123 Main St\nUnit 4\n1234#`
    ));
    return;
  }

  if (step === "location_details") {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) {
      res.send(twimlResponse(
        `Please send at least 2 lines:\n\n` +
        `1. Street address\n` +
        `2. Unit or house number\n` +
        `3. Gate code (optional — leave out if no gate)\n\n` +
        `Example:\n123 Main St\nUnit 4\n1234#`
      ));
      return;
    }
    const [streetAddress, unitNumber, gateRaw] = lines;
    const gateAccess = !gateRaw || gateRaw.toLowerCase() === "none" || gateRaw.toLowerCase() === "no"
      ? null
      : gateRaw;
    await db.update(conversationsTable)
      .set({
        colonyAddress: streetAddress!,
        unitNumber: unitNumber!,
        gateAccess,
        step: "notes",
        updatedAt: new Date(),
      })
      .where(eq(conversationsTable.phoneNumber, from));
    res.send(twimlResponse(askForNotesMessage()));
    return;
  }

  if (step === "notes") {
    const notes = text === "skip" || text === "none" || text === "no" ? null : raw;
    // Hard Phase-1 gate at the final commit. Catches stale conversations
    // (e.g. one started before a town was demoted from Phase 1 → Phase 2)
    // before they turn into orders the driver can't fulfill.
    if (!convo.town || !isPhase1(convo.town)) {
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `Sorry, we don't service ${convo.town ?? "that area"} yet — it's on our roadmap and we'll text you when we launch. ` +
        `Please text "clean" to start over with a different address.`
      ));
      return;
    }
    const pickupDate = nextPickupDate(convo.town);
    if (!pickupDate) {
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(`Sorry, we don't service ${convo.town} yet. Please text "clean" to start over.`));
      return;
    }

    const orderNumber = await nextOrderNumber();
    await db.insert(ordersTable).values({
      orderNumber,
      phoneNumber: from,
      name: convo.name!,
      town: convo.town!,
      colony: convo.colony!,
      colonyAddress: convo.colonyAddress ?? null,
      unitNumber: convo.unitNumber!,
      gateAccess: convo.gateAccess,
      notes,
      pickupDate: toDateOnly(pickupDate),
      status: "pending",
    });

    await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));

    res.send(twimlResponse(buildConfirmationSms({
      orderNumber,
      town: convo.town!,
      colony: convo.colony!,
      colonyAddress: convo.colonyAddress ?? null,
      unitNumber: convo.unitNumber!,
      notes,
      pickupDate,
    })));
    return;
  }

  // ── Referral subflow: refer_name → refer_phone → refer_confirm ───────────
  if (step === "refer_name" || step === "refer_phone" || step === "refer_confirm") {
    if (text === "cancel" || text === "stop" || text === "0") {
      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(`No problem — referral cancelled. Text "refer" anytime to try again.`));
      return;
    }
    interface ReferralScratch { name?: string; phone?: string }
    let scratch: ReferralScratch = {};
    try { scratch = JSON.parse(convo.items ?? "{}") as ReferralScratch; } catch { /* default {} */ }

    if (step === "refer_name") {
      if (raw.trim().length < 2) {
        res.send(twimlResponse(`Please send the neighbor's full name, or "cancel" to stop.`));
        return;
      }
      scratch.name = raw.trim();
      await db.update(conversationsTable)
        .set({ step: "refer_phone", items: JSON.stringify(scratch), updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `Got it — ${scratch.name}. What's their phone number? (e.g. 845-555-1234)\n\nOr text "cancel" to stop.`,
      ));
      return;
    }

    if (step === "refer_phone") {
      const phone = normalizePhone(raw);
      if (!phone) {
        res.send(twimlResponse(`That doesn't look like a valid phone. Please send 10 digits (e.g. 845-555-1234), or "cancel" to stop.`));
        return;
      }
      if (phone === from) {
        res.send(twimlResponse(`That's your own number 🙂 — please send a neighbor's phone, or "cancel" to stop.`));
        return;
      }
      scratch.phone = phone;
      await db.update(conversationsTable)
        .set({ step: "refer_confirm", items: JSON.stringify(scratch), updatedAt: new Date() })
        .where(eq(conversationsTable.phoneNumber, from));
      res.send(twimlResponse(
        `Please confirm your referral:\n\n` +
        `Name: ${scratch.name}\n` +
        `Phone: ${scratch.phone}\n\n` +
        `Reply YES to save, NO to cancel.`,
      ));
      return;
    }

    if (step === "refer_confirm") {
      if (text === "no" || text === "n") {
        await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`Cancelled. Text "refer" anytime to try again.`));
        return;
      }
      if (text !== "yes" && text !== "y") {
        res.send(twimlResponse(`Please reply YES to save the referral, NO to cancel.`));
        return;
      }
      if (!scratch.name || !scratch.phone) {
        await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
        res.send(twimlResponse(`Lost track of the referral — please start over by texting "refer".`));
        return;
      }

      // Snapshot the referrer's colony/town from their most recent order.
      const [lastOrder] = await db.select()
        .from(ordersTable)
        .where(eq(ordersTable.phoneNumber, from))
        .orderBy(desc(ordersTable.id)).limit(1);

      try {
        await db.insert(referralsTable).values({
          referrerPhone: from,
          referredPhone: scratch.phone,
          referredName: scratch.name,
          referredColony: lastOrder?.colony ?? null,
          referredTown: lastOrder?.town ?? null,
        });
      } catch (err) {
        // Narrow to Postgres unique-violation (23505) — anything else is a
        // real DB error and should not masquerade as "already referred".
        const code = (err as { code?: string } | null)?.code;
        if (code === "23505") {
          await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
          res.send(twimlResponse(
            `That number has already been referred (either by you earlier or by another customer). ` +
            `It won't count twice. Text "refer" to add a different neighbor.`,
          ));
          return;
        }
        req.log.error({ err, referrerPhone: from }, "referral insert failed");
        res.send(twimlResponse(
          `Sorry — something went wrong saving your referral. Please try again in a moment, or text "menu".`,
        ));
        return;
      }

      await db.delete(conversationsTable).where(eq(conversationsTable.phoneNumber, from));
      const stats = await getReferralStats(from);
      const need = REFERRAL_THRESHOLD - (stats.qualified % REFERRAL_THRESHOLD);
      res.send(twimlResponse(
        `✅ Referral saved! ${scratch.name} is on your list.\n\n` +
        `You have ${stats.total} referral${stats.total !== 1 ? "s" : ""} (${stats.qualified} qualified). ` +
        `${need} more qualified = your next FREE pickup (up to $${REFERRAL_CREDIT_USD}).\n\n` +
        `Text "credits" anytime to check status.`,
      ));
      return;
    }
  }

  res.send(twimlResponse('Text "clean" to start a new pickup request.'));
});

// ─── Fallback Webhook ─────────────────────────────────────────────────────────
// Twilio calls this if the primary webhook above fails (timeout, 5xx, etc.).
// Returns a graceful message so the customer isn't left hanging.
router.post("/webhook/twilio-fallback", verifyTwilioSignature, (req, res) => {
  res.setHeader("Content-Type", "text/xml");
  res.send(
    twimlResponse(
      "Sorry, Dry Cleaning Service is having a temporary technical issue. " +
      "Please try texting again in a few minutes, or call/text (845) 606-0022 directly. Thank you for your patience!"
    )
  );
});

export default router;
