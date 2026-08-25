import { z } from "zod";

const finite = z.number().finite();
const cellState = z.enum(["observed", "low_sample", "unavailable"]);
const confidenceInterval = z.object({ level: z.literal(95), method: z.literal("wilson-score-v1"), lower: finite.min(0).max(100), upper: finite.min(0).max(100) }).strict().superRefine((value, ctx) => {
  if (value.lower > value.upper) ctx.addIssue({ code: "custom", message: "confidence interval bounds are reversed" });
});
const cell = z.object({
  cellId: z.string().regex(/^row[1-5]_column(?:10|[1-9])$/), column: z.number().int().min(1).max(10), row: z.number().int().min(1).max(5),
  yMin: finite.min(0).max(1), yMax: finite.min(0).max(1), zMin: finite.min(0).max(1), zMax: finite.min(0).max(1),
  shots: z.number().int().nonnegative().nullable(), goals: z.number().int().nonnegative().nullable(), goalRatePct: finite.min(0).max(100).nullable(),
  state: cellState, lowSample: z.boolean(), confidenceIntervalPct: confidenceInterval.nullable(), reason: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.cellId !== `row${value.row}_column${value.column}` || value.yMin !== (value.column - 1) / 10 || value.yMax !== value.column / 10 || value.zMin !== (value.row - 1) / 5 || value.zMax !== value.row / 5) ctx.addIssue({ code: "custom", message: "cell geometry is not the canonical server grid" });
  if (value.state === "unavailable") {
    if (value.lowSample || value.reason === null || [value.shots, value.goals, value.goalRatePct, value.confidenceIntervalPct].some((item) => item !== null)) ctx.addIssue({ code: "custom", message: "unavailable cell must retain only its reason" });
    return;
  }
  if (value.shots === null || value.goals === null || value.goals > value.shots) ctx.addIssue({ code: "custom", message: "sampled cell count is invalid" });
  if (value.state === "observed" && (value.lowSample || value.reason !== null || value.shots === null || value.shots < 150)) ctx.addIssue({ code: "custom", message: "observed cell state is invalid" });
  if (value.state === "low_sample" && (!value.lowSample || value.reason !== "insufficient_baseline_sample" || value.shots === null || value.shots >= 150)) ctx.addIssue({ code: "custom", message: "low sample state is invalid" });
  if (value.shots === 0 && (value.goalRatePct !== null || value.confidenceIntervalPct !== null)) ctx.addIssue({ code: "custom", message: "zero attempts do not have rate or confidence interval" });
  if (value.shots !== null && value.shots > 0 && (value.goalRatePct === null || value.confidenceIntervalPct === null)) ctx.addIssue({ code: "custom", message: "positive sample requires server rate and interval" });
});
const grid = z.object({ columns: z.literal(10), rows: z.literal(5), coordinateVersion: z.literal("goal-mouth-v1"), origin: z.literal("bottom_left_shooter_view"), horizontalDirection: z.literal("shooter_left_to_right"), verticalDirection: z.literal("ground_to_crossbar") }).strict();
const provenance = z.object({ sourceSeasons: z.tuple([z.literal("2021/2022"), z.literal("2022/2023"), z.literal("2023/2024"), z.literal("2024/2025"), z.literal("2025/2026")]), source: z.literal("static_shotmap_snapshots"), transformVersion: z.literal("goal-mouth-baseline-v1"), formulaVersion: z.literal("goals-divided-by-shots-goal-mouth-baseline-v1"), eligibilityRule: z.literal("endpoint-available-finite-normalized-goal-mouth-y-and-z-inclusive-0-to-1"), totalShots: z.number().int().nonnegative().nullable(), totalGoals: z.number().int().nonnegative().nullable() }).strict();

export const goalMouthBaselineEnvelopeSchema = z.object({ schemaVersion: z.literal("1.0.0"), baselineTaxonomyVersion: z.literal("goal-mouth-baseline-v1"), data: z.object({ available: z.boolean(), reason: z.string().min(1).nullable(), grid, minimumCellSample: z.literal(150), provenance, cells: z.array(cell).length(50) }).strict() }).strict().superRefine((value, ctx) => {
  const expected = Array.from({ length: 50 }, (_, index) => `row${Math.floor(index / 10) + 1}_column${index % 10 + 1}`);
  if (value.data.cells.map((item) => item.cellId).join("|") !== expected.join("|")) ctx.addIssue({ code: "custom", message: "baseline cells are not in canonical row-major order" });
  if (value.data.available) {
    if (value.data.reason !== null || value.data.provenance.totalShots === null || value.data.provenance.totalGoals === null || value.data.cells.some((item) => item.state === "unavailable")) ctx.addIssue({ code: "custom", message: "available baseline is inconsistent" });
  } else if (value.data.reason !== "required_static_snapshot_missing" || value.data.provenance.totalShots !== null || value.data.provenance.totalGoals !== null || value.data.cells.some((item) => item.state !== "unavailable" || item.reason !== value.data.reason)) ctx.addIssue({ code: "custom", message: "unavailable baseline is inconsistent" });
});

export type GoalMouthBaselineEnvelope = z.infer<typeof goalMouthBaselineEnvelopeSchema>;
export type GoalMouthBaselineData = GoalMouthBaselineEnvelope["data"];
export type GoalMouthBaselineCell = GoalMouthBaselineData["cells"][number];
