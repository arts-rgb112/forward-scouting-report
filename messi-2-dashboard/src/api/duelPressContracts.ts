import { z } from "zod";

const score = z.number().finite().min(0).max(100);
const httpUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const assetSchema = z.object({ id: z.number().int(), name: z.string().min(1), icon: httpUrl }).strict();
const tierSchema = z.object({ code: z.enum(["diamond", "emerald", "platinum", "gold", "silver", "bronze"]), level: z.number().int().min(1).max(5), label: z.string().min(1), taxonomyVersion: z.literal("crystal-v2") }).strict();
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
export const duelPressPlayerSchema = z.object({
  id: z.number().int().positive().safe(), rank: z.number().int().positive().safe(), name: z.string().min(1), position: z.string().min(1), archetype: z.enum(["Type A", "Type B"]),
  age: z.number().int().min(15).max(60).nullable(), minutes: z.number().int().nonnegative().safe(), tier: tierSchema, score, face: httpUrl, nation: assetSchema.nullable(), league: assetSchema, club: assetSchema,
  idNamespace: z.literal("fotmob"),
  stats: duelPressStatsSchema, components: duelPressComponentsSchema, pressingRawMetrics: pressingRawMetricsSchema,
}).strict();
export const duelPressRowCoreSchema = duelPressPlayerSchema;
const scopeSchema = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
export const duelPressContextSchema = z.object({ playerId: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict().superRefine((context, ctx) => {
  if (context.mode === "league" && (context.scope === null || context.competition !== null)) ctx.addIssue({ code: "custom", path: ["mode"], message: "league response requires scope and null competition" });
  if (context.mode === "europe" && (context.scope !== null || context.competition === null)) ctx.addIssue({ code: "custom", path: ["mode"], message: "Europe response requires null scope and canonical competition" });
});
export const duelPressTopDiscriminatorSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1") }).strict();
const duelPressSortSchema = z.enum(["rank", "score", "name", "minutes", "age", "outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"]);
const appliedSchema = z.object({ role: z.enum(["Type A", "Type B"]).nullable(), position: z.string().min(1).nullable(), q: z.string().min(1).nullable(), ageBand: z.enum(["all", "u23", "u25", "26-30", "31-plus"]), minutesBand: z.enum(["all", "200-499", "500-999", "1000-1499", "1500-1999", "2000-2999", "3000-plus"]), sort: duelPressSortSchema, order: z.enum(["asc", "desc"]) }).strict();
export const duelPressPageMetaCoreSchema = z.object({ schemaVersion: z.literal("1.1.0"), season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable(), population: z.number().int().nonnegative().safe(), returned: z.number().int().min(0).max(50), page: z.number().int().positive().safe(), pageSize: z.literal(50), totalItems: z.number().int().nonnegative().safe(), totalPages: z.number().int().nonnegative().safe(), hasNextPage: z.boolean(), applied: appliedSchema, generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort") }).strict().superRefine((meta, ctx) => {
  if (meta.mode === "league" && (meta.scope === null || meta.competition !== null)) ctx.addIssue({ code: "custom", path: ["mode"], message: "league metadata requires scope and null competition" });
  if (meta.mode === "europe" && (meta.scope !== null || meta.competition === null)) ctx.addIssue({ code: "custom", path: ["mode"], message: "Europe metadata requires competition and null scope" });
});
export const duelPressLeaderboardCoreSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1"), data: z.array(duelPressRowCoreSchema), meta: duelPressPageMetaCoreSchema }).strict().superRefine(({ data, meta }, ctx) => {
  if (meta.returned !== data.length) ctx.addIssue({ code: "custom", path: ["meta", "returned"], message: "returned must equal data length" });
  if (new Set(data.map((row) => row.id)).size !== data.length) ctx.addIssue({ code: "custom", path: ["data"], message: "player IDs must be unique" });
  if (meta.totalPages !== Math.ceil(meta.totalItems / 50)) ctx.addIssue({ code: "custom", path: ["meta", "totalPages"], message: "totalPages must match totalItems" });
  if (meta.hasNextPage !== (meta.page < meta.totalPages)) ctx.addIssue({ code: "custom", path: ["meta", "hasNextPage"], message: "hasNextPage must match page totals" });
  if ((meta.totalItems === 0 && (meta.page !== 1 || data.length !== 0)) || (meta.page > meta.totalPages && data.length !== 0)) ctx.addIssue({ code: "custom", path: ["data"], message: "empty and overflow page contracts must hold" });
  if (meta.totalItems > 0 && meta.page <= meta.totalPages && data.length === 0) ctx.addIssue({ code: "custom", path: ["data"], message: "an in-range non-empty dataset page cannot be empty" });
  const currentPageCapacity = meta.page <= meta.totalPages ? Math.min(50, Math.max(0, meta.totalItems - (meta.page - 1) * 50)) : 0;
  if (data.length > currentPageCapacity) ctx.addIssue({ code: "custom", path: ["data"], message: "returned rows exceed current-page capacity" });
});
export const duelPressDetailCoreSchema = z.object({ metricTaxonomyVersion: z.literal("duel-press-v1"), context: duelPressContextSchema, data: duelPressPlayerSchema }).strict().superRefine(({ context, data }, ctx) => { if (context.playerId !== data.id || context.idNamespace !== data.idNamespace) ctx.addIssue({ code: "custom", path: ["context"], message: "detail identity must match data" }); });
export type DuelPressRowCoreDto = z.infer<typeof duelPressPlayerSchema>;
export type DuelPressLeaderboardDto = z.infer<typeof duelPressLeaderboardCoreSchema>;
export type DuelPressDetailDto = z.infer<typeof duelPressDetailCoreSchema>;
