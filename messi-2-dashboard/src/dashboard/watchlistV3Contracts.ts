import { z } from "zod";

import { duelPressPlayerSchema } from "../api/duelPressContracts";
import type { DuelPressModeContext } from "../api/duelPressTypes";

export const WATCHLIST_V2_SOURCE_KEY = "messi-2-watchlist:v2" as const;
export const WATCHLIST_V3_KEY = "messi-2-watchlist:v3" as const;

const isoDate = z.string().datetime({ offset: true });
const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
export const watchlistV3ContextSchema = z.discriminatedUnion("mode", [
  z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.literal("league"), scope, competition: z.literal("all") }).strict(),
  z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.literal("europe"), scope: z.null(), competition: z.enum(["all", "ucl", "uel", "uecl"]) }).strict(),
]);

const tier = z.object({ code: z.string().min(1), level: z.number().finite(), label: z.string().min(1), taxonomyVersion: z.string().min(1).optional() }).strict();
const legacyStats = z.object({ outsideShot: z.number().finite().optional(), boxThreat: z.number().finite().optional(), dangerZone: z.number().finite().optional(), aerial: z.number().finite().optional(), groundDuel: z.number().finite().optional(), spaceControl: z.number().finite().optional() }).strict();
export const legacyWatchlistV3SnapshotSchema = z.object({
  profile: z.enum(["complete", "legacy-partial"]).optional(), name: z.string().min(1), position: z.string(), clubName: z.string(), leagueName: z.string().optional(), face: z.string().nullable().optional(),
  score: z.number().finite().optional(), tierLabel: z.string().optional(), archetype: z.enum(["Type A", "Type B"]).optional(), age: z.number().int().nullable().optional(), minutes: z.number().finite().nonnegative().optional(), tier: tier.optional(), tierTaxonomyVersion: z.string().optional(), stats: legacyStats.optional(),
}).strict();

export function watchlistV3Key(taxonomy: "legacy-v1" | "duel-press-v1", playerId: number, context: DuelPressModeContext): string {
  if (!Number.isSafeInteger(playerId) || playerId <= 0) throw new Error("playerId must be a positive safe integer");
  return JSON.stringify([taxonomy, "fotmob", playerId, context.season, context.mode, context.scope, context.competition]);
}

const commonEntry = z.object({ version: z.literal(3), namespace: z.literal("fotmob"), key: z.string().min(1), playerId: z.number().int().positive().safe(), context: watchlistV3ContextSchema, savedAt: isoDate }).strict();
const legacyEntry = commonEntry.extend({ taxonomy: z.literal("legacy-v1"), snapshot: legacyWatchlistV3SnapshotSchema }).strict();
const duelEntry = commonEntry.extend({ taxonomy: z.literal("duel-press-v1"), snapshot: duelPressPlayerSchema }).strict();
export const watchlistV3EntrySchema = z.discriminatedUnion("taxonomy", [legacyEntry, duelEntry]).superRefine((entry, ctx) => {
  const canonical = watchlistV3Key(entry.taxonomy, entry.playerId, entry.context);
  if (entry.key !== canonical) ctx.addIssue({ code: "custom", path: ["key"], message: "stored key must equal the canonical identity key" });
  if (entry.taxonomy === "duel-press-v1" && (entry.snapshot.id !== entry.playerId || entry.snapshot.idNamespace !== entry.namespace)) ctx.addIssue({ code: "custom", path: ["snapshot"], message: "snapshot identity must match entry identity" });
});

export const watchlistV3EnvelopeSchema = z.object({
  version: z.literal(3), revision: z.number().int().nonnegative().safe().optional(), entries: z.array(watchlistV3EntrySchema), selectedEntryKeys: z.array(z.string()).max(2),
  migration: z.object({ v2SourceKey: z.literal(WATCHLIST_V2_SOURCE_KEY), completedAt: isoDate.nullable() }).strict(), updatedAt: isoDate,
}).strict().superRefine((value, ctx) => {
  const keys = value.entries.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["entries"], message: "entry keys must be unique" });
  if (new Set(value.selectedEntryKeys).size !== value.selectedEntryKeys.length) ctx.addIssue({ code: "custom", path: ["selectedEntryKeys"], message: "selected keys must be unique" });
  const known = new Set(keys);
  value.selectedEntryKeys.forEach((key, index) => { if (!known.has(key)) ctx.addIssue({ code: "custom", path: ["selectedEntryKeys", index], message: "selected key must reference an entry" }); });
});

export type WatchlistV3Context = z.infer<typeof watchlistV3ContextSchema>;
export type WatchlistV3Entry = z.infer<typeof watchlistV3EntrySchema>;
export type LegacyV3Entry = Extract<WatchlistV3Entry, { taxonomy: "legacy-v1" }>;
export type DuelPressV3Entry = Extract<WatchlistV3Entry, { taxonomy: "duel-press-v1" }>;
export type WatchlistV3Envelope = z.infer<typeof watchlistV3EnvelopeSchema>;

export function parseWatchlistV3(raw: string | null): WatchlistV3Envelope | null {
  if (raw === null) return null;
  try { const parsed = watchlistV3EnvelopeSchema.safeParse(JSON.parse(raw)); return parsed.success ? structuredClone(parsed.data) : null; } catch { return null; }
}
