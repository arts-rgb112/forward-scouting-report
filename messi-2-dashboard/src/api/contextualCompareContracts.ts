import { z } from "zod";

import { playerSummaryEnvelopeSchema } from "./contracts";
import type { DuelPressModeContext } from "./duelPressTypes";

const scope = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]);
const taxonomy = z.enum(["legacy-v1", "duel-press-v1"]);
const requestContext = z.discriminatedUnion("mode", [
  z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.literal("league"), scope, competition: z.literal("all") }).strict(),
  z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.literal("europe"), scope: z.null(), competition: z.enum(["all", "ucl", "uel", "uecl"]) }).strict(),
]);
const echoedContext = z.object({ season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scope.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict();
const identity = z.object({ idNamespace: z.literal("fotmob"), playerId: z.number().int().positive().safe() }).strict();

export const contextualCompareSideRequestSchema = z.object({ player: identity, taxonomy, context: requestContext }).strict();
export const contextualCompareRequestSchema = z.object({ comparisonVersion: z.literal("contextual-compare-v1"), left: contextualCompareSideRequestSchema, right: contextualCompareSideRequestSchema }).strict();
export type ContextualCompareSideRequest = z.infer<typeof contextualCompareSideRequestSchema>;
export type ContextualCompareRequest = z.infer<typeof contextualCompareRequestSchema>;

const availability = z.enum(["available", "unavailable", "exact_context_analysis_unavailable"]);
const summary = playerSummaryEnvelopeSchema.shape.data;
const quality = z.object({ spatialAvailable: z.boolean(), messiScoreComplete: z.boolean(), reason: z.string(), imputedMetrics: z.array(z.string()), imputedComponents: z.array(z.string()), observedWeightPct: z.number().finite().min(0).max(100) }).strict();
const side = z.object({
  player: identity, taxonomy, context: echoedContext, status: z.enum(["resolved", "unavailable"]),
  detail: z.unknown().nullable(), dataQuality: quality.nullable(), tacticalQuadrant: z.unknown().nullable(),
  duelPressPlayer: z.unknown().nullable(), duelPressDetailReadout: z.unknown().nullable(), summary: summary.nullable(),
  componentAvailability: z.object({ detail: availability, dataQuality: availability, tacticalQuadrant: availability }).strict(),
}).strict();

function contextMatches(actual: z.infer<typeof echoedContext>, expected: ContextualCompareSideRequest["context"]) {
  return actual.season === expected.season && actual.mode === expected.mode && actual.scope === expected.scope
    && actual.competition === (expected.mode === "league" ? null : expected.competition);
}
export const contextualCompareResponseSchema = z.object({ comparisonVersion: z.literal("contextual-compare-v1"), left: side, right: side }).strict();
export type ContextualCompareResponse = z.infer<typeof contextualCompareResponseSchema>;

/** Parses the exact two-side response and rejects echoed-context or availability lies. */
export function parseContextualCompareResponse(input: unknown, request: ContextualCompareRequest): ContextualCompareResponse {
  const parsed = contextualCompareResponseSchema.parse(input);
  (["left", "right"] as const).forEach((key) => {
    const result = parsed[key]; const expected = request[key]; const availabilityByField = result.componentAvailability;
    if (result.player.playerId !== expected.player.playerId || result.player.idNamespace !== expected.player.idNamespace || result.taxonomy !== expected.taxonomy || !contextMatches(result.context, expected.context)) throw new z.ZodError([{ code: "custom", path: [key], message: "response side identity did not match the request", input }]);
    if (result.status === "unavailable") {
      if (result.summary !== null || result.detail !== null || result.dataQuality !== null || result.tacticalQuadrant !== null || result.duelPressPlayer !== null || result.duelPressDetailReadout !== null || Object.values(availabilityByField).some((value) => value !== "unavailable")) throw new z.ZodError([{ code: "custom", path: [key], message: "unavailable side contained analytic data", input }]);
    } else {
      if (result.summary === null) throw new z.ZodError([{ code: "custom", path: [key, "summary"], message: "resolved side requires an authoritative summary", input }]);
      (["detail", "dataQuality", "tacticalQuadrant"] as const).forEach((field) => {
        const available = availabilityByField[field] === "available";
        if ((result[field] !== null) !== available) throw new z.ZodError([{ code: "custom", path: [key, field], message: "component availability did not match payload", input }]);
      });
    }
  });
  return parsed;
}

export function compareContextKey(side: ContextualCompareSideRequest): string {
  const c: DuelPressModeContext = side.context;
  return JSON.stringify([side.player.idNamespace, side.player.playerId, side.taxonomy, c.season, c.mode, c.scope, c.competition]);
}
