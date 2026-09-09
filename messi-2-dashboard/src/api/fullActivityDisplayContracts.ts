import { z } from "zod";
import { fullActivityHeatmapEnvelopeSchema } from "./fullActivityHeatmapContracts";
import { nativeBoxContext } from "./nativeBodyPartContracts";

/**
 * Strict decoder for the display-only `full-activity-display-v1` endpoint.
 * Its heat grid is the existing 32x22 full-activity object; CCA fields are
 * server-owned readouts from that same raw-source revision, never browser
 * calculations or score/static CCA substitutions.
 */
const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
const percentage = z.number().finite().min(0).max(100);
const sourceKey = z.string().regex(/^[1-9]\d*:[1-9]\d*:[1-9]\d*$/);

// The old full-activity decoder already owns this exact public 32x22 shape.
// Reuse it unchanged so both endpoints reject the same malformed heat grid.
export const fullActivityDisplayHeatmapSchema = fullActivityHeatmapEnvelopeSchema.shape.data;

const coverageSchema = z.object({
  expectedKeys: z.array(sourceKey),
  observedKeys: z.array(sourceKey),
  missingKeys: z.array(sourceKey),
}).strict().superRefine((value, ctx) => {
  const groups = [value.expectedKeys, value.observedKeys, value.missingKeys];
  if (groups.some((group) => JSON.stringify(group) !== JSON.stringify([...new Set(group)].sort()))) {
    ctx.addIssue({ code: "custom", message: "full-source coverage keys must be sorted and unique" });
    return;
  }
  const expected = new Set(value.expectedKeys);
  const observed = new Set(value.observedKeys);
  const missing = new Set(value.missingKeys);
  if ([...observed].some((key) => missing.has(key)) || observed.size + missing.size !== expected.size || [...expected].some((key) => !observed.has(key) && !missing.has(key)))
    ctx.addIssue({ code: "custom", message: "full-source coverage must partition the selected mappings" });
});

export const fullSourceCcaSchema = z.object({
  available: z.boolean(),
  reason: z.string().min(1).nullable(),
  definitionVersion: z.literal("full-source-continuous-core-v1"),
  formulaVersion: z.literal("fixed-n60-r20-v2"),
  inputDefinition: z.literal("sportsapi-data-points-count-expanded-v1"),
  heatmapDefinition: z.literal("full-tier3-count-weighted-histogram-32x22-v1"),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  coverage: coverageSchema,
  gridColumns: z.literal(32),
  gridRows: z.literal(22),
  validPointCount: count,
  standardizedTarget: percentage.nullable(),
  // This is the raw continuous-core density cutoff. `thresholdOfPeak` is
  // the separately normalized 0..1 value supplied by the server.
  densityThreshold: amount.nullable(),
  thresholdOfPeak: z.number().finite().min(0).max(1).nullable(),
  coreAreaPct: percentage.nullable(),
  ccaAreaPct: percentage.nullable(),
  containedMassPct: percentage.nullable(),
  lowSample: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const measures = [value.standardizedTarget, value.densityThreshold, value.thresholdOfPeak, value.coreAreaPct, value.ccaAreaPct, value.containedMassPct];
  if (value.available) {
    if (value.reason !== null || value.sourceRevision === null || value.coverage.missingKeys.length !== 0 || value.validPointCount < 1 || measures.some((measure) => measure === null) || value.ccaAreaPct !== value.coreAreaPct)
      ctx.addIssue({ code: "custom", message: "available full-source CCA requires one complete raw-source display revision" });
    return;
  }
  if (value.reason === null || value.validPointCount !== 0 || measures.some((measure) => measure !== null))
    ctx.addIssue({ code: "custom", message: "unavailable full-source CCA must fail closed" });
});

export const fullActivityDisplayEnvelopeSchema = z.object({
  schemaVersion: z.literal("full-activity-display-v1"),
  context: nativeBoxContext,
  fullHeat: fullActivityDisplayHeatmapSchema,
  fullSourceCca: fullSourceCcaSchema,
}).strict().superRefine((value, ctx) => {
  if (value.fullSourceCca.available && !value.fullHeat.available)
    ctx.addIssue({ code: "custom", path: ["fullSourceCca"], message: "available display CCA requires its full activity grid" });
  if (value.fullSourceCca.available && value.fullSourceCca.validPointCount !== value.fullHeat.validPointCount)
    ctx.addIssue({ code: "custom", path: ["fullSourceCca", "validPointCount"], message: "display CCA count contradicts the same full activity grid" });
});

export type FullActivityDisplayEnvelope = z.infer<typeof fullActivityDisplayEnvelopeSchema>;
export type FullActivityDisplayHeatmap = z.infer<typeof fullActivityDisplayHeatmapSchema>;
export type FullSourceCca = z.infer<typeof fullSourceCcaSchema>;
