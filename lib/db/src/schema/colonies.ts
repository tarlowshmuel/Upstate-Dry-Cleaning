import { pgTable, serial, text, timestamp, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";

export const coloniesTable = pgTable(
  "colonies",
  {
    id: serial("id").primaryKey(),
    town: text("town").notNull(),
    name: text("name").notNull(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    displayLabel: text("display_label"),
    geocodedAt: timestamp("geocoded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    townNameIdx: uniqueIndex("colonies_town_name_idx").on(t.town, t.name),
  }),
);

export type Colony = typeof coloniesTable.$inferSelect;
