import { z } from "zod";

export const DUEL_PRESS_V2_CATEGORIES = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"] as const;
export const DUEL_PRESS_V2_CONTEXT_INDICATORS = ["netProgressionPer90", "goalsMinusXgot"] as const;
/** Server-owned shooting quality pairs introduced by stat-pairs-v2. */
export const DUEL_PRESS_V2_XGOT_MINUS_XG_METRICS = ["outsideBoxXgotMinusXg", "inBoxXgotMinusXg"] as const;
export type DuelPressV2CategoryId = typeof DUEL_PRESS_V2_CATEGORIES[number];
export type DuelPressV2ContextIndicatorId = typeof DUEL_PRESS_V2_CONTEXT_INDICATORS[number];

const finite = z.number().finite();
const score = z.number().int().min(0).max(99);
const rawScore = z.number().finite().min(0).max(99);
// Legacy stat-pairs metric percentiles stay integer 0..99.  The score-unified
// v3 category and overall headers are authoritative decimal 0..100 scores.
const unifiedScore = z.number().finite().min(0).max(100);
const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const direction = z.enum(["higher_is_better", "lower_is_better", "neutral"]);
const comparison = z.object({ state: z.enum(["available", "unavailable", "not_applicable"]), median: finite.nullable(), rank: z.number().int().positive().nullable(), population: z.number().int().nonnegative(), percentileScore: unifiedScore.nullable() }).strict().superRefine((value, ctx) => {
  if (value.state === "available" && (value.median === null || value.rank === null || value.percentileScore === null || value.population < 1 || value.rank > value.population)) ctx.addIssue({ code: "custom", message: "available comparison must be complete" });
  if (value.state === "not_applicable" && (value.median !== null || value.rank !== null || value.percentileScore !== null || value.population !== 0)) ctx.addIssue({ code: "custom", message: "not applicable comparison must be empty" });
  if (value.state === "unavailable" && value.rank !== null && value.rank > value.population) ctx.addIssue({ code: "custom", message: "unavailable rank exceeds population" });
});

const metricValue = z.object({ value: finite.nullable(), unit: z.enum(["count", "per90", "goals", "percent", "score"]), direction, state: z.enum(["observed", "server_derived", "imputed", "unavailable"]), source: z.enum(["player_season_total", "league_per90_fallback", "tactical_ratio_static", "server_derived", "provider_wins_attempts_derived_rate", "zero_attempts_observed", "unavailable"]), percentileScore: score.nullable(), formulaId: z.string().min(1).nullable(), formulaVersion: z.string().min(1).nullable(), comparison }).strict().superRefine((value, ctx) => {
  if (value.value === null && value.state !== "unavailable") ctx.addIssue({ code: "custom", message: "null metric value must be unavailable" });
  if (value.value !== null && value.state === "unavailable") ctx.addIssue({ code: "custom", message: "numeric metric cannot be unavailable" });
  if (value.state === "unavailable" && value.source !== "unavailable") ctx.addIssue({ code: "custom", message: "unavailable metric requires unavailable source" });
  if (value.state !== "unavailable" && value.source === "unavailable") ctx.addIssue({ code: "custom", message: "numeric metric cannot have unavailable source" });
});

const pairMetric = z.object({ id: z.string().min(1), label: z.string().min(1), pairReason: z.string().min(1).nullable(), pairState: z.enum(["complete", "partial", "unavailable", "scalar"]), per90: metricValue.nullable(), total: metricValue.nullable(), value: metricValue.nullable() }).strict().superRefine((metric, ctx) => {
  if (metric.pairState === "complete" && (!metric.total || !metric.per90 || metric.total.value === null || metric.per90.value === null)) ctx.addIssue({ code: "custom", message: "complete pair requires numeric total and per90" });
  if (metric.pairState === "partial" && (!metric.total || metric.total.value === null || metric.per90?.value !== null)) ctx.addIssue({ code: "custom", message: "partial pair requires numeric total and unavailable per90" });
  if (metric.pairState === "unavailable" && (metric.total?.value !== null || metric.per90?.value !== null)) ctx.addIssue({ code: "custom", message: "unavailable pair cannot contain numeric values" });
  if (metric.pairState === "scalar" && (!metric.value || metric.total !== null || metric.per90 !== null)) ctx.addIssue({ code: "custom", message: "scalar metric must use value only" });
});

const group = z.object({ id: z.string().min(1), label: z.string().min(1), kind: z.enum(["count_rate_pair", "duel_split", "spatial", "pressing"]), metrics: z.array(pairMetric).min(1) }).strict();
const scoreSample = z.object({ attempts: finite.nullable(), minutes: z.number().int().nonnegative() }).strict().superRefine((value, ctx) => {
  if (value.attempts !== null && value.attempts < 0) ctx.addIssue({ code: "custom", message: "score sample attempts must be nonnegative" });
});
const scoreBreakdown = z.object({ compositeScore: unifiedScore, volumeScore: unifiedScore, ratioScore: unifiedScore, volumeSample: scoreSample, ratioSample: scoreSample, sampleState: z.enum(["observed", "low_sample", "unavailable"]) }).strict().superRefine((value, ctx) => {
  const exactMean = (value.volumeScore + value.ratioScore) / 2;
  // The backend owns the two-decimal value. Accept either adjacent cent only
  // at an exact half-cent boundary, where Python and JavaScript round
  // differently; reject every value outside the nearest-cent interval.
  if (Math.abs(value.compositeScore - exactMean) > 0.0050000001) ctx.addIssue({ code: "custom", message: "score breakdown composite must equal the exact 50:50 pair" });
});
const category = z.object({ id: z.enum(DUEL_PRESS_V2_CATEGORIES), label: z.string().min(1), percentileScore: unifiedScore, scoreState: z.enum(["observed", "imputed", "unavailable"]), imputedComponents: z.array(z.string().min(1)), direction, comparison, formulaId: z.string().min(1), formulaVersion: z.string().min(1), scoreBreakdown: scoreBreakdown.nullable().optional(), groups: z.array(group).min(1) }).strict().superRefine((value, ctx) => {
  if (value.scoreState === "imputed" && value.imputedComponents.length === 0) ctx.addIssue({ code: "custom", message: "imputed category must identify components" });
  if (value.scoreState !== "imputed" && value.imputedComponents.length > 0) ctx.addIssue({ code: "custom", message: "imputed components require imputed category" });
  if (value.formulaVersion === "messi-score-unified-v3" && value.scoreBreakdown == null) ctx.addIssue({ code: "custom", message: "unified category requires exact scoreBreakdown" });
  if (value.formulaVersion === "stat-pairs-v2" && value.scoreBreakdown != null) ctx.addIssue({ code: "custom", message: "legacy category cannot contain unified scoreBreakdown" });
  if (value.scoreBreakdown && Math.abs(value.percentileScore - value.scoreBreakdown.compositeScore) > 0.005) ctx.addIssue({ code: "custom", message: "category score must equal breakdown composite" });
});

const context = z.object({ playerId: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scope.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict().superRefine((value, ctx) => {
  if (value.mode === "league" && (value.scope === null || value.competition !== null)) ctx.addIssue({ code: "custom", message: "league context must echo scope and null competition" });
  if (value.mode === "europe" && (value.scope !== null || value.competition === null)) ctx.addIssue({ code: "custom", message: "Europe context must echo competition and null scope" });
});

const indicator = z.object({ aggregate: z.boolean(), id: z.enum(DUEL_PRESS_V2_CONTEXT_INDICATORS), label: z.string().min(1), metric: pairMetric, tooltipFacts: z.array(pairMetric) }).strict();
const identity = z.object({ id: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), name: z.string().min(1), position: z.string().min(1), club: z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url() }).strict(), league: z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url() }).strict() }).strict();
const statSummary = z.object({ direction, imputedComponents: z.array(z.string()), percentileScore: unifiedScore, scoreState: z.enum(["observed", "imputed", "unavailable"]) }).strict();
const stats = z.object({ outsideShot: statSummary, boxThreat: statSummary, dangerZone: statSummary, combinedDuel: statSummary, spaceControl: statSummary, forwardPress: statSummary }).strict();
const playerData = z.object({ id: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), name: z.string().min(1), position: z.string().min(1), age: z.number().int().nonnegative().nullable(), minutes: z.number().int().nonnegative(), archetype: z.string().min(1), face: z.string().url(), club: z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url() }).strict(), league: z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url() }).strict(), nation: z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url() }).strict().nullable(), rank: z.number().int().positive(), tier: z.object({ code: z.string().min(1), label: z.string().min(1), level: z.number().int().positive(), taxonomyVersion: z.literal("crystal-v2") }).strict(), overallRating: z.object({ direction, formulaId: z.string().min(1), formulaVersion: z.string().min(1), percentileScore: unifiedScore, rawValue: unifiedScore, state: z.enum(["observed", "imputed", "unavailable"]), comparison }).strict(), stats }).strict();
const ratingVersion = z.enum(["stat-pairs-v2", "messi-score-unified-v3"]);
const envelopeFields = { schemaVersion: z.literal("2.0.0"), metricTaxonomyVersion: z.literal("duel-press-v2"), readoutVersion: z.literal("detail-readout-v2"), ratingVersion, ratingSnapshotId: z.string().regex(/^(?:stat-pairs-v2|messi-score-unified-v3):[0-9a-f]{16}$/) };
function verifyRatingSnapshot(value: { ratingVersion: z.infer<typeof ratingVersion>; ratingSnapshotId: string }, ctx: z.RefinementCtx) {
  if (!value.ratingSnapshotId.startsWith(`${value.ratingVersion}:`)) ctx.addIssue({ code: "custom", message: "rating snapshot prefix must match rating version" });
}

export const duelPressV2DetailMetricsSchema = z.object({ ...envelopeFields, context, cohortPopulation: z.number().int().nonnegative(), player: identity, categories: z.array(category).length(6), contextIndicators: z.array(indicator).length(2) }).strict().superRefine((value, ctx) => {
  verifyRatingSnapshot(value, ctx);
  if (value.categories.map((item) => item.id).join("|") !== DUEL_PRESS_V2_CATEGORIES.join("|")) ctx.addIssue({ code: "custom", message: "v2 category order is invalid" });
  if (value.contextIndicators.map((item) => item.id).join("|") !== DUEL_PRESS_V2_CONTEXT_INDICATORS.join("|")) ctx.addIssue({ code: "custom", message: "v2 indicator order is invalid" });
  const expectedFormulaId = value.ratingVersion === "messi-score-unified-v3" ? "pressing-sector-score-v3" : "stat-pairs-category-v2";
  if (value.categories.some((item) => item.formulaVersion !== value.ratingVersion || item.formulaId !== expectedFormulaId)) ctx.addIssue({ code: "custom", message: "category score formula must match the envelope rating version" });
});
export const duelPressV2PlayerSchema = z.object({ ...envelopeFields, context, cohortPopulation: z.number().int().nonnegative(), data: playerData }).strict().superRefine((value, ctx) => { verifyRatingSnapshot(value, ctx); if (value.context.playerId !== value.data.id || value.context.idNamespace !== value.data.idNamespace) ctx.addIssue({ code: "custom", message: "v2 player identity mismatch" }); });
const leaderboardMeta = z.object({ applied: z.object({ ageBand: z.string(), minutesBand: z.string(), order: z.enum(["asc", "desc"]), position: z.string().nullable(), q: z.string().nullable(), role: z.string().nullable(), sort: z.string() }).strict(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable(), generatedAt: z.string().min(1), hasNextPage: z.boolean(), mode: z.enum(["league", "europe"]), page: z.number().int().positive(), pageSize: z.literal(50), population: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), schemaVersion: z.literal("2.0.0"), scope: scope.nullable(), season: z.string().regex(/^20\d{2}\/20\d{2}$/), source: z.string().min(1), totalItems: z.number().int().nonnegative(), totalPages: z.number().int().nonnegative() }).strict();
const leaderboardContext = z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scope.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict();
export const duelPressV2LeaderboardSchema = z.object({ ...envelopeFields, context: leaderboardContext, cohortPopulation: z.number().int().nonnegative(), data: z.array(playerData), meta: leaderboardMeta }).strict().superRefine(verifyRatingSnapshot);

export type DuelPressV2DetailMetrics = z.infer<typeof duelPressV2DetailMetricsSchema>;
export type DuelPressV2Player = z.infer<typeof duelPressV2PlayerSchema>;
export type DuelPressV2Leaderboard = z.infer<typeof duelPressV2LeaderboardSchema>;
export type DuelPressV2Category = z.infer<typeof category>;
export type DuelPressV2Metric = z.infer<typeof pairMetric>;
export type DuelPressV2Context = z.infer<typeof context>;
