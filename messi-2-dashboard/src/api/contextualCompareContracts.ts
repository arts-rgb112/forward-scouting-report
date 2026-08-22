import { z } from "zod";

import { tacticalQuadrantEnvelopeSchema } from "./contracts";
import { duelPressPlayerSchema } from "./duelPressContracts";
import { duelPressDetailReadoutEnvelopeSchema } from "./duelPressDetailReadoutContracts";
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
export const contextualCompareRequestSchema = z.object({ comparisonVersion: z.literal("contextual-compare-v1"), left: contextualCompareSideRequestSchema, right: contextualCompareSideRequestSchema }).strict().superRefine((value, ctx) => {
  const key = (side: z.infer<typeof contextualCompareSideRequestSchema>) => JSON.stringify([side.player.idNamespace, side.player.playerId, side.context.season, side.context.mode, side.context.scope, side.context.competition]);
  if (key(value.left) === key(value.right)) ctx.addIssue({ code: "custom", path: ["right"], message: "left and right must not use the identical player and context" });
});
export type ContextualCompareSideRequest = z.infer<typeof contextualCompareSideRequestSchema>;
export type ContextualCompareRequest = z.infer<typeof contextualCompareRequestSchema>;

const availability = z.enum(["available", "unavailable", "exact_context_analysis_unavailable"]);
const score = z.number().finite().min(0).max(100);
const asset = z.object({ id: z.number().int(), name: z.string().min(1), icon: z.string().url().nullable() }).strict();
const summary = z.object({ id: z.number().int().positive(), rank: z.number().int().positive(), name: z.string().min(1), position: z.string().min(1), archetype: z.enum(["Type A", "Type B"]), age: z.number().int().nullable(), minutes: z.number().int().nonnegative(), tier: z.object({ code: z.string().min(1), level: z.number().int().min(1).max(5), label: z.string().min(1), taxonomyVersion: z.string().min(1).optional() }).strict(), score, face: z.string().url().nullable(), nation: asset.nullable().optional(), league: asset, club: asset, stats: z.object({ outsideShot: score, boxThreat: score, dangerZone: score, aerial: score, groundDuel: score, spaceControl: score }).strict() }).strict();
const quality = z.object({ qualityVersion: z.literal("messi-quality-v1").optional(), spatialAvailable: z.boolean(), messiScoreComplete: z.boolean(), reason: z.string().min(1), imputedMetrics: z.array(z.enum(["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"])).max(6), imputedComponents: z.array(z.string().min(1)).max(12), observedWeightPct: z.number().finite().min(0).max(100), fallbackComponentScore: z.literal(20).optional() }).strict().superRefine((value, ctx) => {
  if (new Set(value.imputedMetrics).size !== value.imputedMetrics.length || new Set(value.imputedComponents).size !== value.imputedComponents.length) ctx.addIssue({ code: "custom", message: "imputed fields must be unique" });
  if (value.messiScoreComplete && (value.reason !== "complete" || value.imputedMetrics.length || value.imputedComponents.length)) ctx.addIssue({ code: "custom", message: "complete quality cannot be imputed" });
  if (!value.messiScoreComplete && (value.reason === "complete" || !value.imputedMetrics.length)) ctx.addIssue({ code: "custom", message: "incomplete quality must declare imputation" });
});
const detail = summary.extend({ idNamespace: z.literal("fotmob").optional(), analysis: z.object({ score: z.object({ value: score, rank: z.number().int().positive().nullable(), topPercent: score.nullable(), population: z.number().int().nonnegative(), archetype: z.enum(["Type A", "Type B"]) }).strict(), volumeRadar: z.object({ kind: z.literal("volume"), axes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), score }).passthrough()).length(6) }).strict(), ratioRadar: z.object({ kind: z.literal("ratio"), axes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), score }).passthrough()).length(6) }).strict(), rawMetrics: z.record(z.string(), z.number().finite().nullable()), spatial: z.object({ available: z.boolean(), heatmapPointCount: z.number().int().nonnegative(), heatmapPoints: z.array(z.object({ x: score, y: score }).strict()), shotmapPointCount: z.number().int().nonnegative(), shotmapPoints: z.array(z.unknown()), shotmapSnapshotAvailable: z.boolean(), trueCore: z.object({ available: z.boolean() }).passthrough(), continuousCore: z.object({ available: z.boolean() }).passthrough() }).passthrough() }).strict() });
const tacticalQuadrant = tacticalQuadrantEnvelopeSchema.shape.data;
const duelPressPlayerCompact = summary.extend({ stats: z.object({ outsideShot: score, boxThreat: score, dangerZone: score, combinedDuel: score, spaceControl: score, forwardPress: score }).strict(), components: z.object({ combinedDuelVolume: score, combinedDuelEfficiency: score, recoveries: score, finalThirdPossessionsWon: score }).strict(), pressingRawMetrics: z.record(z.string(), z.number().finite().nullable()) }).omit({ nation: true });
const duelPressPlayer = z.union([duelPressPlayerSchema, duelPressPlayerCompact]);
const comparison = z.object({ state: z.enum(["available", "unavailable", "not_applicable"]), median: z.number().finite().nullable().optional().transform((value) => value ?? null), rank: z.number().int().positive().nullable().optional().transform((value) => value ?? null), percentile: z.number().finite().min(0).max(100).nullable().optional().transform((value) => value ?? null), population: z.number().int().nonnegative() }).strict();
const rawReadout = z.object({ id: z.string().min(1), label: z.string().min(1), value: z.number().finite().nullable(), unit: z.enum(["count", "per90", "goals", "percent", "score"]), direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]), source: z.enum(["player_season_total", "league_per90_fallback", "tactical_ratio_static", "server_derived", "unavailable"]), state: z.enum(["observed", "server_derived", "imputed", "unavailable", "legacy_partial"]), comparison, formulaId: z.string().min(1).nullable().optional(), formulaVersion: z.string().min(1).nullable().optional(), missingComponents: z.array(z.string().min(1)).nullable().optional() }).strict();
const readoutContext = z.object({ playerId: z.number().int().positive(), idNamespace: z.literal("fotmob"), season: z.string().regex(/^20\d{2}\/20\d{2}$/), mode: z.enum(["league", "europe"]), scope: scope.nullable(), competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable() }).strict();
const duelPressDetailReadoutCompact = z.object({ context: readoutContext, player: z.object({ id: z.number().int().positive(), idNamespace: z.literal("fotmob").optional(), name: z.string().min(1), position: z.string().min(1), club: asset, league: asset }).strict(), categories: z.array(z.object({ id: z.enum(["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"]), label: z.string().min(1), score: score.nullable(), scoreState: z.enum(["observed", "imputed", "unavailable"]), imputedComponents: z.array(z.string()).optional(), comparison, readouts: z.array(rawReadout).min(1) }).strict()).length(6), contextIndicators: z.array(rawReadout).length(2) }).strict().superRefine((value, ctx) => {
  const categories = ["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"];
  const indicators = ["netProgressionPer90", "shootingLuckOrGoalkeeperImpact"];
  if (value.categories.map((item) => item.id).join("|") !== categories.join("|")) ctx.addIssue({ code: "custom", path: ["categories"], message: "category order is invalid" });
  if (value.contextIndicators.map((item) => item.id).join("|") !== indicators.join("|")) ctx.addIssue({ code: "custom", path: ["contextIndicators"], message: "indicator order is invalid" });
  if (value.contextIndicators[0]?.direction !== "neutral" || value.contextIndicators[0]?.formulaId !== "net-progression-v1" || value.contextIndicators[1]?.direction !== "neutral" || value.contextIndicators[1]?.formulaId !== "goals-minus-xgot-v1") ctx.addIssue({ code: "custom", path: ["contextIndicators"], message: "indicator semantics are invalid" });
  if (value.context.playerId !== value.player.id || (value.player.idNamespace !== undefined && value.context.idNamespace !== value.player.idNamespace)) ctx.addIssue({ code: "custom", path: ["player"], message: "readout player identity must echo context" });
});
const duelPressDetailReadout = z.union([duelPressDetailReadoutEnvelopeSchema, duelPressDetailReadoutCompact]);
const side = z.object({
  player: identity, taxonomy, context: echoedContext, status: z.enum(["resolved", "unavailable", "invalid_context"]),
  detail: detail.nullable(), dataQuality: quality.nullable(), tacticalQuadrant: tacticalQuadrant.nullable().optional().transform((value) => value ?? null),
  duelPressPlayer: duelPressPlayer.nullable().optional().transform((value) => value ?? null), duelPressDetailReadout: duelPressDetailReadout.nullable().optional().transform((value) => value ?? null), summary: summary.nullable(),
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
    if (result.status !== "resolved") {
      if (result.summary !== null || result.detail !== null || result.dataQuality !== null || result.tacticalQuadrant !== null || result.duelPressPlayer !== null || result.duelPressDetailReadout !== null || Object.values(availabilityByField).some((value) => value !== "unavailable")) throw new z.ZodError([{ code: "custom", path: [key], message: "unavailable side contained analytic data", input }]);
    } else {
      if (result.summary === null) throw new z.ZodError([{ code: "custom", path: [key, "summary"], message: "resolved side requires an authoritative summary", input }]);
      (["detail", "dataQuality", "tacticalQuadrant"] as const).forEach((field) => {
        const available = availabilityByField[field] === "available";
        if ((result[field] !== null) !== available) throw new z.ZodError([{ code: "custom", path: [key, field], message: "component availability did not match payload", input }]);
      });
      if (result.summary.id !== result.player.playerId || (result.detail !== null && result.detail.id !== result.player.playerId)) throw new z.ZodError([{ code: "custom", path: [key], message: "summary/detail identity did not match the side", input }]);
      if (result.tacticalQuadrant !== null && (result.tacticalQuadrant.playerId !== result.player.playerId || result.tacticalQuadrant.season !== result.context.season || result.tacticalQuadrant.mode !== result.context.mode || result.tacticalQuadrant.scope !== result.context.scope || result.tacticalQuadrant.competition !== result.context.competition || !result.tacticalQuadrant.available)) throw new z.ZodError([{ code: "custom", path: [key, "tacticalQuadrant"], message: "tactical identity did not match the side", input }]);
      if (result.taxonomy === "legacy-v1" && (result.duelPressPlayer !== null || result.duelPressDetailReadout !== null)) throw new z.ZodError([{ code: "custom", path: [key], message: "legacy side carried duel-press data", input }]);
      if (result.taxonomy === "duel-press-v1") {
        if (result.duelPressPlayer === null || result.duelPressDetailReadout === null) throw new z.ZodError([{ code: "custom", path: [key], message: "resolved duel-press side requires exact duel data", input }]);
        const readout = result.duelPressDetailReadout;
        if (result.duelPressPlayer.id !== result.player.playerId || readout.context.playerId !== result.player.playerId || readout.context.idNamespace !== result.player.idNamespace || readout.context.season !== result.context.season || readout.context.mode !== result.context.mode || readout.context.scope !== result.context.scope || readout.context.competition !== result.context.competition) throw new z.ZodError([{ code: "custom", path: [key, "duelPressDetailReadout"], message: "duel readout identity did not match the side", input }]);
      }
    }
  });
  return parsed;
}

export function compareContextKey(side: ContextualCompareSideRequest): string {
  const c: DuelPressModeContext = side.context;
  return JSON.stringify([side.player.idNamespace, side.player.playerId, side.taxonomy, c.season, c.mode, c.scope, c.competition]);
}
