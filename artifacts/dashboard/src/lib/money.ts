// Money in this app is always integer cents. These helpers exist so a stray
// `/100` or `toFixed(2)` never sneaks back into the codebase as the source of
// truth — format only at the presentation boundary.

export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}$${whole}.${rem.toString().padStart(2, "0")}`;
}

export function parseDollarsToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, dec = ""] = s.split(".");
  const decPadded = (dec + "00").slice(0, 2);
  return parseInt(whole ?? "0", 10) * 100 + parseInt(decPadded, 10);
}
