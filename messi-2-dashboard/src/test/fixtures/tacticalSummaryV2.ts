type State = "observed" | "low_sample" | "unavailable";
type Direction = "above_median" | "below_median" | "at_median" | "unavailable";

const readout = (id: string, state: State = "observed", direction: Direction = "above_median", overrides: Record<string, unknown> = {}) => {
  const unavailable = state === "unavailable";
  const lowCoordinates = overrides.reason === "subject_valid_coordinates_below_minimum";
  const population = state === "low_sample" && !lowCoordinates ? 7 : unavailable ? 0 : 284;
  const core = id === "coreArea";
  return {
    id, label: id, value: unavailable ? null : core ? 14.4886 : direction === "below_median" ? 21.3076 : 22.6447, baselineMedian: unavailable ? null : core ? 12 : direction === "below_median" ? 22.8373 : 18.2692,
    delta: unavailable ? null : core ? 2.4886 : direction === "below_median" ? -1.5297 : 4.3755, percentileScore: unavailable ? null : direction === "below_median" ? 35 : 2,
    population, cohortState: state, reason: unavailable ? "position_label_not_player_role" : state === "low_sample" ? (overrides.reason ?? "position_population_below_minimum") : null,
    relativeDirection: unavailable ? "unavailable" : direction, formulaVersion: id === "coreArea" ? "fixed-n60-r20-v2" : "coordinate-standard-deviation-v1",
    provenance: { source: unavailable ? "unavailable" : "tactical_ratio_static", coordinateSystem: unavailable ? null : "normalized_pitch_0_100", measure: id === "coreArea" ? "continuous_core_area" : "coordinate_distribution_range", framePopulation: population, eligiblePopulation: population, excludedPopulation: 0, exclusionReasonCounts: {}, minimumBaselineCoordinateCount: 60, subjectValidCoordinateCount: lowCoordinates ? 42 : 180, subjectLowSample: lowCoordinates },
    ...overrides,
  };
};

export function tacticalSummaryV2Fixture(state: State = "observed") {
  const unavailable = state === "unavailable";
  const front = readout("frontBackActivityRange", state);
  const side = readout("leftRightActivityRange", state, "below_median");
  return {
    schemaVersion: "1.0.0", tacticalSummaryVersion: "tactical-summary-v2",
    data: {
      playerId: 194165, idNamespace: "fotmob", season: "2025/2026", sourceContext: { mode: "league", scope: 7, competition: null }, formulaVersion: "tactical-summary-v2",
      disclosure: "활동 폭은 위치 분포의 범위이며 이동 거리가 아닙니다.", cohortKey: { season: "2025/2026", mode: "league", scope: 7, competition: null, rawPosition: unavailable ? "Coach" : "Striker", positionKey: unavailable ? "coach" : "striker" }, cohortPopulation: unavailable ? 0 : front.population, lowSample: state === "low_sample" || unavailable,
      positioning: readout("inBoxActivity", state), movement: [], activityCore: readout("coreArea", state), continuousCoreProvenance: unavailable ? null : { available: true, targetDensityPct: 50, achievedDensityPct: 42.8, coreAreaPct: 14.4886, densityThreshold: .5, thresholdOfPeak: .4, gridColumns: 32, gridRows: 22, definitionVersion: "fixed-n60-r20-v2", formulaVersion: "fixed-n60-r20-v2", ccaAreaPct: 14.4886, standardizedTarget: 14.3, quantizationDelta: .18, containedMassPct: 42.8, validPointCount: 180, lowSample: false },
      activityRange: { frontBackActivityRange: front, leftRightActivityRange: side, roleLabel: unavailable ? "unavailable" : "종적 왕복형", formulaVersion: "coordinate-range-quadrant-v1" },
    },
  };
}

export const tacticalSummaryV2SubjectCoordinateLowFixture = () => {
  const value = tacticalSummaryV2Fixture("observed");
  const target = value.data.activityRange.frontBackActivityRange;
  Object.assign(target, readout("frontBackActivityRange", "low_sample", "above_median", { reason: "subject_valid_coordinates_below_minimum" }));
  value.data.lowSample = true;
  return value;
};
