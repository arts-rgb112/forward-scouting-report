import { z } from "zod";

const finite = z.number().finite();
const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
export const finalThirdZoneIds = ["depth6_lane1", "depth6_lane2", "depth6_lane3", "depth6_lane4", "depth6_lane5", "depth5_lane1", "depth5_lane2", "depth5_lane3", "depth5_lane4", "depth5_lane5"] as const;
const zoneId = z.enum(finalThirdZoneIds);
const fieldState = z.object({ state: z.enum(["observed", "partial", "unavailable"]), reason: z.string().min(1).nullable(), source: z.literal("player_season_shot_events").nullable(), formulaVersion: z.string().min(1).nullable() }).strict().superRefine((value, ctx) => {
  if ((value.state === "observed") !== (value.reason === null)) ctx.addIssue({ code: "custom", message: "field state reason is inconsistent" });
});
const zone = z.object({
  zoneId, depth: z.union([z.literal(5), z.literal(6)]), lane: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), shotsTotal: z.number().int().nonnegative().nullable(), goals: z.number().int().nonnegative().nullable(), conversionRatePct: finite.min(0).max(100).nullable(), qualityScore: finite.nullable(), qualityEligibleShots: z.number().int().nonnegative().nullable(), state: z.enum(["observed", "partial", "unavailable"]), reason: z.string().min(1).nullable(), source: z.literal("player_season_shot_events").nullable(), qualityFormulaVersion: z.literal("avg-xgot-minus-avg-xg-v1"), fieldStates: z.object({ volume: fieldState, conversionRatePct: fieldState, qualityScore: fieldState }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.zoneId !== `depth${value.depth}_lane${value.lane}`) ctx.addIssue({ code: "custom", message: "zone identity is inconsistent" });
  if (value.shotsTotal === null && [value.goals, value.conversionRatePct, value.qualityScore, value.qualityEligibleShots].some((item) => item !== null)) ctx.addIssue({ code: "custom", message: "unavailable zone contains metrics" });
  if (value.shotsTotal !== null && (value.goals === null || value.goals > value.shotsTotal)) ctx.addIssue({ code: "custom", message: "zone goal count is inconsistent" });
  if (value.shotsTotal !== null && value.shotsTotal > 0 && value.conversionRatePct === null) ctx.addIssue({ code: "custom", message: "positive zone volume requires conversion" });
  if (value.shotsTotal !== null && value.shotsTotal > 0 && value.goals === 0 && value.conversionRatePct !== 0) ctx.addIssue({ code: "custom", message: "positive zero-goal zone must retain zero conversion" });
  if (value.shotsTotal === 0 && (value.conversionRatePct !== null || value.qualityScore !== null || value.qualityEligibleShots !== 0 || value.fieldStates.conversionRatePct.reason !== "no_attempts_in_zone" || value.fieldStates.qualityScore.reason !== "no_attempts_in_zone")) ctx.addIssue({ code: "custom", message: "observed zero must retain null rate and quality" });
});
const shot = z.object({ shotId: z.string().min(1), shotIdSource: z.enum(["provider_event", "snapshot_record"]), zoneId, pitchX: finite.min(0).max(100), pitchY: finite.min(0).max(100), xg: finite.min(0).nullable(), xgot: finite.min(0).nullable(), status: z.enum(["goal", "on_target", "off_target", "blocked"]), endpointAvailable: z.boolean(), goalMouthY: finite.nullable(), goalMouthZ: finite.nullable(), endpointReason: z.string().min(1).nullable(), source: z.literal("player_season_shot_events") }).strict().superRefine((value, ctx) => {
  const coords = [value.goalMouthY, value.goalMouthZ];
  if (value.endpointAvailable && (coords.some((item) => item === null) || value.endpointReason !== null)) ctx.addIssue({ code: "custom", message: "available endpoint is inconsistent" });
  if (!value.endpointAvailable && (coords.some((item) => item !== null) || value.endpointReason === null)) ctx.addIssue({ code: "custom", message: "unavailable endpoint is inconsistent" });
});
const context = z.object({ playerId: z.number().int().positive().safe(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scope.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable(), depthBand: z.literal("front2") }).strict().superRefine((value, ctx) => {
  if (value.mode === "league" && (value.scope === null || value.competition !== null)) ctx.addIssue({ code: "custom", message: "league context is inconsistent" });
  if (value.mode === "europe" && (value.scope !== null || value.competition === null)) ctx.addIssue({ code: "custom", message: "Europe context is inconsistent" });
});
const coverage = z.object({ zoneId: zoneId.nullable(), shotId: z.string().min(1).nullable(), field: z.enum(["volume", "conversionRatePct", "qualityScore", "goalMouthEndpoint"]), reason: z.string().min(1) }).strict().superRefine((value, ctx) => { if (value.zoneId === null && value.shotId === null) ctx.addIssue({ code: "custom", message: "coverage needs a target" }); });
const data = z.object({ available: z.boolean(), completeness: z.enum(["complete", "partial", "unavailable"]), reason: z.string().min(1).nullable(), gridVersion: z.literal("positional-6x5-v1"), attackDirection: z.literal("left_to_right"), includedDepths: z.tuple([z.literal(5), z.literal(6)]), qualityScale: z.object({ min: z.literal(-0.5), neutral: z.literal(0), max: z.literal(0.5), version: z.literal("final-third-quality-v1") }).strict(), markerSizeScale: z.object({ min: z.literal(0), max: z.literal(1), version: z.literal("xg-natural-0-to-1-v1") }).strict(), goalMouthCoordinates: z.object({ version: z.literal("goal-mouth-v1"), unit: z.literal("normalized"), horizontalMin: z.literal(0), horizontalMax: z.literal(1), verticalMin: z.literal(0), verticalMax: z.literal(1), origin: z.literal("bottom_left_shooter_view"), horizontalDirection: z.literal("shooter_left_to_right"), verticalDirection: z.literal("ground_to_crossbar") }).strict(), zones: z.array(zone).length(10), shots: z.array(shot), endpointUnavailableCount: z.number().int().nonnegative(), endpointUnavailableShotIds: z.array(z.string().min(1)), partialCoverage: z.array(coverage) }).strict().superRefine((value, ctx) => {
  if (value.zones.map((item) => item.zoneId).join("|") !== finalThirdZoneIds.join("|")) ctx.addIssue({ code: "custom", message: "zone order is invalid" });
  const unavailableIds = value.shots.filter((item) => !item.endpointAvailable).map((item) => item.shotId);
  if (value.endpointUnavailableCount !== unavailableIds.length || value.endpointUnavailableShotIds.join("|") !== unavailableIds.join("|")) ctx.addIssue({ code: "custom", message: "endpoint unavailable list is inconsistent" });
  if (!value.available && value.completeness !== "unavailable") ctx.addIssue({ code: "custom", message: "unavailable data must say unavailable" });
  if (value.available && value.completeness === "unavailable") ctx.addIssue({ code: "custom", message: "available data cannot say unavailable" });
});

export const finalThirdShotMapEnvelopeSchema = z.object({ schemaVersion: z.literal("1.0.0"), chartTaxonomyVersion: z.literal("final-third-shot-map-v1"), context, data }).strict();
export type FinalThirdShotMapEnvelope = z.infer<typeof finalThirdShotMapEnvelopeSchema>;
export type FinalThirdShotMapData = FinalThirdShotMapEnvelope["data"];
export type FinalThirdZone = FinalThirdShotMapData["zones"][number];
export type FinalThirdShot = FinalThirdShotMapData["shots"][number];
