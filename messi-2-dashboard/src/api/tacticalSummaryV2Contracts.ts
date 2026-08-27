import { z } from "zod";

const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const sourceContext = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("league"), scope, competition: z.null() }).strict(),
  z.object({ mode: z.literal("europe"), scope: z.null(), competition: z.enum(["all", "ucl", "uel", "uecl"]) }).strict(),
]);
const cohortState = z.enum(["observed", "low_sample", "unavailable"]);
const relativeDirection = z.enum(["above_median", "below_median", "at_median", "unavailable"]);
const reason = z.enum([
  "position_label_not_player_role",
  "position_population_below_minimum",
  "subject_valid_coordinates_below_minimum",
  "tactical_range_source_unavailable",
]);
const exclusionReason = z.enum(["static_session_unavailable", "metric_value_missing", "insufficient_valid_coordinates"]);

const cohortKey = z.object({
  season: z.string().regex(/^\d{4}\/\d{4}$/),
  mode: z.enum(["league", "europe"]),
  scope: scope.nullable(),
  competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable(),
  rawPosition: z.string().min(1),
  positionKey: z.string().min(1),
}).strict();

const provenance = z.object({
  source: z.enum(["tactical_ratio_static", "unavailable"]),
  coordinateSystem: z.literal("normalized_pitch_0_100").nullable(),
  measure: z.enum(["coordinate_distribution_range", "spatial_ratio", "continuous_core_area"]),
  framePopulation: z.number().int().nonnegative(),
  eligiblePopulation: z.number().int().nonnegative(),
  excludedPopulation: z.number().int().nonnegative(),
  exclusionReasonCounts: z.record(z.string(), z.number().int().positive()).superRefine((counts, ctx) => {
    for (const key of Object.keys(counts)) if (!exclusionReason.safeParse(key).success) ctx.addIssue({ code: "custom", message: "unknown exclusion reason" });
  }),
  minimumBaselineCoordinateCount: z.number().int().positive().nullable().optional(),
  subjectValidCoordinateCount: z.number().int().nonnegative().nullable().optional(),
  subjectLowSample: z.boolean().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.eligiblePopulation + value.excludedPopulation !== value.framePopulation) {
    ctx.addIssue({ code: "custom", path: ["eligiblePopulation"], message: "metric eligibility must reconcile to the frame" });
  }
  if (Object.values(value.exclusionReasonCounts).reduce((total, count) => total + count, 0) !== value.excludedPopulation) {
    ctx.addIssue({ code: "custom", path: ["exclusionReasonCounts"], message: "exclusions must reconcile to the frame" });
  }
});

const readout = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.number().finite().nullable(),
  baselineMedian: z.number().finite().nullable(),
  delta: z.number().finite().nullable(),
  percentileScore: z.number().finite().min(0).max(50).nullable(),
  population: z.number().int().nonnegative(),
  cohortState,
  reason: reason.nullable(),
  relativeDirection,
  formulaVersion: z.string().min(1),
  provenance,
}).strict().superRefine((value, ctx) => {
  const numeric = [value.value, value.baselineMedian, value.delta, value.percentileScore];
  if (value.cohortState === "unavailable") {
    if (numeric.some((item) => item !== null) || value.relativeDirection !== "unavailable" || value.reason === null) {
      ctx.addIssue({ code: "custom", message: "unavailable readouts must not fabricate comparison values" });
    }
  } else if (numeric.some((item) => item === null) || value.relativeDirection === "unavailable") {
    ctx.addIssue({ code: "custom", message: "available readouts require server numeric values" });
  }
  if (value.cohortState === "observed" && (value.population < 20 || value.reason !== null)) {
    ctx.addIssue({ code: "custom", message: "observed readouts require population >=20 and no reason" });
  }
  if (value.cohortState === "low_sample") {
    const positionPopulationLowSample = value.reason === "position_population_below_minimum" && value.population < 20;
    const subjectCoordinateLowSample = value.reason === "subject_valid_coordinates_below_minimum";
    if (!positionPopulationLowSample && !subjectCoordinateLowSample) {
      ctx.addIssue({ code: "custom", message: "low-sample readouts require a population or subject-coordinate reason" });
    }
  }
  if (value.population !== value.provenance.eligiblePopulation) {
    ctx.addIssue({ code: "custom", path: ["population"], message: "population must match metric eligibility" });
  }
});

const continuousCore = z.object({
  available: z.literal(true), targetDensityPct: z.number().finite(), achievedDensityPct: z.number().finite(), coreAreaPct: z.number().finite(),
  densityThreshold: z.number().finite(), thresholdOfPeak: z.number().finite(), gridColumns: z.number().int().positive(), gridRows: z.number().int().positive(),
  definitionVersion: z.literal("fixed-n60-r20-v2"), formulaVersion: z.literal("fixed-n60-r20-v2"), ccaAreaPct: z.number().finite(),
  standardizedTarget: z.number().finite(), quantizationDelta: z.number().finite().nonnegative(), containedMassPct: z.number().finite(), validPointCount: z.number().int().nonnegative(), lowSample: z.boolean(),
}).strict();

export const tacticalSummaryV2EnvelopeSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  tacticalSummaryVersion: z.literal("tactical-summary-v2"),
  data: z.object({
    playerId: z.number().int().positive(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^\d{4}\/\d{4}$/), sourceContext,
    formulaVersion: z.literal("tactical-summary-v2"), disclosure: z.literal("활동 폭은 위치 분포의 범위이며 이동 거리가 아닙니다."),
    cohortKey, cohortPopulation: z.number().int().nonnegative(), lowSample: z.boolean(), positioning: readout, movement: z.array(readout).max(2),
    activityCore: readout, continuousCoreProvenance: continuousCore.nullable(),
    activityRange: z.object({ frontBackActivityRange: readout, leftRightActivityRange: readout, roleLabel: z.enum(["전방위 활동형", "종적 왕복형", "횡적 조율형", "고정 위치형", "unavailable"]), formulaVersion: z.literal("coordinate-range-quadrant-v1") }).strict(),
  }).strict().superRefine((data, ctx) => {
    if (data.season !== data.cohortKey.season || data.sourceContext.mode !== data.cohortKey.mode || data.sourceContext.scope !== data.cohortKey.scope || data.sourceContext.competition !== data.cohortKey.competition) {
      ctx.addIssue({ code: "custom", path: ["cohortKey"], message: "cohort context must exactly echo the selected context" });
    }
    const activityState = data.activityRange.frontBackActivityRange.cohortState;
    const expectedLowSample = activityState === "unavailable" ? data.cohortPopulation < 20 : activityState === "low_sample";
    if (data.lowSample !== expectedLowSample) {
      ctx.addIssue({ code: "custom", path: ["lowSample"], message: "lowSample must reflect the front-back activity readout" });
    }
    if (data.activityCore.cohortState === "unavailable" && data.continuousCoreProvenance !== null) {
      ctx.addIssue({ code: "custom", path: ["continuousCoreProvenance"], message: "unavailable CCA cannot include a provenance value" });
    }
    if (data.continuousCoreProvenance !== null && data.activityCore.value !== data.continuousCoreProvenance.ccaAreaPct) {
      ctx.addIssue({ code: "custom", path: ["activityCore"], message: "CCA readout must match continuous-core provenance" });
    }
  }),
}).strict();

export type TacticalSummaryV2 = z.infer<typeof tacticalSummaryV2EnvelopeSchema>["data"];
export type TacticalSummaryV2Readout = z.infer<typeof readout>;
