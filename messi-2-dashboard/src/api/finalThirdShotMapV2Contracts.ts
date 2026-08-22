import { z } from "zod";
import {
  finalThirdContextSchema,
  finalThirdCoverageSchema,
  finalThirdFieldStateSchema,
  finalThirdShotSchema,
  finalThirdZoneIds,
  type FinalThirdShotMapData,
} from "./finalThirdShotMapContracts";

const finite = z.number().finite();
const zoneId = z.enum(finalThirdZoneIds);

const zone = z.object({
  zoneId,
  depth: z.union([z.literal(5), z.literal(6)]),
  lane: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  shotsTotal: z.number().int().nonnegative().nullable(),
  goals: z.number().int().nonnegative().nullable(),
  effectiveShotCount: z.number().int().nonnegative().nullable(),
  conversionRatePct: finite.min(0).max(100).nullable(),
  qualityScore: finite.nullable(),
  qualityEligibleShots: z.number().int().nonnegative().nullable(),
  state: z.enum(["observed", "partial", "unavailable"]),
  reason: z.string().min(1).nullable(),
  source: z.literal("player_season_shot_events").nullable(),
  qualityFormulaVersion: z.literal("avg-xgot-minus-avg-xg-v1"),
  fieldStates: z.object({
    volume: finalThirdFieldStateSchema,
    conversionRatePct: finalThirdFieldStateSchema,
    effectiveShotCount: finalThirdFieldStateSchema,
    qualityScore: finalThirdFieldStateSchema,
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.zoneId !== `depth${value.depth}_lane${value.lane}`) ctx.addIssue({ code: "custom", message: "zone identity is inconsistent" });
  if (value.shotsTotal === null && [value.goals, value.effectiveShotCount, value.conversionRatePct, value.qualityScore, value.qualityEligibleShots].some((item) => item !== null)) ctx.addIssue({ code: "custom", message: "unavailable zone contains metrics" });
  if (value.shotsTotal !== null && (value.goals === null || value.goals > value.shotsTotal)) ctx.addIssue({ code: "custom", message: "zone goal count is inconsistent" });
  if (value.shotsTotal !== null && value.effectiveShotCount !== null && value.effectiveShotCount > value.shotsTotal) ctx.addIssue({ code: "custom", message: "effective shot count exceeds zone volume" });
  if (value.shotsTotal !== null && value.effectiveShotCount !== null && value.goals !== null && value.effectiveShotCount < value.goals) ctx.addIssue({ code: "custom", message: "effective shot count omits goals" });
  if (value.shotsTotal !== null && value.shotsTotal > 0 && (value.effectiveShotCount === null || value.conversionRatePct === null)) ctx.addIssue({ code: "custom", message: "positive zone volume requires effective conversion" });
  if (value.shotsTotal !== null && value.shotsTotal > 0 && value.effectiveShotCount !== null && value.conversionRatePct !== null) {
    const expected = Math.round((value.effectiveShotCount / value.shotsTotal) * 100 * 100) / 100;
    if (value.conversionRatePct !== expected) ctx.addIssue({ code: "custom", message: "effective conversion rate is inconsistent" });
  }
  if (value.shotsTotal === 0 && (value.effectiveShotCount !== 0 || value.conversionRatePct !== null)) ctx.addIssue({ code: "custom", message: "observed zero must retain zero effective shots and null conversion" });
});

const qualityScale = z.object({ min: z.literal(-0.5), neutral: z.literal(0), max: z.literal(0.5), version: z.literal("final-third-quality-v1") }).strict();
const markerSizeScale = z.object({ min: z.literal(0), max: z.literal(1), version: z.literal("xg-natural-0-to-1-v1") }).strict();
const goalMouthCoordinates = z.object({ version: z.literal("goal-mouth-v1"), unit: z.literal("normalized"), horizontalMin: z.literal(0), horizontalMax: z.literal(1), verticalMin: z.literal(0), verticalMax: z.literal(1), origin: z.literal("bottom_left_shooter_view"), horizontalDirection: z.literal("shooter_left_to_right"), verticalDirection: z.literal("ground_to_crossbar") }).strict();

const data = z.object({
  available: z.boolean(),
  completeness: z.enum(["complete", "partial", "unavailable"]),
  reason: z.string().min(1).nullable(),
  conversionDefinition: z.literal("effective-on-target-plus-goal-divided-by-shots-v2"),
  gridVersion: z.literal("positional-6x5-v1"),
  attackDirection: z.literal("left_to_right"),
  includedDepths: z.tuple([z.literal(5), z.literal(6)]),
  qualityScale,
  markerSizeScale,
  goalMouthCoordinates,
  zones: z.array(zone).length(10),
  shots: z.array(finalThirdShotSchema),
  endpointUnavailableCount: z.number().int().nonnegative(),
  endpointUnavailableShotIds: z.array(z.string().min(1)),
  partialCoverage: z.array(finalThirdCoverageSchema),
}).strict().superRefine((value, ctx) => {
  if (value.zones.map((item) => item.zoneId).join("|") !== finalThirdZoneIds.join("|")) ctx.addIssue({ code: "custom", message: "zone order is invalid" });
  const unavailableIds = value.shots.filter((item) => !item.endpointAvailable).map((item) => item.shotId);
  if (value.endpointUnavailableCount !== unavailableIds.length || value.endpointUnavailableShotIds.join("|") !== unavailableIds.join("|")) ctx.addIssue({ code: "custom", message: "endpoint unavailable list is inconsistent" });
  if (!value.available && value.completeness !== "unavailable") ctx.addIssue({ code: "custom", message: "unavailable data must say unavailable" });
  if (value.available && value.completeness === "unavailable") ctx.addIssue({ code: "custom", message: "available data cannot say unavailable" });
});

export const finalThirdShotMapV2EnvelopeSchema = z.object({
  schemaVersion: z.literal("2.0.0"),
  chartTaxonomyVersion: z.literal("final-third-shot-map-effective-v2"),
  context: finalThirdContextSchema,
  data,
}).strict();

export type FinalThirdShotMapV2Envelope = z.infer<typeof finalThirdShotMapV2EnvelopeSchema>;
export type FinalThirdShotMapV2Data = FinalThirdShotMapV2Envelope["data"];
export type FinalThirdRenderableData = FinalThirdShotMapData | FinalThirdShotMapV2Data;
