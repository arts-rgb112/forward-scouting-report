import { z } from "zod";
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const assetSchema = z.object({ id: z.number().int(), name: z.string().min(1), icon: httpsUrl.nullable() }).strict();
const tierSchema = z.object({ code: z.enum(["diamond", "platinum", "gold", "silver", "bronze", "iron"]), level: z.number().int().min(1).max(5), label: z.string().min(1) }).strict();
const score = z.number().finite().min(0).max(100);
export const playerDtoSchema = z.object({
  id: z.number().int().positive(), rank: z.number().int().positive(), name: z.string().min(1), position: z.string().min(1),
  archetype: z.enum(["Type A", "Type B"]), age: z.number().int().min(15).max(60).nullable(), minutes: z.number().int().nonnegative(),
  tier: tierSchema, score, face: httpsUrl.nullable(), nation: assetSchema.nullable(), league: assetSchema, club: assetSchema,
  stats: z.object({ outsideShot: score, boxThreat: score, dangerZone: score, aerial: score, groundDuel: score, spaceControl: score }).strict(),
}).strict();
export const metaSchema = z.object({ schemaVersion: z.literal("1.0.0"), season: z.string().min(1), scope: z.union([z.literal(3), z.literal(5), z.literal(7)]), population: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort") }).strict();
export const playersEnvelopeSchema = z.object({ data: z.array(playerDtoSchema), meta: metaSchema }).strict().superRefine(({ data, meta }, ctx) => {
  if (meta.returned !== data.length) ctx.addIssue({ code: "custom", path: ["meta", "returned"], message: "returned must equal data length" });
  if (meta.population < meta.returned) ctx.addIssue({ code: "custom", path: ["meta", "population"], message: "population must be >= returned" });
  if (!data.length && meta.population > 0) ctx.addIssue({ code: "custom", path: ["data"], message: "empty page cannot represent a non-empty population" });
  for (const key of ["id", "rank"] as const) if (new Set(data.map((player) => player[key])).size !== data.length) ctx.addIssue({ code: "custom", path: ["data"], message: `${key} must be unique` });
});
export type PlayerDto = z.infer<typeof playerDtoSchema>;
export type PlayersEnvelope = z.infer<typeof playersEnvelopeSchema>;
export function parsePlayersEnvelope(input: unknown, expected: { season: string; scope: number }): PlayersEnvelope {
  const parsed = playersEnvelopeSchema.parse(input);
  if (parsed.meta.season !== expected.season || parsed.meta.scope !== expected.scope) throw new z.ZodError([{ code: "custom", path: ["meta"], message: "response metadata does not match request", input }]);
  return parsed;
}

const scopeSchema = z.union([z.literal(3), z.literal(5), z.literal(7)]);
const competitionSchema = z.enum(["all", "ucl", "uel", "uecl"]);
const appliedFiltersSchema = z.object({ position: z.string().min(1).nullable().optional() }).passthrough();
const leaderboardMetaSchema = z.object({ schemaVersion: z.literal("2.0.0"), season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(), population: z.number().int().nonnegative(), totalItems: z.number().int().nonnegative().optional(), returned: z.number().int().nonnegative(), generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort"), applied: appliedFiltersSchema.optional() }).passthrough();
const leaderboardPageMetaSchema = leaderboardMetaSchema.omit({ schemaVersion: true }).extend({ schemaVersion: z.literal("2.1.0"), page: z.number().int().positive(), pageSize: z.number().int().min(1).max(250), totalPages: z.number().int().nonnegative(), hasNextPage: z.boolean() }).strict();
export const leaderboardEnvelopeSchema = z.object({ data: z.array(playerDtoSchema), meta: leaderboardMetaSchema }).strict();
export const leaderboardPageEnvelopeSchema = z.object({ data: z.array(playerDtoSchema), meta: leaderboardPageMetaSchema }).strict().superRefine(({ data, meta }, ctx) => {
  if (meta.returned !== data.length) ctx.addIssue({ code: "custom", path: ["meta", "returned"], message: "returned must equal data length" });
  if (meta.population < meta.returned) ctx.addIssue({ code: "custom", path: ["meta", "population"], message: "population must be >= returned" });
});

const radarAxisSchema = z.object({ id: z.string().min(1), label: z.string().min(1), score, percentile: score.nullable(), rank: z.number().int().positive().nullable(), population: z.number().int().nonnegative(), rawValue: z.number().finite().nullable(), tier: z.enum(["S", "A", "B", "C", "D"]), imputed: z.boolean() }).strict();
const radarSchema = z.object({ kind: z.enum(["volume", "ratio"]), axes: z.array(radarAxisSchema).length(6) }).strict();
const rawMetricsSchema = z.object({ goals: z.number().finite().nullable(), xg: z.number().finite().nullable(), xgot: z.number().finite().nullable(), minutesPlayed: z.number().finite().nullable(), dribblesSucceeded: z.number().finite().nullable(), dribblesSuccessRate: z.number().finite().nullable(), dispossessed: z.number().finite().nullable(), foulsWon: z.number().finite().nullable(), penaltiesAwarded: z.number().finite().nullable(), duelsWon: z.number().finite().nullable(), duelsWonPercentage: z.number().finite().nullable(), aerialDuelsWon: z.number().finite().nullable(), aerialDuelsWonPercentage: z.number().finite().nullable(), inBoxGoals: z.number().finite().nullable(), inBoxXg: z.number().finite().nullable(), inBoxXgot: z.number().finite().nullable(), inBoxShots: z.number().finite().nullable(), outBoxGoals: z.number().finite().nullable(), outBoxXg: z.number().finite().nullable(), outBoxXgot: z.number().finite().nullable(), outBoxShots: z.number().finite().nullable() }).strict();
const analysisSchema = z.object({ score: z.object({ value: score, rank: z.number().int().positive().nullable(), topPercent: score.nullable(), population: z.number().int().nonnegative(), archetype: z.enum(["Type A", "Type B"]) }).strict(), volumeRadar: radarSchema.extend({ kind: z.literal("volume") }), ratioRadar: radarSchema.extend({ kind: z.literal("ratio") }), rawMetrics: rawMetricsSchema, spatial: z.object({ available: z.boolean(), source: z.literal("messi-static-cohort"), heatmapPointCount: z.number().int().nonnegative(), heatmapPoints: z.array(z.object({ x: score, y: score }).strict()), inBoxRatio: score.nullable(), outBoxFinalRatio: score.nullable(), midThirdRatio: score.nullable(), finalThirdRatio: score.nullable(), ccaAreaPct: score.nullable(), laneRatios: z.array(z.number().finite()).max(5), dangerZoneDensity: score.nullable(), deepBoxZoneScore: score.nullable() }).strict() }).strict();
export const playerDetailEnvelopeSchema = z.object({ data: playerDtoSchema.extend({ analysis: analysisSchema.optional() }) }).strict();
export const comparisonEnvelopeSchema = z.object({ data: z.array(playerDtoSchema.extend({ analysis: analysisSchema })).min(2).max(4), meta: z.object({ season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(), population: z.number().int().nonnegative(), generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort") }).strict() }).strict();

/** The resolver is deliberately contextual: one person may have several valid rows. */
export const watchlistResolveResultSchema = z.object({
  key: z.string().max(500),
  status: z.enum(["resolved", "unavailable", "invalid_context"]),
  player: playerDtoSchema.extend({ idNamespace: z.literal("fotmob"), playerId: z.number().int().positive() }).nullable(),
  context: z.object({ season: z.string(), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable() }).nullable(),
}).strict();
export const watchlistResolveEnvelopeSchema = z.object({ results: z.array(watchlistResolveResultSchema).max(100) }).strict();
export type WatchlistResolveResultDto = z.infer<typeof watchlistResolveResultSchema>;
