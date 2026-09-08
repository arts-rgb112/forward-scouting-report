import { z } from "zod";

/**
 * Strict decoder for `box-subregion-stats-v1`, mirroring
 * `api_server/box_subregion_contract.py` field for field and validator for
 * validator. This is a review-gated, not-yet-mounted backend contract — this
 * file exists so the frontend can be built and tested against the reviewed
 * shape now, without seeding a fixture as if it were a live response. Never
 * compute or reconstruct these numbers client-side; every value here is
 * server-authoritative or it is null.
 */

const ORDER = ["L4", "L3L", "L3R", "L2"] as const;
const META: Record<(typeof ORDER)[number], readonly [string, number, number]> = {
  L4: ["박스 좌", 63.0, 78.18],
  L3L: ["박스 중좌", 50.0, 63.0],
  L3R: ["박스 중우", 37.0, 50.0],
  L2: ["박스 우", 21.82, 37.0],
};

const count = z.number().int().nonnegative();
const amount = z.number().finite().nonnegative();
const finiteNumber = z.number().finite();
const pct = z.number().finite().min(0).max(100);
const coverageKey = /^[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$/;

const boxContext = z.object({
  playerId: z.number().int().positive(),
  season: z.string().regex(/^20\d{2}\/20\d{2}$/),
  mode: z.enum(["league", "europe"]),
  scope: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(8)]).nullable(),
  competition: z.enum(["all", "ucl", "uel", "uecl"]).nullable(),
}).strict().superRefine((value, ctx) => {
  const [start, end] = value.season.split("/").map(Number);
  if (end !== start + 1) ctx.addIssue({ code: "custom", path: ["season"], message: "season must contain consecutive years" });
  if (value.mode === "league" && (value.scope === null || value.competition !== null)) ctx.addIssue({ code: "custom", message: "league requires scope and null competition" });
  if (value.mode === "europe" && (value.scope !== null || value.competition === null)) ctx.addIssue({ code: "custom", message: "europe requires competition and null scope" });
});

const sourceCoverage = z.object({
  state: z.enum(["observed", "partial", "unavailable"]),
  expectedKeys: z.array(z.string()),
  observedKeys: z.array(z.string()),
  missingKeys: z.array(z.string()),
}).strict().superRefine((value, ctx) => {
  for (const [field, keys] of [["expectedKeys", value.expectedKeys], ["observedKeys", value.observedKeys], ["missingKeys", value.missingKeys]] as const) {
    const sorted = [...new Set(keys)].sort();
    if (keys.some((key) => !key) || JSON.stringify(keys) !== JSON.stringify(sorted) || keys.some((key) => !coverageKey.test(key)))
      ctx.addIssue({ code: "custom", path: [field], message: "coverage keys must be sorted, unique, nonblank, three positive native IDs" });
  }
  const expected = new Set(value.expectedKeys), observed = new Set(value.observedKeys), missing = new Set(value.missingKeys);
  // A known-no-mapping context (no expected keys at all — never a nonempty
  // selection with everything missing) is legitimate only as "unavailable".
  // It must not be confused with an observed empty selection, which reports
  // zero values rather than nulls. This is a documented edge case ahead of
  // the backend's own contract, not an assumption made up here.
  if (expected.size === 0 && observed.size === 0 && missing.size === 0) {
    if (value.state !== "unavailable") ctx.addIssue({ code: "custom", path: ["state"], message: "an empty expected/observed/missing selection is only valid as unavailable" });
    return;
  }
  const overlap = [...observed].some((key) => missing.has(key));
  const union = new Set([...observed, ...missing]);
  const partitions = expected.size > 0 && !overlap && union.size === expected.size && [...union].every((key) => expected.has(key));
  if (!partitions) ctx.addIssue({ code: "custom", message: "coverage keys do not partition expected selection" });
  const state = value.missingKeys.length === 0 ? "observed" : value.observedKeys.length > 0 ? "partial" : "unavailable";
  if (value.state !== state) ctx.addIssue({ code: "custom", path: ["state"], message: "coverage state contradicts keys" });
});

const coverage = z.object({ shots: sourceCoverage, activity: sourceCoverage }).strict();

const quality = z.object({
  xg: amount.nullable(),
  xgot: amount.nullable(),
  delta: finiteNumber.nullable(),
  eligible: count.nullable(),
  state: z.enum(["complete", "partial", "unavailable"]),
}).strict().superRefine((value, ctx) => {
  if (value.state === "unavailable") {
    if (value.xg !== null || value.xgot !== null || value.delta !== null) ctx.addIssue({ code: "custom", message: "unavailable quality has no numeric amounts" });
    if (value.eligible !== null && value.eligible !== 0) ctx.addIssue({ code: "custom", path: ["eligible"], message: "unavailable quality cannot have eligible pairs" });
  } else if (value.xg === null || value.xgot === null || value.delta === null || value.eligible === null) {
    ctx.addIssue({ code: "custom", message: "observed quality requires values" });
  } else if (value.delta !== Math.round((value.xgot - value.xg) * 10000) / 10000) {
    ctx.addIssue({ code: "custom", path: ["delta"], message: "quality must be rounded xGOT minus xG" });
  }
});

const shotSummary = z.object({
  shots: count.nullable(),
  goals: count.nullable(),
  xg: amount.nullable(),
  xgEligible: count.nullable(),
  quality,
}).strict().superRefine((value, ctx) => {
  if (value.shots === null) {
    if (value.goals !== null || value.xg !== null || value.xgEligible !== null || value.quality.eligible !== null)
      ctx.addIssue({ code: "custom", message: "unavailable shots require null values" });
    if (value.quality.state !== "unavailable") ctx.addIssue({ code: "custom", message: "unavailable shots require unavailable quality" });
    return;
  }
  if (value.goals === null || value.xgEligible === null || value.quality.eligible === null) { ctx.addIssue({ code: "custom", message: "observed shots require count fields" }); return; }
  if (!(value.goals >= 0 && value.goals <= value.shots) || !(value.quality.eligible >= 0 && value.quality.eligible <= value.xgEligible && value.xgEligible <= value.shots))
    ctx.addIssue({ code: "custom", message: "shot counts do not reconcile" });
  if ((value.xg === null) !== (value.shots > 0 && value.xgEligible === 0)) ctx.addIssue({ code: "custom", path: ["xg"], message: "xG availability contradicts eligible count" });
  if (value.quality.state === "complete" && value.quality.eligible !== value.shots) ctx.addIssue({ code: "custom", message: "complete quality requires all observed shots" });
  if (value.shots > 0 && value.quality.eligible === 0 && value.quality.state !== "unavailable") ctx.addIssue({ code: "custom", message: "nonempty sample without joint pairs has unavailable quality" });
  // Python's check is `value != 0`, and `None != 0` is True there — so a null
  // in this slot already fails upstream. `v !== null` was wrongly added here
  // and let a malformed observed-zero region (shots=0 but quality nulled out
  // like an unavailable sample) through. An observed-empty region must have
  // actual numeric zeros, never nulls masquerading as zero.
  if (value.shots === 0 && [value.xg, value.quality.xg, value.quality.xgot, value.quality.delta].some((v) => v !== 0)) ctx.addIssue({ code: "custom", message: "observed empty shots require zero quality" });
});

const bounds = z.object({ xMinInclusive: z.literal(84.29), yMinInclusive: amount, yMaxExclusive: amount }).strict();

const regionSchema = z.intersection(
  shotSummary,
  z.object({
    id: z.enum(ORDER),
    label: z.string(),
    bounds,
    activity: count.nullable(),
    shootingSharePct: pct.nullable(),
    activitySharePct: pct.nullable(),
  }).strict(),
).superRefine((value, ctx) => {
  const [name, low, high] = META[value.id];
  if (value.label !== name || value.bounds.yMinInclusive !== low || value.bounds.yMaxExclusive !== high)
    ctx.addIssue({ code: "custom", message: "region differs from box-subregion-v1 taxonomy" });
});

const denominators = z.object({
  selectedNonPenaltyShots: count.nullable(),
  fullActivityCount: count.nullable(),
}).strict();

const shotAccounting = z.object({
  source: shotSummary, inRegions: shotSummary, penalties: shotSummary, outside: shotSummary,
  reconciles: z.boolean().nullable(),
}).strict();

const activityAccounting = z.object({
  source: count.nullable(), inRegions: count.nullable(), outside: count.nullable(),
  reconciles: z.boolean().nullable(),
}).strict();

const pctOf = (numerator: number | null, denominator: number | null) =>
  numerator === null || denominator === null || denominator === 0 ? null : Math.round((numerator / denominator) * 100 * 10000) / 10000;

export const boxSubregionEnvelopeSchema = z.object({
  schemaVersion: z.literal("box-subregion-stats-v1"),
  definitionVersion: z.literal("box-subregion-v1"),
  shotProvider: z.literal("fotmob"),
  activityProvider: z.literal("sportsapi"),
  context: boxContext,
  completeness: z.enum(["observed", "partial", "unavailable"]),
  coverage,
  denominators,
  regions: z.array(regionSchema).length(4),
  accounting: shotAccounting,
  activityAccounting,
}).strict().superRefine((value, ctx) => {
  const states = [value.coverage.shots.state, value.coverage.activity.state] as const;
  const expected = states[0] === "observed" && states[1] === "observed" ? "observed" : states[0] === "unavailable" && states[1] === "unavailable" ? "unavailable" : "partial";
  if (value.completeness !== expected) ctx.addIssue({ code: "custom", path: ["completeness"], message: "envelope completeness invalid" });
  if (value.regions.map((r) => r.id).join(",") !== ORDER.join(",")) ctx.addIssue({ code: "custom", path: ["regions"], message: "regions must be ordered L4,L3L,L3R,L2" });
  if (value.coverage.shots.expectedKeys.some((key) => key.split(":")[0] !== String(value.context.playerId)))
    ctx.addIssue({ code: "custom", message: "shot context belongs to another player" });

  const unavailable = states[0] === "unavailable";
  const summaries = [value.accounting.source, value.accounting.inRegions, value.accounting.penalties, value.accounting.outside, ...value.regions];
  if (summaries.some((item) => (item.shots === null) !== unavailable)) ctx.addIssue({ code: "custom", message: "shot source availability contradicts values" });
  if (states[0] === "partial" && summaries.some((item) => item.quality.state === "complete")) ctx.addIssue({ code: "custom", message: "partial source cannot report complete quality" });
  if (states[0] === "observed" && summaries.some((item) => item.quality.state === "partial" && item.quality.eligible === item.shots)) ctx.addIssue({ code: "custom", message: "fully observed eligible sample cannot report partial quality" });

  const account = value.accounting;
  if (unavailable) {
    if (account.reconciles !== null || value.denominators.selectedNonPenaltyShots !== null) ctx.addIssue({ code: "custom", message: "unavailable shot reconciliation must be null" });
  } else {
    for (const field of ["shots", "goals", "xgEligible"] as const) {
      const sum = (account.inRegions[field] ?? 0) + (account.penalties[field] ?? 0) + (account.outside[field] ?? 0);
      if (account.source[field] !== sum) ctx.addIssue({ code: "custom", message: "shot accounting does not reconcile" });
      const regionSum = value.regions.reduce((total, r) => total + (r[field] ?? 0), 0);
      if (account.inRegions[field] !== regionSum) ctx.addIssue({ code: "custom", message: "region accounting does not reconcile" });
    }
    if (account.reconciles !== true || value.denominators.selectedNonPenaltyShots !== (account.source.shots ?? 0) - (account.penalties.shots ?? 0))
      ctx.addIssue({ code: "custom", message: "non-penalty denominator invalid" });
  }

  const activity = value.activityAccounting;
  if (states[1] === "unavailable") {
    if ([activity.source, activity.inRegions, activity.outside, activity.reconciles, value.denominators.fullActivityCount, ...value.regions.map((r) => r.activity)].some((v) => v !== null))
      ctx.addIssue({ code: "custom", message: "unavailable activity must be null" });
  } else if ([activity.source, activity.inRegions, activity.outside, ...value.regions.map((r) => r.activity)].some((v) => v === null) || activity.reconciles !== true) {
    ctx.addIssue({ code: "custom", message: "observed activity requires counts" });
  } else {
    const regionActivitySum = value.regions.reduce((total, r) => total + (r.activity ?? 0), 0);
    if (activity.source !== (activity.inRegions ?? 0) + (activity.outside ?? 0) || activity.inRegions !== regionActivitySum || activity.source !== value.denominators.fullActivityCount)
      ctx.addIssue({ code: "custom", message: "activity accounting does not reconcile" });
  }

  for (const r of value.regions) {
    if (r.shootingSharePct !== pctOf(r.shots, value.denominators.selectedNonPenaltyShots) || r.activitySharePct !== pctOf(r.activity, value.denominators.fullActivityCount))
      ctx.addIssue({ code: "custom", message: "shares must use original source denominators" });
  }
});

export type BoxSubregionEnvelope = z.infer<typeof boxSubregionEnvelopeSchema>;
export type BoxSubregionRegion = BoxSubregionEnvelope["regions"][number];
export const BOX_SUBREGION_ORDER = ORDER;

/**
 * The box-subregion-v1 definition's fixed geometry and Korean labels — the
 * same constants every region in a real envelope is checked against above.
 * This is definitional metadata (never changes per request), not a computed
 * aggregate, so 2D/3D hit-testing may key off it even before any server
 * response has arrived; the actual shot/quality numbers still come only
 * from a ready envelope.
 */
export const BOX_SUBREGION_X_MIN_INCLUSIVE = 84.29;
export const BOX_SUBREGION_BOUNDS: Record<(typeof ORDER)[number], { label: string; xMinInclusive: number; yMinInclusive: number; yMaxExclusive: number }> =
  Object.fromEntries(ORDER.map((id) => {
    const [label, yMinInclusive, yMaxExclusive] = META[id];
    return [id, { label, xMinInclusive: BOX_SUBREGION_X_MIN_INCLUSIVE, yMinInclusive, yMaxExclusive }];
  })) as Record<(typeof ORDER)[number], { label: string; xMinInclusive: number; yMinInclusive: number; yMaxExclusive: number }>;

/**
 * The one place that decides which box region a pitch-percent point falls
 * in, by the same half-open bounds every real envelope is validated against
 * above. 2D (SVG click math) and 3D (ray-hit world point, converted back to
 * pitch percent) both call this instead of each keeping its own boundary
 * logic — a mesh's static `userData` or a coarse click rect can each disagree
 * with the other at an exact shared edge (y=37/50/63), but this analytic
 * check never does, because there is only one of it.
 * `x`/`y` here can arrive from a real 3D ray hit round-tripped through
 * world-space and back (`worldToPitchPercent`), which does not reproduce an
 * exact decimal like 84.29 bit-for-bit — a genuine ray landing exactly on
 * the server's own boundary could otherwise read back as 84.289999999997 and
 * fall through to "no region" purely from float noise, not from actually
 * missing the boundary. Snapping to a precision far finer than any real
 * click/ray (1 millionth of a pitch-percent unit) absorbs that noise without
 * moving the boundary itself or loosening it into overlapping the next
 * region — which widening each comparison by an epsilon would have done.
 */
const snap = (value: number) => Math.round(value * 1e6) / 1e6;
export function resolveBoxSubregionId(x: number, y: number): (typeof ORDER)[number] | null {
  const snappedX = snap(x), snappedY = snap(y);
  if (snappedX < BOX_SUBREGION_X_MIN_INCLUSIVE) return null;
  return ORDER.find((id) => snappedY >= BOX_SUBREGION_BOUNDS[id].yMinInclusive && snappedY < BOX_SUBREGION_BOUNDS[id].yMaxExclusive) ?? null;
}
