import { z } from "zod";

const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const sourceContext = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("league"), scope, competition: z.null() }).strict(),
  z.object({ mode: z.literal("europe"), scope: z.null(), competition: z.enum(["all", "ucl", "uel", "uecl"]) }).strict(),
]);
const lineIds = ["positioning", "movement", "activity"] as const;
const line = (id: typeof lineIds[number]) => z.object({ id: z.literal(id), text: z.string().min(1).max(280), imputed: z.boolean() }).strict();
const identity = { playerId: z.number().int().positive(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^\d{4}\/\d{4}$/) };
const available = z.object({
  ...identity, sourceContext, available: z.literal(true), reason: z.enum(["complete", "partial_source_imputed"]),
  lines: z.tuple(lineIds.map((id) => line(id)) as [ReturnType<typeof line>, ReturnType<typeof line>, ReturnType<typeof line>]),
}).strict().superRefine((value, ctx) => {
  const hasImputed = value.lines.some((item) => item.imputed);
  if (value.reason === "complete" && hasImputed) ctx.addIssue({ code: "custom", path: ["lines"], message: "complete summaries cannot contain imputed lines" });
  if (value.reason === "partial_source_imputed" && !hasImputed) ctx.addIssue({ code: "custom", path: ["lines"], message: "partial summaries require an imputed line" });
});
const unavailable = z.object({
  ...identity, sourceContext, available: z.literal(false), reason: z.literal("summary_source_unavailable"), lines: z.tuple([]),
}).strict();

export const tacticalSummaryEnvelopeSchema = z.object({ schemaVersion: z.literal("1.0.0"), data: z.discriminatedUnion("available", [available, unavailable]) }).strict();
export type TacticalSummary = z.infer<typeof tacticalSummaryEnvelopeSchema>["data"];
