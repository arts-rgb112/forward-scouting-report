import { z } from "zod";

export const ratioBenchmarkAxisIds = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"] as const;
const score = z.number().finite().min(0).max(100);
const axis = (id: typeof ratioBenchmarkAxisIds[number]) => z.object({
  id: z.literal(id), label: z.string().min(1), playerScore: score, averageScore: score,
  playerRawValue: z.number().finite().nullable(), averageRawValue: z.number().finite().nullable(),
  playerRank: z.number().int().positive().nullable(), population: z.number().int().nonnegative(), tier: z.enum(["S", "A", "B", "C", "D"]), imputed: z.boolean(),
}).strict().superRefine((value, ctx) => { if (value.playerRank !== null && value.playerRank > value.population) ctx.addIssue({ code: "custom", path: ["playerRank"], message: "rank must not exceed population" }); });
const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const sourceContext = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("league"), scope, competition: z.null() }).strict(),
  z.object({ mode: z.literal("europe"), scope: z.null(), competition: z.enum(["all", "ucl", "uel", "uecl"]) }).strict(),
]);
const benchmark = z.object({ label: z.literal("8-league avg"), mode: z.literal("league"), scope: z.literal(8), kind: z.literal("ratio") }).strict();
const identity = { playerId: z.number().int().positive(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^\d{4}\/\d{4}$/) };
const available = z.object({
  ...identity, sourceContext, benchmark, available: z.literal(true), reason: z.enum(["complete", "partial_source_imputed"]),
  axes: z.tuple(ratioBenchmarkAxisIds.map((id) => axis(id)) as [ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>]),
}).strict();
const unavailable = z.object({ ...identity, sourceContext, benchmark, available: z.literal(false), reason: z.literal("benchmark_source_unavailable"), axes: z.tuple([]) }).strict();

export const ratioBenchmarkEnvelopeSchema = z.object({ schemaVersion: z.literal("1.0.0"), data: z.discriminatedUnion("available", [available, unavailable]) }).strict();
export type RatioBenchmark = z.infer<typeof ratioBenchmarkEnvelopeSchema>["data"];
export type RatioBenchmarkAxis = Extract<RatioBenchmark, { available: true }> ["axes"][number];
