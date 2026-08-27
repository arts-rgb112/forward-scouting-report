import type { GoalMouthBaselineEnvelope } from "../../api/goalMouthBaselineContracts";

const cells = Array.from({ length: 50 }, (_, index) => {
  const row = Math.floor(index / 10) + 1, column = index % 10 + 1;
  const shots = row === 5 && column === 1 ? 212 : 200;
  const goals = row === 5 && column === 1 ? 131 : row === 3 && column === 5 ? 28 : 40;
  return { cellId: `row${row}_column${column}`, row, column, yMin: (column - 1) / 10, yMax: column / 10, zMin: (row - 1) / 5, zMax: row / 5, shots, goals, goalRatePct: 100 * goals / shots, state: "observed" as const, lowSample: false, confidenceIntervalPct: { level: 95 as const, method: "wilson-score-v1" as const, lower: 10, upper: 70 }, reason: null };
});
export const goalMouthBaselineFixture: GoalMouthBaselineEnvelope = {
  schemaVersion: "1.0.0", baselineTaxonomyVersion: "goal-mouth-baseline-v1",
  data: { available: true, reason: null, grid: { columns: 10, rows: 5, coordinateVersion: "goal-mouth-v1", origin: "bottom_left_shooter_view", horizontalDirection: "shooter_left_to_right", verticalDirection: "ground_to_crossbar" }, minimumCellSample: 150, provenance: { sourceSeasons: ["2021/2022", "2022/2023", "2023/2024", "2024/2025", "2025/2026"], source: "static_shotmap_snapshots", transformVersion: "goal-mouth-baseline-v1", formulaVersion: "goals-divided-by-shots-goal-mouth-baseline-v1", eligibilityRule: "endpoint-available-finite-normalized-goal-mouth-y-and-z-inclusive-0-to-1", totalShots: cells.reduce((total, cell) => total + cell.shots, 0), totalGoals: cells.reduce((total, cell) => total + cell.goals, 0) }, cells, placementSummary: null, hexFrequency: null },
};
export const goalMouthBaselineLowSampleFixture: GoalMouthBaselineEnvelope = { ...goalMouthBaselineFixture, data: { ...goalMouthBaselineFixture.data, cells: goalMouthBaselineFixture.data.cells.map((cell, index) => index === 0 ? { ...cell, shots: 12, goals: 4, goalRatePct: 100 * 4 / 12, state: "low_sample" as const, lowSample: true, reason: "insufficient_baseline_sample", confidenceIntervalPct: { level: 95, method: "wilson-score-v1", lower: 12, upper: 65 } } : cell) } };
export const goalMouthBaselinePlayerFixture: GoalMouthBaselineEnvelope = { ...goalMouthBaselineFixture, data: { ...goalMouthBaselineFixture.data, placementSummary: { onFrameShots: 67, placementExpectedGoals: 23.5508, actualGoals: 36, delta: 12.4492, excludesPenalties: false }, hexFrequency: { definitionVersion: "hex-r2-crop-v2", excludesPenalties: true, cells: [{ hexId: "hex_p00_m00", cx: 68.6048, cy: 47.7941, shots: 2 }, { hexId: "hex_p01_p00", cx: 71.4619, cy: 52.2059, shots: 6 }], outOfCropShots: 1 } } };
