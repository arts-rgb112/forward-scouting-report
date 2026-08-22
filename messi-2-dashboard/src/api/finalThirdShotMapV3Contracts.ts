import { z } from "zod";
import { finalThirdContextSchema } from "./finalThirdShotMapContracts";
import { finalThirdShotMapV2EnvelopeSchema, type FinalThirdShotMapV2Data } from "./finalThirdShotMapV2Contracts";

const shootingQuality = z.object({
  totalShotCount: z.number().int().nonnegative().nullable(),
  eligibleShotCount: z.number().int().nonnegative().nullable(),
  xgTotal: z.number().finite().nullable(),
  xgotTotal: z.number().finite().nullable(),
  xgotMinusXg: z.number().finite().nullable(),
  state: z.enum(["observed", "partial", "unavailable"]),
  reason: z.string().min(1).nullable(),
  source: z.literal("player_season_shot_events").nullable(),
  formulaVersion: z.literal("sum-xgot-minus-sum-xg-v1"),
}).strict().superRefine((value, ctx) => {
  if (value.state === "unavailable" && [value.totalShotCount, value.eligibleShotCount, value.xgTotal, value.xgotTotal, value.xgotMinusXg].some((item) => item !== null)) ctx.addIssue({ code: "custom", message: "unavailable shooting quality must not contain numeric values" });
  if (value.state !== "unavailable" && value.xgotMinusXg === null) ctx.addIssue({ code: "custom", path: ["xgotMinusXg"], message: "observed or partial shooting quality requires xgotMinusXg" });
  if (value.state === "observed" && (value.reason !== null || value.source === null)) ctx.addIssue({ code: "custom", message: "observed shooting quality must have source and no reason" });
  if (value.state === "partial" && value.reason === null) ctx.addIssue({ code: "custom", path: ["reason"], message: "partial shooting quality requires a reason" });
});

const data = finalThirdShotMapV2EnvelopeSchema.shape.data.extend({ shootingQuality });

export const finalThirdShotMapV3EnvelopeSchema = z.object({
  schemaVersion: z.literal("3.0.0"),
  chartTaxonomyVersion: z.literal("final-third-shot-map-goal-mouth-v3"),
  context: finalThirdContextSchema,
  data,
}).strict();

export type FinalThirdShotMapV3Envelope = z.infer<typeof finalThirdShotMapV3EnvelopeSchema>;
export type FinalThirdShotMapV3Data = FinalThirdShotMapV3Envelope["data"];
export type FinalThirdRenderableDataV3 = FinalThirdShotMapV2Data & { shootingQuality: FinalThirdShotMapV3Data["shootingQuality"] };
