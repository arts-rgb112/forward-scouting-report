import { z } from "zod";
import {
  nativeBodyPartCountsSchema,
  nativeBodyPartEnvelopeSchema,
  nativeBodyPartPartsSchema,
  nativeBodyPartQualitySchema,
  nativeBoxContext,
} from "./nativeBodyPartContracts";
import {
  nativeDisplayBoxStatsSchema,
  nativePitchIdentitySchema,
  nativePitchPlotSchema,
} from "./nativePitchEventsContracts";

/**
 * Strict transport decoder for `native-pitch-events-v2` only. V1 remains a
 * separate, unchanged endpoint and is never accepted by this schema.
 *
 * The decoder validates server-owned facts and reconciliation invariants; it
 * never derives a public shooting, quality, or zone statistic for rendering.
 */
const BODY_PARTS = ["head", "rightFoot", "leftFoot", "other", "unknown"] as const;
const SHOT_TYPES = ["goal", "save", "miss", "post", "block"] as const;
const OUTCOMES = ["goal", "on_target", "off_target", "blocked"] as const;
const BOX_ZONE_IDS = ["L4", "L3L", "L3R", "L2"] as const;
const GRID_ZONE_IDS = Array.from({ length: 6 }, (_, depth) =>
  Array.from({ length: 5 }, (_, lane) => `depth${depth + 1}_lane${lane + 1}`),
).flat();

const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
const coordinate = z.number().finite().min(0).max(100);
const percent = z.number().finite().min(0).max(100);

const outcomeForShotType: Record<(typeof SHOT_TYPES)[number], (typeof OUTCOMES)[number]> = {
  goal: "goal",
  save: "on_target",
  miss: "off_target",
  post: "off_target",
  block: "blocked",
};

type NativePitchV2DestinationKind = "goal_plane" | "block" | "unavailable";
const destinationKindsForShotType: Record<(typeof SHOT_TYPES)[number], readonly NativePitchV2DestinationKind[]> = {
  goal: ["goal_plane", "unavailable"],
  save: ["block", "unavailable"],
  miss: ["unavailable"],
  post: ["unavailable"],
  block: ["block", "unavailable"],
};

const nativePitchV2DestinationSchema = z.object({
  kind: z.enum(["goal_plane", "block", "unavailable"]),
  x: coordinate.nullable(),
  y: coordinate.nullable(),
  observedHeightMeters: z.null(),
  reason: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "unavailable") {
    if (value.x !== null || value.y !== null || value.reason === null)
      ctx.addIssue({ code: "custom", message: "unavailable terminal requires null coordinates and a reason" });
    return;
  }
  if (value.x === null || value.y === null || value.reason !== null)
    ctx.addIssue({ code: "custom", message: "available terminal requires coordinates and a null reason" });
  if (value.kind === "goal_plane" && value.x !== 100)
    ctx.addIssue({ code: "custom", path: ["x"], message: "goal-plane terminal must be on x=100" });
});

const nativePitchEventV2Schema = z.object({
  key: z.string().min(1),
  identity: nativePitchIdentitySchema,
  bodyPart: z.enum(BODY_PARTS),
  shotType: z.enum(SHOT_TYPES),
  outcome: z.enum(OUTCOMES),
  isPenalty: z.boolean(),
  xg: amount.nullable(),
  xgot: amount.nullable(),
  quality: nativeBodyPartQualitySchema,
  plot: nativePitchPlotSchema,
  destination: nativePitchV2DestinationSchema,
}).strict().superRefine((value, ctx) => {
  const expectedKey = `sportsapi:${value.identity.mappingKey}:${value.identity.sourcePlayerId}:${value.identity.matchId}:${value.identity.shotId}`;
  if (value.key !== expectedKey) ctx.addIssue({ code: "custom", path: ["key"], message: "event key contradicts source identity" });
  if (value.outcome !== outcomeForShotType[value.shotType])
    ctx.addIssue({ code: "custom", path: ["outcome"], message: "event outcome contradicts shot type" });
  if (!destinationKindsForShotType[value.shotType].includes(value.destination.kind))
    ctx.addIssue({ code: "custom", path: ["destination", "kind"], message: "terminal kind contradicts shot type" });

  if (value.xg === null || value.xgot === null) {
    if (value.quality.state !== "unavailable" || value.quality.eligible !== 0)
      ctx.addIssue({ code: "custom", path: ["quality"], message: "unpaired event requires unavailable zero-eligible quality" });
    return;
  }
  // Source event metrics preserve provider precision; public paired quality
  // rounds each operand to four decimals before subtracting server-side.
  const q = value.quality;
  const roundedOperand = (raw: number, rounded: number | null) => rounded !== null &&
    Math.abs(raw - rounded) <= 0.00005 + 1e-12 && Math.abs(rounded * 1e4 - Math.round(rounded * 1e4)) < 1e-8;
  if (q.state !== "complete" || q.eligible !== 1 || !roundedOperand(value.xg, q.xg) || !roundedOperand(value.xgot, q.xgot) ||
      q.xg === null || q.xgot === null || q.delta === null || Math.abs(q.delta - (q.xgot - q.xg)) > 1e-9)
    ctx.addIssue({ code: "custom", path: ["quality"], message: "event quality contradicts paired source metrics" });
});

const boundsSchema = z.object({
  xMinInclusive: coordinate,
  xMax: coordinate,
  includeMaxX: z.boolean(),
  yMinInclusive: coordinate,
  yMax: coordinate,
  includeMaxY: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.xMinInclusive >= value.xMax || value.yMinInclusive >= value.yMax)
    ctx.addIssue({ code: "custom", message: "zone bounds require positive extent" });
});

const zoneSourceSchema = z.object({
  state: z.enum(["complete", "partial", "unavailable"]),
  records: count.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === "unavailable") !== (value.records === null))
    ctx.addIssue({ code: "custom", message: "zone source state contradicts records availability" });
});

const nativePitchV2ZoneSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  bounds: boundsSchema,
  shots: count.nullable(),
  goals: count.nullable(),
  xg: amount.nullable(),
  xgEligible: count.nullable(),
  quality: nativeBodyPartQualitySchema,
  parts: nativeBodyPartPartsSchema,
  shootingSharePct: percent.nullable(),
  source: zoneSourceSchema,
}).strict().superRefine((value, ctx) => {
  const unavailable = value.source.state === "unavailable";
  if (unavailable) {
    if ([value.shots, value.goals, value.xg, value.xgEligible, value.shootingSharePct].some((entry) => entry !== null))
      ctx.addIssue({ code: "custom", message: "unavailable zone exposes an observed value" });
    return;
  }
  if (value.shots === null || value.goals === null || value.xgEligible === null || value.goals > value.shots) {
    ctx.addIssue({ code: "custom", message: "observed zone counts are invalid" });
    return;
  }
  const partValues = BODY_PARTS.map((part) => value.parts[part]);
  if (partValues.some((part) => part?.shots === null || part?.goals === null)) {
    ctx.addIssue({ code: "custom", message: "observed zone parts cannot be unavailable" });
    return;
  }
  const partShots = partValues.reduce((total, part) => total + part!.shots!, 0);
  const partGoals = partValues.reduce((total, part) => total + part!.goals!, 0);
  if (partShots !== value.shots || partGoals !== value.goals)
    ctx.addIssue({ code: "custom", message: "zone body-part counts do not reconcile" });
  if (value.source.records !== value.shots)
    ctx.addIssue({ code: "custom", message: "zone source records contradict shots" });
  if (value.xgEligible > value.shots || (value.xg === null) !== (value.shots > 0 && value.xgEligible === 0))
    ctx.addIssue({ code: "custom", message: "zone xG availability contradicts observed records" });
});

const gridAccountingSchema = z.object({
  source: count.nullable(),
  assigned: count.nullable(),
  unlocated: count.nullable(),
  reconciles: z.boolean().nullable(),
}).strict();

const boxAccountingSchema = z.object({
  source: count.nullable(),
  penalties: count.nullable(),
  denominator: count.nullable(),
  inRegions: count.nullable(),
  outside: count.nullable(),
  unlocated: count.nullable(),
  reconciles: z.boolean().nullable(),
}).strict();

const selectionZonesSchema = z.object({
  grid: z.array(nativePitchV2ZoneSchema),
  box: z.array(nativePitchV2ZoneSchema),
  gridAccounting: gridAccountingSchema,
  boxAccounting: boxAccountingSchema,
}).strict().superRefine((value, ctx) => {
  if (JSON.stringify(value.grid.map((zone) => zone.id)) !== JSON.stringify(GRID_ZONE_IDS))
    ctx.addIssue({ code: "custom", path: ["grid"], message: "grid requires ordered depth1_lane1 through depth6_lane5 taxonomy" });
  if (JSON.stringify(value.box.map((zone) => zone.id)) !== JSON.stringify(BOX_ZONE_IDS))
    ctx.addIssue({ code: "custom", path: ["box"], message: "box requires ordered L4/L3L/L3R/L2 taxonomy" });

  const grid = value.gridAccounting;
  if (grid.source === null) {
    if ([grid.assigned, grid.unlocated, grid.reconciles].some((entry) => entry !== null))
      ctx.addIssue({ code: "custom", path: ["gridAccounting"], message: "unavailable grid accounting must be null" });
  } else if (grid.assigned === null || grid.unlocated === null || grid.reconciles !== true || grid.source !== grid.assigned + grid.unlocated || value.grid.reduce((total, zone) => total + (zone.shots ?? 0), 0) !== grid.assigned) {
    ctx.addIssue({ code: "custom", path: ["gridAccounting"], message: "grid accounting does not conserve selection" });
  }

  const box = value.boxAccounting;
  if (box.source === null) {
    if ([box.penalties, box.denominator, box.inRegions, box.outside, box.unlocated, box.reconciles].some((entry) => entry !== null))
      ctx.addIssue({ code: "custom", path: ["boxAccounting"], message: "unavailable box accounting must be null" });
  } else if (box.penalties === null || box.denominator === null || box.inRegions === null || box.outside === null || box.unlocated === null || box.reconciles !== true || box.denominator !== box.source - box.penalties || box.denominator !== box.inRegions + box.outside + box.unlocated || value.box.reduce((total, zone) => total + (zone.shots ?? 0), 0) !== box.inRegions) {
    ctx.addIssue({ code: "custom", path: ["boxAccounting"], message: "box accounting does not conserve native non-PK selection" });
  }
});

function qualityWithinTolerance(expected: number, actual: number, pairedCount: number) {
  return Math.abs(expected - actual) <= (pairedCount + 1) * 0.00005 + 1e-9;
}

export const nativePitchEventsV2EnvelopeSchema = z.object({
  schemaVersion: z.literal("native-pitch-events-v2"),
  context: nativeBoxContext,
  provider: z.literal("sportsapi"),
  snapshotRevision: z.string().regex(/^[a-f0-9]{64}$/),
  includePenalties: z.boolean(),
  coordinateDefinition: z.literal("sportsapi-draw-pitch-display-v1"),
  trajectoryDefinition: z.literal("source-validated-terminal-planar-schematic-v2"),
  events: z.array(nativePitchEventV2Schema),
  bodyParts: nativeBodyPartEnvelopeSchema,
  box: nativeDisplayBoxStatsSchema,
  selectionZones: selectionZonesSchema,
}).strict().superRefine((value, ctx) => {
  const bodyContext = value.bodyParts.context;
  const sameContext = bodyContext.playerId === value.context.playerId
    && bodyContext.season === value.context.season
    && bodyContext.mode === value.context.mode
    && bodyContext.scope === value.context.scope
    && bodyContext.competition === value.context.competition;
  if (value.bodyParts.includePenalties !== value.includePenalties || !sameContext)
    ctx.addIssue({ code: "custom", path: ["bodyParts"], message: "body-part context or PK filter contradicts envelope" });

  const identities = value.events.map((event) => `${event.identity.mappingKey}:${event.identity.sourcePlayerId}:${event.identity.matchId}:${event.identity.shotId}`);
  if (identities.length !== new Set(identities).size)
    ctx.addIssue({ code: "custom", path: ["events"], message: "events contain duplicate source identity" });
  const ordering = value.events.map((event) => [event.identity.mappingKey, event.identity.matchId, event.identity.shotId] as const);
  if (ordering.some((entry, index) => index > 0 && (ordering[index - 1][0] > entry[0] || ordering[index - 1][0] === entry[0] && (ordering[index - 1][1] > entry[1] || ordering[index - 1][1] === entry[1] && ordering[index - 1][2] > entry[2]))))
    ctx.addIssue({ code: "custom", path: ["events"], message: "events are not deterministically ordered" });
  if (!value.includePenalties && value.events.some((event) => event.isPenalty))
    ctx.addIssue({ code: "custom", path: ["events"], message: "excluded-penalty response retains a penalty event" });
  if (value.bodyParts.totals.shots !== null && value.bodyParts.totals.shots !== value.events.length)
    ctx.addIssue({ code: "custom", path: ["bodyParts", "totals", "shots"], message: "body totals do not reconcile event list" });

  for (const part of BODY_PARTS) {
    const declared = value.bodyParts.parts[part];
    const events = value.events.filter((event) => event.bodyPart === part);
    if (declared.shots === null) continue;
    if (declared.shots !== events.length || declared.goals !== events.filter((event) => event.outcome === "goal").length)
      ctx.addIssue({ code: "custom", path: ["bodyParts", "parts", part], message: "body-part counts do not reconcile event list" });
    const paired = events.filter((event) => event.xg !== null && event.xgot !== null);
    if (declared.quality.eligible !== null && declared.quality.eligible !== paired.length)
      ctx.addIssue({ code: "custom", path: ["bodyParts", "parts", part, "quality"], message: "body-part quality eligibility does not reconcile event list" });
    if (declared.quality.xg !== null && declared.quality.xgot !== null && paired.length) {
      const xg = paired.reduce((total, event) => total + event.xg!, 0);
      const xgot = paired.reduce((total, event) => total + event.xgot!, 0);
      if (!qualityWithinTolerance(declared.quality.xg, xg, paired.length) || !qualityWithinTolerance(declared.quality.xgot, xgot, paired.length))
        ctx.addIssue({ code: "custom", path: ["bodyParts", "parts", part, "quality"], message: "body-part quality totals do not reconcile event list" });
    }
  }

  if (value.selectionZones.gridAccounting.source !== null && value.selectionZones.gridAccounting.source !== value.events.length)
    ctx.addIssue({ code: "custom", path: ["selectionZones", "gridAccounting", "source"], message: "grid source denominator differs from event list" });
});

export type NativePitchEventV2 = z.infer<typeof nativePitchEventV2Schema>;
export type NativePitchEventsV2Envelope = z.infer<typeof nativePitchEventsV2EnvelopeSchema>;
export type NativePitchV2Zone = z.infer<typeof nativePitchV2ZoneSchema>;
export const NATIVE_PITCH_V2_GRID_ZONE_IDS = GRID_ZONE_IDS;
export const NATIVE_PITCH_V2_BOX_ZONE_IDS = BOX_ZONE_IDS;
