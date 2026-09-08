import { z } from "zod";
import { nativeBodyPartEnvelopeSchema, nativeBoxContext } from "./nativeBodyPartContracts";

/**
 * Strict decoder for `native-pitch-events-v1`, mirroring
 * NATIVE_PITCH_EVENT_CONTRACT_20260908.md revision3 /
 * NATIVE_PITCH_PUBLIC_SHAPE_20260908.md. This is the ONLY source ever used
 * to connect an individual pitch marker to a recorded body part, quality,
 * and box region — it must never be joined to a FotMob `ShotmapPoint` by
 * count, array index, or coordinate proximity. `bodyParts`/`box` in this
 * envelope are built server-side from the exact same in-memory native
 * bundle as `events`; this client never composes them from separate fetches
 * as if they shared one revision.
 */

const BOX_REGION_ORDER = ["L4", "L3L", "L3R", "L2"] as const;
const finiteNonnegative = z.number().finite().nonnegative();
const percent = z.number().finite().min(0).max(100);
const count = z.number().int().nonnegative();

const positiveInt = z.number().int().positive();
const positiveTriple = z.string().regex(/^[1-9]\d*:[1-9]\d*:[1-9]\d*$/);

const identity = z.object({
  mappingKey: positiveTriple,
  sourcePlayerId: positiveInt,
  matchId: positiveInt,
  shotId: positiveInt,
}).strict();

const BODY_PARTS = ["head", "leftFoot", "rightFoot", "other", "unknown"] as const;
const SHOT_TYPES = ["goal", "save", "miss", "post", "block"] as const;
const OUTCOMES = ["goal", "on_target", "off_target", "blocked"] as const;
// Deterministic shotType → outcome map — a mismatch here is a malformed event, never silently reconciled.
const EXPECTED_OUTCOME: Record<(typeof SHOT_TYPES)[number], (typeof OUTCOMES)[number]> = {
  goal: "goal", save: "on_target", miss: "off_target", post: "off_target", block: "blocked",
};

const plot = z.object({
  state: z.enum(["projected", "unlocated"]),
  x: z.number().finite().min(0).max(100).nullable(),
  y: z.number().finite().min(0).max(100).nullable(),
  reason: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.state === "projected") {
    if (value.x === null || value.y === null || value.reason !== null)
      ctx.addIssue({ code: "custom", message: "projected plot requires both coordinates and a null reason" });
  } else if (value.x !== null || value.y !== null || value.reason === null) {
    ctx.addIssue({ code: "custom", message: "unlocated plot requires null coordinates and a nonempty reason" });
  }
});

const destination = z.object({
  kind: z.enum(["goal_plane_projection", "block_projection", "unavailable"]),
  x: z.number().finite().min(0).max(100).nullable(),
  y: z.number().finite().min(0).max(100).nullable(),
  observedHeightMeters: z.null(),
  reason: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "unavailable") {
    if (value.x !== null || value.y !== null || value.reason === null)
      ctx.addIssue({ code: "custom", message: "unavailable destination requires null x/y and a nonempty reason" });
    return;
  }
  if (value.x === null || value.y === null || value.reason !== null) {
    ctx.addIssue({ code: "custom", message: "an available destination requires nonnull x/y and a null reason" });
    return;
  }
  if (value.kind === "goal_plane_projection" && value.x !== 100)
    ctx.addIssue({ code: "custom", message: "goal_plane_projection destination x must be exactly the goal line (100)" });
});

const nativePitchEvent = z.object({
  key: z.string(),
  identity,
  bodyPart: z.enum(BODY_PARTS),
  shotType: z.enum(SHOT_TYPES),
  outcome: z.enum(OUTCOMES),
  isPenalty: z.boolean(),
  xg: finiteNonnegative.nullable(),
  xgot: finiteNonnegative.nullable(),
  plot,
  destination,
}).strict().superRefine((value, ctx) => {
  const expectedKey = `sportsapi:${value.identity.mappingKey}:${value.identity.sourcePlayerId}:${value.identity.matchId}:${value.identity.shotId}`;
  if (value.key !== expectedKey) ctx.addIssue({ code: "custom", path: ["key"], message: "key does not reconstruct from its own identity" });
  if (value.outcome !== EXPECTED_OUTCOME[value.shotType]) ctx.addIssue({ code: "custom", path: ["outcome"], message: "outcome contradicts its own shotType" });
  const allowedDestinationKinds: z.infer<typeof destination>["kind"][] = value.shotType === "block"
    ? ["block_projection", "unavailable"] : ["goal_plane_projection", "unavailable"];
  if (!allowedDestinationKinds.includes(value.destination.kind))
    ctx.addIssue({ code: "custom", path: ["destination", "kind"], message: "destination kind is not valid for this event's shotType" });
});

const boxQuality = z.object({
  xg: z.number().finite().nonnegative().nullable(),
  xgot: z.number().finite().nonnegative().nullable(),
  delta: z.number().finite().nullable(),
  eligible: count.nullable(),
  state: z.enum(["complete", "partial", "unavailable"]),
}).strict();

const boxShotSummary = z.object({
  shots: count.nullable(),
  goals: count.nullable(),
  xg: z.number().finite().nonnegative().nullable(),
  xgEligible: count.nullable(),
  quality: boxQuality,
}).strict();

// A single strict object, not `.and()` of two `.strict()` schemas — chaining
// strict intersections is a known footgun (each side can reject the other's
// fields as unrecognized extras on some zod builds), so this stays one flat
// shape even though `boxShotSummary`'s own fields are duplicated here.
const boxRegion = z.object({
  id: z.enum(BOX_REGION_ORDER),
  label: z.string().min(1),
  bounds: z.object({ xMinInclusive: z.number(), yMinInclusive: z.number(), yMaxExclusive: z.number() }).strict(),
  shots: count.nullable(),
  goals: count.nullable(),
  xg: z.number().finite().nonnegative().nullable(),
  xgEligible: count.nullable(),
  quality: boxQuality,
  shootingSharePct: percent.nullable(),
}).strict();

const nativeDisplayBoxStats = z.object({
  definitionVersion: z.literal("native-display-box-subregion-v1"),
  coordinateDefinition: z.literal("sportsapi-draw-pitch-display-v1"),
  regionOrder: z.tuple([z.literal("L4"), z.literal("L3L"), z.literal("L3R"), z.literal("L2")]),
  denominator: count.nullable(),
  regions: z.record(z.enum(BOX_REGION_ORDER), boxRegion),
  accounting: z.object({
    source: boxShotSummary, penalties: boxShotSummary, inRegions: boxShotSummary, outside: boxShotSummary, unlocated: boxShotSummary,
    reconciles: z.boolean().nullable(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (BOX_REGION_ORDER.some((region) => !(region in value.regions))) ctx.addIssue({ code: "custom", message: "box region taxonomy is invalid" });
  const unavailable = value.denominator === null;
  if ((value.accounting.source.shots === null) !== unavailable) ctx.addIssue({ code: "custom", message: "box availability contradicts denominator" });
  if (value.accounting.reconciles !== (unavailable ? null : true) && value.accounting.reconciles !== null)
    ctx.addIssue({ code: "custom", message: "box accounting must reconcile when observed" });
});

function qualityTolerance(childCount: number): number {
  return (childCount + 1) * 0.00005 + 1e-9;
}

const BOX_MIN_X = 84.29;
const BOX_BOUNDS: Record<(typeof BOX_REGION_ORDER)[number], { yMin: number; yMax: number }> = {
  L4: { yMin: 63.0, yMax: 78.18 }, L3L: { yMin: 50.0, yMax: 63.0 }, L3R: { yMin: 37.0, yMax: 50.0 }, L2: { yMin: 21.82, yMax: 37.0 },
};
function regionFor(x: number, y: number): (typeof BOX_REGION_ORDER)[number] | null {
  if (x < BOX_MIN_X) return null;
  for (const region of BOX_REGION_ORDER) { const { yMin, yMax } = BOX_BOUNDS[region]; if (y >= yMin && y < yMax) return region; }
  return null;
}

export const nativePitchEventsEnvelopeSchema = z.object({
  schemaVersion: z.literal("native-pitch-events-v1"),
  context: nativeBoxContext,
  provider: z.literal("sportsapi"),
  snapshotRevision: z.string().regex(/^[a-f0-9]{64}$/),
  includePenalties: z.boolean(),
  coordinateDefinition: z.literal("sportsapi-draw-pitch-display-v1"),
  trajectoryDefinition: z.literal("source-planar-schematic-height-v1"),
  events: z.array(nativePitchEvent),
  bodyParts: nativeBodyPartEnvelopeSchema,
  box: nativeDisplayBoxStats,
}).strict().superRefine((value, ctx) => {
  const keys = value.events.map((event) => event.key);
  if (keys.length !== new Set(keys).size) ctx.addIssue({ code: "custom", message: "duplicate event key" });
  const identities = value.events.map((event) => `${event.identity.mappingKey}:${event.identity.sourcePlayerId}:${event.identity.matchId}:${event.identity.shotId}`);
  if (identities.length !== new Set(identities).size) ctx.addIssue({ code: "custom", message: "duplicate event identity" });

  // Events are an ORDERED list — deterministic ascending (mappingKey, matchId, shotId), matching
  // the same native core sort key used by native_pitch_box_core.py / box_subregion_core.py.
  for (let i = 1; i < identities.length; i++) if (identities[i - 1] > identities[i]) { ctx.addIssue({ code: "custom", message: "events are not in deterministic (mappingKey, matchId, shotId) order" }); break; }

  if (value.bodyParts.includePenalties !== value.includePenalties) ctx.addIssue({ code: "custom", message: "bodyParts PK filter contradicts the envelope's own filter" });
  if (value.bodyParts.context.playerId !== value.context.playerId || value.bodyParts.context.season !== value.context.season
    || value.bodyParts.context.mode !== value.context.mode || value.bodyParts.context.scope !== value.context.scope || value.bodyParts.context.competition !== value.context.competition)
    ctx.addIssue({ code: "custom", message: "bodyParts context contradicts the envelope's own context" });

  // Every event must belong to a match the embedded bodyParts sources actually cover — no
  // event from a match outside the exact source/validMatchIds membership already established there.
  const observedSources = value.bodyParts.sources.filter((source) => source.coverage.state !== "unavailable");
  if (observedSources.length > 0) {
    const validMatchIds = new Set(observedSources.flatMap((source) => source.coverage.validMatchIds));
    for (const event of value.events) if (!validMatchIds.has(event.identity.matchId)) { ctx.addIssue({ code: "custom", message: "an event's matchId is outside bodyParts' own validMatchIds coverage" }); break; }
  }

  // event → body counts/paired quality: recompute directly from the raw event list (never from
  // an already-rounded child sum) and compare against bodyParts.parts, per PARTS taxonomy.
  for (const part of BODY_PARTS) {
    const partEvents = value.events.filter((event) => event.bodyPart === part);
    const declared = value.bodyParts.parts[part];
    if (declared.shots !== null) {
      if (declared.shots !== partEvents.length) ctx.addIssue({ code: "custom", message: `bodyParts.parts.${part}.shots does not reconcile from raw events` });
      const goals = partEvents.filter((event) => event.shotType === "goal").length;
      if (declared.goals !== goals) ctx.addIssue({ code: "custom", message: `bodyParts.parts.${part}.goals does not reconcile from raw events` });
      const paired = partEvents.filter((event) => event.xg !== null && event.xgot !== null);
      if (declared.quality.eligible !== null && declared.quality.eligible !== paired.length)
        ctx.addIssue({ code: "custom", message: `bodyParts.parts.${part}.quality.eligible does not reconcile from raw events` });
      if (declared.quality.xg !== null && paired.length > 0) {
        const xgSum = paired.reduce((sum, event) => sum + event.xg!, 0);
        const xgotSum = paired.reduce((sum, event) => sum + event.xgot!, 0);
        const tolerance = qualityTolerance(paired.length);
        if (Math.abs(declared.quality.xg - xgSum) > tolerance || (declared.quality.xgot !== null && Math.abs(declared.quality.xgot - xgotSum) > tolerance))
          ctx.addIssue({ code: "custom", message: `bodyParts.parts.${part}.quality does not sum from raw events within rounding tolerance` });
      }
    }
  }

  // event → box partitions/denominator: recompute the same region assignment (isPenalty first,
  // then plot state, then the shared region boundaries) from the raw events and compare exact
  // shot counts + denominator against the `box` field — never trust `box`'s own rounded sums here.
  if (value.box.denominator !== null) {
    const penalties = value.events.filter((event) => event.isPenalty);
    const nonPenalty = value.events.filter((event) => !event.isPenalty);
    if (value.box.denominator !== nonPenalty.length) ctx.addIssue({ code: "custom", message: "box.denominator does not reconcile from raw non-penalty events" });
    const unlocated = nonPenalty.filter((event) => event.plot.state === "unlocated");
    if (value.box.accounting.unlocated.shots !== null && value.box.accounting.unlocated.shots !== unlocated.length)
      ctx.addIssue({ code: "custom", message: "box.accounting.unlocated does not reconcile from raw events" });
    if (value.box.accounting.penalties.shots !== null && value.box.accounting.penalties.shots !== penalties.length)
      ctx.addIssue({ code: "custom", message: "box.accounting.penalties does not reconcile from raw events" });
    for (const region of BOX_REGION_ORDER) {
      const regionEvents = nonPenalty.filter((event) => event.plot.state === "projected" && regionFor(event.plot.x!, event.plot.y!) === region);
      const declared = value.box.regions[region];
      if (declared.shots !== null && declared.shots !== regionEvents.length)
        ctx.addIssue({ code: "custom", message: `box.regions.${region}.shots does not reconcile from raw events` });
    }
  }
});

export type NativePitchEventsEnvelope = z.infer<typeof nativePitchEventsEnvelopeSchema>;
export type NativePitchEvent = z.infer<typeof nativePitchEvent>;
export const NATIVE_PITCH_BODY_PARTS = BODY_PARTS;
