import { z } from "zod";

export const volumeBenchmarkAxisIds = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"] as const;
const score = z.number().finite().min(0).max(100);
const axis = (id: typeof volumeBenchmarkAxisIds[number]) => z.object({ id: z.literal(id), label: z.string().min(1), playerScore: score, averageScore: score, playerRawValue: z.number().finite().nullable(), averageRawValue: z.number().finite().nullable(), playerRank: z.number().int().positive().nullable(), population: z.number().int().positive(), tier: z.enum(["S", "A", "B", "C", "D"]), imputed: z.boolean() }).strict().superRefine((value, ctx) => { if (value.playerRank !== null && value.playerRank > value.population) ctx.addIssue({ code: "custom", path: ["playerRank"], message: "rank must not exceed population" }); });
const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const contextSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("league"), scope, competition: z.null() }).strict(),
  z.object({ mode: z.literal("europe"), scope: z.null(), competition: z.enum(["ucl", "uel", "uecl"]) }).strict(),
]);
const benchmarkSchema = z.object({ label: z.literal("8-league avg"), mode: z.literal("league"), scope: z.literal(8) }).strict();
const identity = { playerId: z.number().int().positive(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^\d{4}\/\d{4}$/) };
const completeData = z.object({ ...identity, sourceContext: contextSchema, benchmark: benchmarkSchema, available: z.literal(true), reason: z.enum(["complete", "partial_source_imputed"]), axes: z.tuple(volumeBenchmarkAxisIds.map((id) => axis(id)) as [ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>, ReturnType<typeof axis>]) }).strict();
const unavailableData = z.object({ ...identity, sourceContext: contextSchema, benchmark: benchmarkSchema, available: z.literal(false), reason: z.literal("benchmark_source_unavailable"), axes: z.tuple([]) }).strict();
export const volumeBenchmarkEnvelopeSchema = z.object({ schemaVersion: z.literal("1.0.0"), data: z.discriminatedUnion("available", [completeData, unavailableData]) }).strict();
export type VolumeBenchmark = z.infer<typeof volumeBenchmarkEnvelopeSchema>["data"];
export type VolumeBenchmarkAxis = Extract<VolumeBenchmark, { available: true }>["axes"][number];
