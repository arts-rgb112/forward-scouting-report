import { z } from "zod";

const score = z.number().finite().min(0).max(100);
const rawValue = z.number().finite().nonnegative().nullable();
export const duelPressStatsSchema = z.object({ outsideShot: score, boxThreat: score, dangerZone: score, combinedDuel: score, spaceControl: score, forwardPress: score }).strict();
export const duelPressComponentsSchema = z.object({ combinedDuelVolume: score, combinedDuelEfficiency: score, recoveries: score, finalThirdPossessionsWon: score }).strict();
const sourceSchema = z.enum(["player_season_total", "league_per90_fallback"]).nullable();
export const pressingRawMetricsSchema = z.object({
  recoveries: rawValue, recoveriesPer90: rawValue, recoveriesSource: sourceSchema,
  finalThirdPossessionsWon: rawValue, finalThirdPossessionsWonPer90: rawValue, finalThirdPossessionsWonSource: sourceSchema,
}).strict().superRefine((raw, ctx) => {
  const check = (total: number | null, per90: number | null, source: z.infer<typeof sourceSchema>, field: string) => {
    // Both real sources provide both values. Only unavailable (null source) provides neither.
    const valid = source === null ? total === null && per90 === null : total !== null && per90 !== null;
    if (!valid) ctx.addIssue({ code: "custom", path: [field], message: "source and total/per90 availability must agree" });
  };
  check(raw.recoveries, raw.recoveriesPer90, raw.recoveriesSource, "recoveriesSource");
  check(raw.finalThirdPossessionsWon, raw.finalThirdPossessionsWonPer90, raw.finalThirdPossessionsWonSource, "finalThirdPossessionsWonSource");
});
export const duelPressIdentitySchema = z.object({ id: z.number().int().positive(), idNamespace: z.literal("fotmob") }).strict();
/** A strict row-owned metric fragment. A row-level discriminator is always rejected. */
export const duelPressRowCoreSchema = z.object({
  id: z.number().int().positive(), idNamespace: z.literal("fotmob"), rank: z.number().int().positive(), score,
  stats: duelPressStatsSchema, components: duelPressComponentsSchema, pressingRawMetrics: pressingRawMetricsSchema,
}).strict();
const scopeSchema = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
export const duelPressContextSchema = z.object({ season: z.string().regex(/^\d{4}\/\d{4}$/), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict().superRefine((context, ctx) => {
  if (context.mode === "league" && (context.scope === null || context.competition !== null)) ctx.addIssue({ code: "custom", path: ["mode"], message: "league response requires scope and null competition" });
  if (context.mode === "europe" && (context.scope !== null || context.competition === null)) ctx.addIssue({ code: "custom", path: ["mode"], message: "Europe response requires null scope and canonical competition" });
});
export const duelPressTopDiscriminatorSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1") }).strict();
export const duelPressPageMetaCoreSchema = z.object({ page: z.number().int().positive(), pageSize: z.literal(50), totalItems: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative(), returned: z.number().int().min(0).max(50), hasNextPage: z.boolean() }).strict();
export const duelPressLeaderboardCoreSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1"), data: z.array(duelPressRowCoreSchema), meta: duelPressPageMetaCoreSchema }).strict().superRefine(({ data, meta }, ctx) => {
  if (meta.returned !== data.length) ctx.addIssue({ code: "custom", path: ["meta", "returned"], message: "returned must equal data length" });
  if (new Set(data.map((row) => row.id)).size !== data.length) ctx.addIssue({ code: "custom", path: ["data"], message: "player IDs must be unique" });
  if (meta.totalPages !== Math.ceil(meta.totalItems / 50)) ctx.addIssue({ code: "custom", path: ["meta", "totalPages"], message: "totalPages must match totalItems" });
  if (meta.hasNextPage !== (meta.page < meta.totalPages)) ctx.addIssue({ code: "custom", path: ["meta", "hasNextPage"], message: "hasNextPage must match page totals" });
  if ((meta.totalItems === 0 && (meta.page !== 1 || data.length !== 0)) || (meta.page > meta.totalPages && data.length !== 0)) ctx.addIssue({ code: "custom", path: ["data"], message: "empty and overflow page contracts must hold" });
  if (meta.totalItems > 0 && meta.page <= meta.totalPages && data.length === 0) ctx.addIssue({ code: "custom", path: ["data"], message: "an in-range non-empty dataset page cannot be empty" });
});
export const duelPressDetailCoreSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1"), context: duelPressContextSchema, data: duelPressRowCoreSchema }).strict();
export type DuelPressRowCoreDto = z.infer<typeof duelPressRowCoreSchema>;
