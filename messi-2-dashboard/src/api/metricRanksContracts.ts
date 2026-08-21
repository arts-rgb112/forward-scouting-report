import { z } from "zod";

const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const rank = z.object({ rank: z.number().int().positive().nullable(), population: z.number().int().nonnegative() }).strict().superRefine((value, ctx) => {
  if (value.rank !== null && value.rank > value.population) ctx.addIssue({ code: "custom", message: "rank cannot exceed population" });
});
const duelMetrics = z.object({
  outsideShot: rank, boxThreat: rank, dangerZone: rank, combinedDuel: rank, spaceControl: rank, forwardPress: rank,
}).strict();
export const metricRanksContextSchema = z.discriminatedUnion("mode", [
  z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.literal("league"), scope, competition: z.literal("all") }).strict(),
  z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.literal("europe"), scope: z.null(), competition: z.enum(["all", "ucl", "uel", "uecl"]) }).strict(),
]);

// The deployed endpoint accepts an entries-only body.  `schemaVersion` belongs
// exclusively to the response and legacy taxonomy is intentionally unsupported.
export const metricRanksRequestEntrySchema = z.object({
  key: z.string().min(1).max(500),
  player: z.object({ idNamespace: z.literal("fotmob"), playerId: z.number().int().positive().safe() }).strict(),
  metricTaxonomyVersion: z.literal("duel-press-v1"),
  context: metricRanksContextSchema,
}).strict();
export const metricRanksRequestSchema = z.object({ entries: z.array(metricRanksRequestEntrySchema).min(1).max(50) }).strict().superRefine((value, ctx) => {
  const keys = value.entries.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["entries"], message: "entry keys must be unique" });
});

const responseResult = metricRanksRequestEntrySchema.extend({
  status: z.enum(["resolved", "unavailable", "invalid_context"]),
  metrics: duelMetrics.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "resolved" && value.metrics === null) ctx.addIssue({ code: "custom", path: ["metrics"], message: "resolved requires metrics" });
  if (value.status !== "resolved" && value.metrics !== null) ctx.addIssue({ code: "custom", path: ["metrics"], message: "unavailable result requires null metrics" });
});
export const metricRanksResponseSchema = z.object({ schemaVersion: z.literal("1.0.0"), results: z.array(responseResult).min(1).max(50) }).strict();
export type MetricRanksRequest = z.infer<typeof metricRanksRequestSchema>;
export type MetricRanksRequestEntry = z.infer<typeof metricRanksRequestEntrySchema>;
export type MetricRanksResponse = z.infer<typeof metricRanksResponseSchema>;
export type MetricRanksResult = z.infer<typeof responseResult>;
