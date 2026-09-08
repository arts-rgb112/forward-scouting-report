import { z } from "zod";

/**
 * Strict decoder for `native-body-part-stats-v2`, mirroring
 * `api_server/native_body_part_contract.py` field for field. These are
 * SportsAPI-native AGGREGATE counts — they can never be joined to an
 * individual FotMob marker event. A selected-shot body-part highlight is
 * explicitly out of scope here; do not attempt to derive one from this data.
 *
 * v2 (2026-09-08, BODY_PART_QUALITY_PROPOSAL_20260908.md revision2) adds a
 * required `quality` object (xGOT−xG on paired native xg/xgot) to every
 * part, source part, and totals row. `.strict()` on the old shape means a
 * genuine v1 response (missing `quality`) is rejected outright by this
 * decoder — there is no separate v1/v2 branch to maintain.
 */

const PARTS = ["head", "leftFoot", "rightFoot", "other", "unknown"] as const;
const count = z.number().int().nonnegative();

// Fixed provider-native tournament identities, mirrored verbatim from
// `native_body_part_contract.py`'s COMPETITION_TOURNAMENTS — deliberately
// duplicated here to keep this strict transport module independent of the
// provider implementation, exactly like the Python source it mirrors.
const COMPETITION_TOURNAMENTS: Record<string, { tournamentId: number; group: "domestic" | "europe"; code: "ucl" | "uel" | "uecl" | null }> = {
  "Premier League": { tournamentId: 17, group: "domestic", code: null },
  "LaLiga": { tournamentId: 8, group: "domestic", code: null },
  "Bundesliga": { tournamentId: 35, group: "domestic", code: null },
  "Serie A": { tournamentId: 23, group: "domestic", code: null },
  "Ligue 1": { tournamentId: 34, group: "domestic", code: null },
  "Eredivisie": { tournamentId: 37, group: "domestic", code: null },
  "Primeira Liga": { tournamentId: 238, group: "domestic", code: null },
  "Belgian Pro League": { tournamentId: 38, group: "domestic", code: null },
  "UEFA Champions League": { tournamentId: 7, group: "europe", code: "ucl" },
  "UEFA Europa League": { tournamentId: 679, group: "europe", code: "uel" },
  "UEFA Europa Conference League": { tournamentId: 17015, group: "europe", code: "uecl" },
};

export const nativeBoxContext = z.object({
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

/**
 * `xGOT−xG` on the same-event paired native xg/xgot within this row. `state`
 * is coverage of METRIC pairing within the OBSERVED shots of this row alone
 * — a row's own source can still be `partial` completeness while its
 * quality is `complete` (every shot it does have happens to be paired), and
 * the two must never be conflated into one flag.
 */
// xg/xgot are real observed shot-quality scores — negative or non-finite
// values are always malformed, regardless of state.
const finiteNonnegative = z.number().finite().nonnegative();
const quality = z.object({
  xg: finiteNonnegative.nullable(), xgot: finiteNonnegative.nullable(), delta: z.number().finite().nullable(),
  eligible: count.nullable(), state: z.enum(["complete", "partial", "unavailable"]),
}).strict().superRefine((value, ctx) => {
  if (value.state === "unavailable") {
    if (value.xg !== null || value.xgot !== null || value.delta !== null)
      ctx.addIssue({ code: "custom", message: "unavailable quality must have null metrics" });
    // A standalone unavailable object alone cannot distinguish "this row was
    // never observed at all" (eligible null) from "shots exist but none are
    // paired" (eligible 0) — that requires the row's own `shots`, checked
    // separately by `checkQualityAgainstShots` below. Both are legitimate
    // shapes here; only a genuinely nonzero eligible would contradict "unavailable".
    if (value.eligible !== null && value.eligible !== 0)
      ctx.addIssue({ code: "custom", message: "unavailable quality's eligible must be null or zero, never a real positive pair count" });
    return;
  }
  if (value.xg === null || value.xgot === null || value.delta === null || value.eligible === null) {
    ctx.addIssue({ code: "custom", message: "observed quality state requires every quality field" });
    return;
  }
  // Frontend never recomputes xGOT−xG from raw records — this only checks
  // the row's own reported delta is internally self-consistent at the same
  // 4-decimal rounding the server itself applies, per the proposal's rule
  // that a rounded xg/xgot pair must reproduce its own rounded delta.
  const expectedDelta = Math.round((value.xgot - value.xg) * 1e4) / 1e4;
  if (Math.abs(value.delta - expectedDelta) > 1e-9)
    ctx.addIssue({ code: "custom", message: "quality delta does not equal rounded xgot minus xg" });
});
type NativeQuality = z.infer<typeof quality>;

/**
 * Mirrors `native_body_part_contract.py`'s `_check_quality_children` exactly
 * (including which fields gate which branch) — `children` is the FULL raw
 * set (e.g. every source, not pre-filtered to "observed" ones); a child's
 * own `state` is what decides whether it contributes to the parent sum, so
 * an unavailable child is correctly excluded without the caller needing its
 * own separate availability filter.
 */
function checkQualityChildren(parent: NativeQuality, children: NativeQuality[], ctx: z.RefinementCtx, label: string) {
  const observed = children.filter((child) => child.state !== "unavailable");
  if (observed.length === 0) {
    if (parent.state !== "unavailable") ctx.addIssue({ code: "custom", message: `${label}: unavailable children require unavailable parent quality` });
    return;
  }
  const eligibleSum = observed.reduce((sum, child) => sum + (child.eligible ?? 0), 0);
  if (parent.eligible !== eligibleSum) ctx.addIssue({ code: "custom", message: `${label}: quality eligibility does not reconcile children` });
  if (parent.state === "unavailable") {
    if (eligibleSum) ctx.addIssue({ code: "custom", message: `${label}: paired child quality requires observed parent` });
    return;
  }
  const metricChildren = observed.filter((child) => child.xg !== null);
  if (metricChildren.length === 0) {
    if (parent.eligible !== 0) ctx.addIssue({ code: "custom", message: `${label}: unpaired child quality requires zero eligible pairs` });
    // The earlier return already ruled out `unavailable`; retaining a
    // comparison here both misstates the reachable shape and trips TS's
    // deliberate narrowing diagnostic.
    ctx.addIssue({ code: "custom", message: `${label}: unpaired child quality requires unavailable parent` });
    return;
  }
  // Tolerance is sized by the PAIRED (metric-bearing) children only — never
  // widen it by counting missing/unavailable children, or a source with many
  // unobserved siblings could mask a genuinely wrong sum.
  const tolerance = (metricChildren.length + 1) * 0.00005 + 1e-9;
  const xgSum = metricChildren.reduce((sum, child) => sum + child.xg!, 0);
  const xgotSum = metricChildren.reduce((sum, child) => sum + child.xgot!, 0);
  if (parent.xg === null || parent.xgot === null || Math.abs(parent.xg - xgSum) > tolerance || Math.abs(parent.xgot - xgotSum) > tolerance)
    ctx.addIssue({ code: "custom", message: `${label}: quality totals exceed rounding tolerance` });
}

/** Mirrors `_check_quality_for_shots` exactly — cross-checks one row's `quality` against its own `shots`/`eligible`, shared by bodyPartCounts and totals below. */
function checkQualityAgainstShots(shots: number | null, qualityValue: NativeQuality, ctx: z.RefinementCtx) {
  const quality = qualityValue;
  if (shots === null) {
    // Genuinely never-observed — eligible must be exactly null, not 0 (0 is
    // reserved for "we did observe shots but none paired", a different fact).
    if (quality.state !== "unavailable" || quality.eligible !== null)
      ctx.addIssue({ code: "custom", message: "unavailable counts require unavailable source quality" });
    return;
  }
  if (shots === 0) {
    // An honestly-observed empty part/total is a real complete zero, never
    // conflated with "we could not observe this at all".
    if (quality.state !== "complete" || quality.eligible !== 0 || quality.xg !== 0 || quality.xgot !== 0 || quality.delta !== 0)
      ctx.addIssue({ code: "custom", message: "observed zero counts require observed-zero quality" });
    return;
  }
  if (quality.state === "unavailable") {
    if (quality.eligible !== 0) ctx.addIssue({ code: "custom", message: "unpaired observed counts require zero eligible pairs" });
  } else if (quality.state === "complete") {
    if (quality.eligible !== shots) ctx.addIssue({ code: "custom", message: "complete quality must cover every observed shot" });
  } else if (!(quality.eligible !== null && quality.eligible > 0 && quality.eligible < shots)) {
    ctx.addIssue({ code: "custom", message: "partial quality must cover a strict subset of observed shots" });
  }
}

const bodyPartCounts = z.object({ shots: count.nullable(), goals: count.nullable(), quality }).strict().superRefine((value, ctx) => {
  if ((value.shots === null) !== (value.goals === null)) ctx.addIssue({ code: "custom", message: "body-part counts must both be null or observed" });
  if (value.shots !== null && value.goals! > value.shots) ctx.addIssue({ code: "custom", message: "body-part goals exceed shots" });
  checkQualityAgainstShots(value.shots, value.quality, ctx);
});

const totals = z.object({
  admittedShots: count.nullable(), excludedPenaltyShots: count.nullable(), excludedPenaltyGoals: count.nullable(),
  shots: count.nullable(), goals: count.nullable(), quality,
}).strict().superRefine((value, ctx) => {
  const values = [value.admittedShots, value.excludedPenaltyShots, value.excludedPenaltyGoals, value.shots, value.goals];
  const allNull = values.every((v) => v === null), anyNull = values.some((v) => v === null);
  if (anyNull && !allNull) { ctx.addIssue({ code: "custom", message: "unavailable totals must all be null" }); }
  else if (!allNull) {
    if (value.goals! > value.shots! || value.excludedPenaltyGoals! > value.excludedPenaltyShots!) ctx.addIssue({ code: "custom", message: "native goals exceed shots" });
    if (value.admittedShots !== value.shots! + value.excludedPenaltyShots!) ctx.addIssue({ code: "custom", message: "admitted shots do not reconcile filter" });
  }
  checkQualityAgainstShots(value.shots, value.quality, ctx);
});

const coverage = z.object({
  state: z.enum(["complete", "partial", "unavailable"]),
  expectedMatchIds: z.array(z.number().int().positive()),
  validMatchIds: z.array(z.number().int().positive()),
  missingMatchIds: z.array(z.number().int().positive()),
  invalidMatchIds: z.array(z.number().int().positive()),
  invalidReasons: z.record(z.string(), z.string().min(1)),
}).strict().superRefine((value, ctx) => {
  const groups = [value.expectedMatchIds, value.validMatchIds, value.missingMatchIds, value.invalidMatchIds];
  if (groups.some((g) => JSON.stringify(g) !== JSON.stringify([...new Set(g)].sort((a, b) => a - b))))
    ctx.addIssue({ code: "custom", message: "match identifiers must be sorted and unique" });
  const expected = new Set(value.expectedMatchIds);
  const [valid, missing, invalid] = groups.slice(1).map((g) => new Set(g));
  const union = new Set([...valid, ...missing, ...invalid]);
  const overlaps = [...valid].some((id) => missing.has(id) || invalid.has(id)) || [...missing].some((id) => invalid.has(id));
  if (union.size !== expected.size || ![...union].every((id) => expected.has(id)) || overlaps)
    ctx.addIssue({ code: "custom", message: "coverage match identifiers do not partition expected selection" });
  const reasonKeys = new Set(Object.keys(value.invalidReasons));
  if (reasonKeys.size !== invalid.size || ![...invalid].every((id) => reasonKeys.has(String(id))))
    ctx.addIssue({ code: "custom", message: "invalid reasons must exactly cover invalid matches" });
  const state = expected.size > 0 && valid.size === expected.size ? "complete" : valid.size > 0 ? "partial" : "unavailable";
  if (value.state !== state) ctx.addIssue({ code: "custom", path: ["state"], message: "coverage state contradicts match selection" });
});

const partsMap = z.record(z.enum(PARTS), bodyPartCounts).superRefine((value, ctx) => {
  if (PARTS.some((part) => !(part in value))) ctx.addIssue({ code: "custom", message: "source part taxonomy is invalid" });
});

const source = z.object({
  provider: z.literal("sportsapi"),
  fotmobPlayerId: z.number().int().positive(),
  sourcePlayerId: z.number().int().positive(),
  tournamentId: z.number().int().positive(),
  seasonId: z.number().int().positive(),
  season: z.string().regex(/^20\d{2}\/20\d{2}$/),
  competition: z.string().min(1),
  mappingKey: z.string(),
  coverage, totals, parts: partsMap,
}).strict().superRefine((value, ctx) => {
  if (value.mappingKey !== `${value.fotmobPlayerId}:${value.tournamentId}:${value.seasonId}`) ctx.addIssue({ code: "custom", message: "mapping key contradicts source identity" });
  const unavailable = value.coverage.state === "unavailable";
  // Every one of the five parts' availability must equal the source's own
  // coverage — an unavailable source with a numeric (even zero) part value,
  // or an observed source with a null part, are both malformed. `?? 0` in a
  // later sum would silently treat a wrongly-null part as a real zero
  // instead of catching the mismatch here.
  if ((value.totals.shots === null) !== unavailable || PARTS.some((part) => (value.parts[part].shots === null) !== unavailable))
    ctx.addIssue({ code: "custom", message: "source availability contradicts coverage" });
  if (!unavailable) {
    const shotSum = PARTS.reduce((total, part) => total + value.parts[part].shots!, 0);
    const goalSum = PARTS.reduce((total, part) => total + value.parts[part].goals!, 0);
    if (shotSum !== value.totals.shots || goalSum !== value.totals.goals) ctx.addIssue({ code: "custom", message: "source body-part counts do not reconcile totals" });
    checkQualityChildren(value.totals.quality, PARTS.map((part) => value.parts[part].quality), ctx, "source totals");
  }
});

/**
 * Mirrors `native_body_part_contract.py`'s `_validate_source_context`: a
 * source's own identity must agree with the envelope's requested context,
 * not just the reverse. Every field here is checked against the fixed
 * provider tournament catalog above, never against a value computed from
 * the response itself.
 */
function validateSourceContext(context: { playerId: number; season: string; mode: "league" | "europe"; competition: "all" | "ucl" | "uel" | "uecl" | null }, source: { fotmobPlayerId: number; season: string; competition: string; tournamentId: number }, ctx: z.RefinementCtx) {
  if (source.fotmobPlayerId !== context.playerId || source.season !== context.season) {
    ctx.addIssue({ code: "custom", message: "native source belongs to another player or season" });
    return;
  }
  const catalog = COMPETITION_TOURNAMENTS[source.competition];
  if (!catalog || source.tournamentId !== catalog.tournamentId) {
    ctx.addIssue({ code: "custom", message: "native source competition contradicts tournament identity" });
    return;
  }
  if (context.mode === "league") {
    if (catalog.group !== "domestic") ctx.addIssue({ code: "custom", message: "league context cannot use UEFA source" });
  } else if (catalog.group !== "europe" || (context.competition !== "all" && catalog.code !== context.competition)) {
    ctx.addIssue({ code: "custom", message: "European source contradicts requested competition" });
  }
}

export const nativeBodyPartEnvelopeSchema = z.object({
  schemaVersion: z.literal("native-body-part-stats-v2"),
  context: nativeBoxContext,
  includePenalties: z.boolean(),
  provider: z.literal("sportsapi"),
  completeness: z.enum(["complete", "partial", "unavailable"]),
  sources: z.array(source),
  totals, parts: partsMap,
}).strict().superRefine((value, ctx) => {
  if (PARTS.some((part) => !(part in value.parts))) ctx.addIssue({ code: "custom", message: "envelope part taxonomy is invalid" });
  for (const source of value.sources) validateSourceContext(value.context, source, ctx);
  const keys = value.sources.map((s) => s.mappingKey);
  if (keys.length !== new Set(keys).size) ctx.addIssue({ code: "custom", message: "selected mappings must be unique" });
  const state = value.sources.length === 0 || value.sources.every((s) => s.coverage.state === "unavailable")
    ? "unavailable" : value.sources.every((s) => s.coverage.state === "complete") ? "complete" : "partial";
  if (value.completeness !== state) ctx.addIssue({ code: "custom", message: "envelope completeness contradicts source coverage" });
  const unavailable = state === "unavailable";
  if ((value.totals.shots === null) !== unavailable || PARTS.some((part) => (value.parts[part].shots === null) !== unavailable))
    ctx.addIssue({ code: "custom", message: "envelope availability contradicts source coverage" });
  const observed = value.sources.filter((s) => s.totals.shots !== null);
  if (!unavailable) {
    for (const field of ["admittedShots", "excludedPenaltyShots", "excludedPenaltyGoals", "shots", "goals"] as const) {
      const sum = observed.reduce((total, s) => total + (s.totals[field] ?? 0), 0);
      if (value.totals[field] !== sum) ctx.addIssue({ code: "custom", message: "envelope totals do not reconcile sources" });
    }
    for (const part of PARTS) {
      for (const field of ["shots", "goals"] as const) {
        const sum = observed.reduce((total, s) => total + (s.parts[part]?.[field] ?? 0), 0);
        if (value.parts[part]?.[field] !== sum) ctx.addIssue({ code: "custom", message: "envelope body-part counts do not reconcile sources" });
      }
      // sources.parts[part] → envelope.parts[part] — the FULL source list,
      // not the shots-filtered `observed` above: an unavailable source's own
      // quality.state already excludes it inside checkQualityChildren, so
      // passing the raw list here matches native_body_part_contract.py exactly.
      checkQualityChildren(value.parts[part].quality, value.sources.map((s) => s.parts[part].quality), ctx, `envelope ${part}`);
    }
    // sources.totals → envelope.totals
    checkQualityChildren(value.totals.quality, value.sources.map((s) => s.totals.quality), ctx, "envelope totals (from sources)");
    // envelope.parts → envelope.totals — independently-rounded path, checked
    // separately from the sources.totals path above since the two need not
    // agree past the same rounding tolerance.
    checkQualityChildren(value.totals.quality, PARTS.map((part) => value.parts[part].quality), ctx, "envelope totals (from parts)");
  }
  if (value.includePenalties && value.totals.excludedPenaltyShots !== null && value.totals.excludedPenaltyShots !== 0)
    ctx.addIssue({ code: "custom", message: "included penalties cannot be excluded" });
});

export type NativeBodyPartEnvelope = z.infer<typeof nativeBodyPartEnvelopeSchema>;
export const NATIVE_BODY_PARTS = PARTS;
