import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function nextOrderNumber(): Promise<string> {
  const result = await db.execute<{ nextval: string }>(
    sql`SELECT nextval('order_number_seq') AS nextval`,
  );
  const rows = (result as unknown as { rows: { nextval: string | number }[] }).rows
    ?? (result as unknown as { nextval: string | number }[]);
  const raw = Array.isArray(rows) ? rows[0]?.nextval : undefined;
  if (raw === undefined) throw new Error("Failed to read nextval from order_number_seq");
  const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
  return `DRY-${String(n).padStart(4, "0")}`;
}
