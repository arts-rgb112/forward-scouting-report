import { z } from "zod";
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const assetSchema = z.object({ id: z.number().int(), name: z.string().min(1), icon: httpsUrl.nullable() }).strict();
const tierTaxonomyVersionSchema = z.string().min(1).max(64);
// Codes are deliberately open during the staged taxonomy migration. Rendering resolves
// only recognized code/version pairs and shows a neutral Unknown tier for everything else.
const tierSchema = z.object({ code: z.string().min(1).max(64), level: z.number().int().min(1).max(5), label: z.string().min(1), taxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict();
const score = z.number().finite().min(0).max(100);
export const playerDtoSchema = z.object({
  id: z.number().int().positive(), rank: z.number().int().positive(), name: z.string().min(1), position: z.string().min(1),
  archetype: z.enum(["Type A", "Type B"]), age: z.number().int().min(15).max(60).nullable(), minutes: z.number().int().nonnegative(),
  tier: tierSchema, score, face: httpsUrl.nullable(), nation: assetSchema.nullable(), league: assetSchema, club: assetSchema,
  stats: z.object({ outsideShot: score, boxThreat: score, dangerZone: score, aerial: score, groundDuel: score, spaceControl: score }).strict(),
}).strict();
export const metaSchema = z.object({ schemaVersion: z.literal("1.0.0"), season: z.string().min(1), scope: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]), population: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort"), tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict();
export const playersEnvelopeSchema = z.object({ data: z.array(playerDtoSchema), meta: metaSchema, tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict().superRefine(({ data, meta }, ctx) => {
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

const scopeSchema = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const competitionSchema = z.enum(["all", "ucl", "uel", "uecl"]);
const appliedFiltersSchema = z.object({ position: z.string().min(1).nullable().optional() }).passthrough();
const leaderboardMetaSchema = z.object({ schemaVersion: z.literal("2.0.0"), season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(), population: z.number().int().nonnegative(), totalItems: z.number().int().nonnegative().optional(), returned: z.number().int().nonnegative(), generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort"), tierTaxonomyVersion: tierTaxonomyVersionSchema.optional(), applied: appliedFiltersSchema.optional() }).passthrough();
const leaderboardPageMetaSchema = leaderboardMetaSchema.omit({ schemaVersion: true }).extend({ schemaVersion: z.literal("2.1.0"), page: z.number().int().positive(), pageSize: z.number().int().min(1).max(250), totalPages: z.number().int().nonnegative(), hasNextPage: z.boolean() }).strict();
export const leaderboardEnvelopeSchema = z.object({ data: z.array(playerDtoSchema), meta: leaderboardMetaSchema, tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict();
export const leaderboardPageEnvelopeSchema = z.object({ data: z.array(playerDtoSchema), meta: leaderboardPageMetaSchema, tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict().superRefine(({ data, meta }, ctx) => {
  if (meta.returned !== data.length) ctx.addIssue({ code: "custom", path: ["meta", "returned"], message: "returned must equal data length" });
  if (meta.population < meta.returned) ctx.addIssue({ code: "custom", path: ["meta", "population"], message: "population must be >= returned" });
});

const radarAxisSchema = z.object({ id: z.string().min(1), label: z.string().min(1), score, percentile: score.nullable(), rank: z.number().int().positive().nullable(), population: z.number().int().nonnegative(), rawValue: z.number().finite().nullable(), tier: z.enum(["S", "A", "B", "C", "D"]), imputed: z.boolean() }).strict();
const radarSchema = z.object({ kind: z.enum(["volume", "ratio"]), axes: z.array(radarAxisSchema).length(6) }).strict();
const rawMetricsSchema = z.object({ goals: z.number().finite().nullable(), xg: z.number().finite().nullable(), xgot: z.number().finite().nullable(), minutesPlayed: z.number().finite().nullable(), dribblesSucceeded: z.number().finite().nullable(), dribblesSuccessRate: z.number().finite().nullable(), dispossessed: z.number().finite().nullable(), foulsWon: z.number().finite().nullable(), penaltiesAwarded: z.number().finite().nullable(), duelsWon: z.number().finite().nullable(), duelsWonPercentage: z.number().finite().nullable(), aerialDuelsWon: z.number().finite().nullable(), aerialDuelsWonPercentage: z.number().finite().nullable(), inBoxGoals: z.number().finite().nullable(), inBoxXg: z.number().finite().nullable(), inBoxXgot: z.number().finite().nullable(), inBoxShots: z.number().finite().nullable(), outBoxGoals: z.number().finite().nullable(), outBoxXg: z.number().finite().nullable(), outBoxXgot: z.number().finite().nullable(), outBoxShots: z.number().finite().nullable() }).strict();
const positionalGridCellSchema = z.object({ depth: z.number().int().min(1).max(6), lane: z.number().int().min(1).max(5), occupancyPct: score }).strict();
const trueCoreZoneSchema = z.object({ id: z.string().regex(/^depth[1-6]_lane[1-5]$/), depth: z.number().int().min(1).max(6), lane: z.number().int().min(1).max(5), densityPct: z.number().finite().positive().max(100), areaPct: z.number().finite().positive().max(100) }).strict();
const trueCoreSchema = z.object({ available: z.boolean(), gridVersion: z.literal("positional-6x5-v1"), definitionVersion: z.literal("true-core-50-v1"), targetDensityPct: z.literal(50), achievedDensityPct: score, zoneIds: z.array(z.string().regex(/^depth[1-6]_lane[1-5]$/)).max(30), zoneCount: z.number().int().min(0).max(30), coreAreaPct: score, tieBreak: z.literal("density-desc-depth-asc-lane-asc"), zones: z.array(trueCoreZoneSchema).max(30) }).strict().superRefine((core, ctx) => {
  if (core.zoneCount !== core.zoneIds.length || core.zoneCount !== core.zones.length) ctx.addIssue({ code: "custom", path: ["zoneCount"], message: "zoneCount must match zoneIds and zones" });
  if (core.zoneIds.some((id, index) => id !== core.zones[index]?.id)) ctx.addIssue({ code: "custom", path: ["zoneIds"], message: "zoneIds must match zones in server order" });
});
const shotmapPointSchema = z.object({ x: score, y: score, outcome: z.enum(["goal", "on_target", "off_target", "blocked"]), xg: z.number().finite().nonnegative().nullable().optional(), xgot: z.number().finite().nonnegative().nullable().optional() }).strict();
const continuousCoreSchema = z.object({ available: z.boolean(), definitionVersion: z.literal("continuous-hdr-50-v1"), targetDensityPct: z.literal(50), achievedDensityPct: score, coreAreaPct: score, densityThreshold: z.number().finite().nonnegative(), thresholdOfPeak: z.number().finite().min(0).max(1), gridColumns: z.literal(32), gridRows: z.literal(22) }).strict();
const spatialSchema = z.object({ available: z.boolean(), source: z.literal("messi-static-cohort"), heatmapPointCount: z.number().int().nonnegative(), heatmapPoints: z.array(z.object({ x: score, y: score }).strict()), shotmapPointCount: z.number().int().nonnegative(), shotmapPoints: z.array(shotmapPointSchema), shotmapSnapshotAvailable: z.boolean(), inBoxRatio: score.nullable(), outBoxFinalRatio: score.nullable(), midThirdRatio: score.nullable(), finalThirdRatio: score.nullable(), ccaAreaPct: score.nullable(), laneRatios: z.array(z.number().finite()).max(5), depthRatios: z.array(score).max(6), positionalGrid: z.array(positionalGridCellSchema).max(30), trueCore: trueCoreSchema, continuousCore: continuousCoreSchema, dangerZoneDensity: score.nullable(), deepBoxZoneScore: score.nullable() }).strict().superRefine((spatial, ctx) => {
  if (spatial.shotmapPointCount !== spatial.shotmapPoints.length) ctx.addIssue({ code: "custom", path: ["shotmapPointCount"], message: "shotmapPointCount must equal shotmapPoints length" });
});
const analysisSchema = z.object({ score: z.object({ value: score, rank: z.number().int().positive().nullable(), topPercent: score.nullable(), population: z.number().int().nonnegative(), archetype: z.enum(["Type A", "Type B"]) }).strict(), volumeRadar: radarSchema.extend({ kind: z.literal("volume") }), ratioRadar: radarSchema.extend({ kind: z.literal("ratio") }), rawMetrics: rawMetricsSchema, spatial: spatialSchema }).strict();
export const playerDetailEnvelopeSchema = z.object({ data: playerDtoSchema.extend({ analysis: analysisSchema.optional() }), tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict();
const tacticalQuadrantPointSchema = z.object({ playerId: z.number().int().positive(), playerName: z.string().min(1), teamName: z.string(), netProgressionPer90: z.number().finite(), inBoxXgotMinusXg: z.number().finite(), selected: z.boolean() }).strict();
export const tacticalQuadrantEnvelopeSchema = z.object({ data: z.object({ playerId: z.number().int().positive(), season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(), available: z.boolean(), reason: z.enum(["complete", "axis_metric_missing", "cohort_unavailable"]), source: z.literal("messi-static-cohort"), cohortPopulation: z.number().int().nonnegative(), xAxis: z.literal("netProgressionPer90"), yAxis: z.literal("inBoxXgotMinusXg"), xMedian: z.number().finite().nullable(), yMedian: z.number().finite().nullable(), selectedPoint: tacticalQuadrantPointSchema.nullable(), points: z.array(tacticalQuadrantPointSchema) }).strict() }).strict();
export const comparisonEnvelopeSchema = z.object({ data: z.array(playerDtoSchema.extend({ analysis: analysisSchema })).min(2).max(4), meta: z.object({ season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(), population: z.number().int().nonnegative(), generatedAt: z.string().datetime({ offset: true }), source: z.literal("messi-static-cohort"), tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict(), tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict();

/** The resolver is deliberately contextual: one person may have several valid rows. */
export const watchlistResolveResultSchema = z.object({
  key: z.string().max(500),
  status: z.enum(["resolved", "unavailable", "invalid_context"]),
  player: playerDtoSchema.extend({ idNamespace: z.literal("fotmob"), playerId: z.number().int().positive() }).nullable(),
  context: z.object({ season: z.string(), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable() }).nullable(),
}).strict();
export const watchlistResolveEnvelopeSchema = z.object({ results: z.array(watchlistResolveResultSchema).max(100), tierTaxonomyVersion: tierTaxonomyVersionSchema.optional() }).strict();
export type WatchlistResolveResultDto = z.infer<typeof watchlistResolveResultSchema>;

/** These companion contracts are intentionally separate from the established player DTOs. */
const metricKeySchema = z.enum(["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"]);
const qualityReasonSchema = z.enum(["complete", "spatial_session_missing", "source_metric_missing", "mixed_source_missing"]);
const qualityContextSchema = z.object({
  season: z.string().min(1), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(),
}).strict();
const imputedComponentSchema = z.string().refine(
  (value) => /^(outsideShot|boxThreat|dangerZone|aerial|groundDuel|spaceControl)\.(volume|ratio)$/.test(value),
  "must name a known metric component",
);
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
export const dataQualitySchema = z.object({
  qualityVersion: z.literal("messi-quality-v1"), spatialAvailable: z.boolean(), messiScoreComplete: z.boolean(), reason: qualityReasonSchema,
  imputedMetrics: z.array(metricKeySchema).max(6).refine(unique, "imputed metrics must be unique"),
  imputedComponents: z.array(imputedComponentSchema).max(12).refine(unique, "imputed components must be unique"),
  observedWeightPct: z.number().finite().min(0).max(100), fallbackComponentScore: z.literal(20),
}).strict().superRefine((value, ctx) => {
  const arraysEmpty = value.imputedMetrics.length === 0 && value.imputedComponents.length === 0;
  if (value.messiScoreComplete && (value.reason !== "complete" || !arraysEmpty)) ctx.addIssue({ code: "custom", path: ["reason"], message: "complete quality requires the complete reason and no imputed fields" });
  if (!value.messiScoreComplete && (value.reason === "complete" || arraysEmpty)) ctx.addIssue({ code: "custom", path: ["reason"], message: "incomplete quality must declare a non-complete reason and imputed fields" });
  if (value.messiScoreComplete && value.reason === "complete" && arraysEmpty && !value.spatialAvailable) ctx.addIssue({ code: "custom", path: ["spatialAvailable"], message: "complete quality requires spatial data" });
  value.imputedComponents.forEach((component, index) => {
    const metric = component.split(".", 1)[0];
    if (!value.imputedMetrics.some((imputedMetric) => imputedMetric === metric)) ctx.addIssue({ code: "custom", path: ["imputedComponents", index], message: "imputed component metric must be listed in imputedMetrics" });
  });
});
export const playerDataQualityEnvelopeSchema = z.object({
  data: z.object({ playerId: z.number().int().positive(), ...qualityContextSchema.shape, dataQuality: dataQualitySchema }).strict(),
}).strict();
export const watchlistDataQualityResultSchema = z.object({
  key: z.string().max(500), status: z.enum(["resolved", "unavailable", "invalid_context"]), playerId: z.number().int().positive().nullable(),
  context: qualityContextSchema.nullable(), dataQuality: dataQualitySchema.nullable(),
}).strict();
export const watchlistDataQualityEnvelopeSchema = z.object({ results: z.array(watchlistDataQualityResultSchema).max(100) }).strict();
export type DataQualityDto = z.infer<typeof dataQualitySchema>;
export type PlayerDataQualityDto = z.infer<typeof playerDataQualityEnvelopeSchema>["data"];
export type WatchlistDataQualityResultDto = z.infer<typeof watchlistDataQualityResultSchema>;
