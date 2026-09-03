import { z } from "zod";

const context = z.object({
  playerId: z.number().int().positive(), idNamespace: z.literal("fotmob"),
  season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]),
  scope: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]).nullable(),
  competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.mode === "league" ? value.scope === null || value.competition !== null : value.scope !== null || value.competition === null) ctx.addIssue({ code: "custom", message: "heatmap context dimensions are inconsistent" });
});

const data = z.object({
  available: z.boolean(), reason: z.string().min(1).nullable(),
  definitionVersion: z.literal("full-tier3-count-weighted-histogram-32x22-v1"),
  columns: z.literal(32), rows: z.literal(22),
  cellCounts: z.array(z.number().int().nonnegative()).length(704),
  validPointCount: z.number().int().nonnegative(),
  activitySnapshotCount: z.number().int().nonnegative(),
  sourceDefinitionVersion: z.literal("sportsapi-heatmap-points-count-weighted-full-v1"),
}).strict().superRefine((value, ctx) => {
  const sum = value.cellCounts.reduce((total, count) => total + count, 0);
  if (value.available) {
    if (value.reason !== null || sum !== value.validPointCount || value.activitySnapshotCount < 1) ctx.addIssue({ code: "custom", message: "available heatmap is inconsistent" });
  } else if (value.reason === null || sum !== 0 || value.validPointCount !== 0 || value.activitySnapshotCount !== 0) ctx.addIssue({ code: "custom", message: "unavailable heatmap is inconsistent" });
});

export const fullActivityHeatmapEnvelopeSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  heatmapTaxonomyVersion: z.literal("full-activity-heatmap-v1"),
  context,
  data,
}).strict();

export type FullActivityHeatmapEnvelope = z.infer<typeof fullActivityHeatmapEnvelopeSchema>;
export type FullActivityHeatmapData = FullActivityHeatmapEnvelope["data"];
