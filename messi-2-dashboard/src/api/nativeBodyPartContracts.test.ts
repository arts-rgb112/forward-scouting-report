import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { nativeBodyPartEnvelopeSchema } from "./nativeBodyPartContracts";

// Real reviewed native-body-part-stats-v2 fixtures (BODY_PART_QUALITY_PROPOSAL_20260908.md
// revision2, independent communication_review GO) — read from the shared spec
// location so this test and the backend fixture can never quietly diverge
// into two different "golden" datasets.
const included = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-included-envelope.json", import.meta.url),
  "utf-8",
));
const excluded = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-excluded-envelope.json", import.meta.url),
  "utf-8",
));
// The pre-quality v1 fixtures — kept only to prove the strict v2 decoder now rejects them outright.
const v1Included = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-included.json", import.meta.url),
  "utf-8",
));

describe("native-body-part-stats-v2 contract", () => {
  it("accepts the actual reviewed Kane fixture with penalties included and preserves its golden shots/goals/quality verbatim", () => {
    const parsed = nativeBodyPartEnvelopeSchema.parse(included);
    expect(parsed.totals).toEqual({
      admittedShots: 119, excludedPenaltyShots: 0, excludedPenaltyGoals: 0, shots: 119, goals: 36,
      quality: { xg: 26.4979, xgot: 31.0131, delta: 4.5152, eligible: 118, state: "partial" },
    });
    expect(parsed.parts.head).toEqual({ shots: 15, goals: 3, quality: { xg: 2.7061, xgot: 4.1599, delta: 1.4538, eligible: 15, state: "complete" } });
    expect(parsed.parts.leftFoot).toEqual({ shots: 20, goals: 6, quality: { xg: 3.687, xgot: 5.2205, delta: 1.5335, eligible: 19, state: "partial" } });
    expect(parsed.parts.rightFoot).toEqual({ shots: 84, goals: 27, quality: { xg: 20.1047, xgot: 21.6327, delta: 1.528, eligible: 84, state: "complete" } });
    expect(parsed.includePenalties).toBe(true);
  });

  it("accepts the actual reviewed Kane fixture with penalties excluded — PK 119→108 shots and right-foot quality +1.528→+2.204 transition", () => {
    const parsed = nativeBodyPartEnvelopeSchema.parse(excluded);
    expect(parsed.totals).toEqual({
      admittedShots: 119, excludedPenaltyShots: 11, excludedPenaltyGoals: 10, shots: 108, goals: 26,
      quality: { xg: 17.8255, xgot: 23.0167, delta: 5.1912, eligible: 107, state: "partial" },
    });
    expect(parsed.parts.rightFoot).toEqual({ shots: 73, goals: 17, quality: { xg: 11.4323, xgot: 13.6363, delta: 2.204, eligible: 73, state: "complete" } });
    // head/leftFoot carry no penalties in this fixture, so their quality is unchanged by the PK toggle.
    expect(parsed.parts.head).toEqual(nativeBodyPartEnvelopeSchema.parse(included).parts.head);
    expect(parsed.includePenalties).toBe(false);
  });

  it("rejects a genuine v1 response outright — the strict v2 decoder never treats a missing `quality` object as an old-but-valid shape", () => {
    const result = nativeBodyPartEnvelopeSchema.safeParse(v1Included);
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields — this is a strict envelope, not an extensible one", () => {
    const result = nativeBodyPartEnvelopeSchema.safeParse({ ...included, extra: "not allowed" });
    expect(result.success).toBe(false);
  });

  it("rejects a body-part taxonomy that renames or drops one of the five parts", () => {
    const corrupted = structuredClone(included);
    delete corrupted.parts.unknown;
    corrupted.parts.leftHand = corrupted.parts.other;
    const result = nativeBodyPartEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("rejects envelope body-part counts that do not sum from the sources", () => {
    const corrupted = structuredClone(included);
    corrupted.parts.head.shots = 999;
    const result = nativeBodyPartEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("rejects admittedShots that does not reconcile shots + excludedPenaltyShots", () => {
    const corrupted = structuredClone(excluded);
    corrupted.totals.admittedShots = 200;
    corrupted.sources[0].totals.admittedShots = 200;
    const result = nativeBodyPartEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("rejects includePenalties:true carrying nonzero excludedPenaltyShots — penalties cannot be simultaneously included and excluded", () => {
    const corrupted = structuredClone(excluded);
    corrupted.includePenalties = true;
    const result = nativeBodyPartEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("accepts a fully unavailable envelope with every field — including quality — null, never fabricated zeros", () => {
    const unavailableQuality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const };
    const unavailableTotals = { admittedShots: null, excludedPenaltyShots: null, excludedPenaltyGoals: null, shots: null, goals: null, quality: unavailableQuality };
    const unavailableParts = Object.fromEntries(["head", "leftFoot", "rightFoot", "other", "unknown"].map((part) => [part, { shots: null, goals: null, quality: unavailableQuality }]));
    const envelope = { ...included, completeness: "unavailable", sources: [], totals: unavailableTotals, parts: unavailableParts };
    expect(nativeBodyPartEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("rejects a goal count exceeding its own shot count within one body part", () => {
    const corrupted = structuredClone(included);
    corrupted.parts.other = { shots: 0, goals: 1, quality: corrupted.parts.other.quality };
    const result = nativeBodyPartEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("rejects an unavailable source that still carries a numeric (even zero) part value", () => {
    const corrupted = structuredClone(included);
    const unavailableQuality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const };
    corrupted.sources[0].coverage.state = "unavailable";
    corrupted.sources[0].coverage.validMatchIds = [];
    corrupted.sources[0].coverage.missingMatchIds = corrupted.sources[0].coverage.expectedMatchIds;
    corrupted.sources[0].totals = { admittedShots: null, excludedPenaltyShots: null, excludedPenaltyGoals: null, shots: null, goals: null, quality: unavailableQuality };
    // every part must go null with the source — leaving one at a real zero is the exact bug `?? 0` let through
    corrupted.sources[0].parts.other = { shots: 0, goals: 0, quality: { xg: 0, xgot: 0, delta: 0, eligible: 0, state: "complete" } };
    corrupted.sources[0].parts.head = { shots: null, goals: null, quality: unavailableQuality };
    corrupted.sources[0].parts.leftFoot = { shots: null, goals: null, quality: unavailableQuality };
    corrupted.sources[0].parts.rightFoot = { shots: null, goals: null, quality: unavailableQuality };
    corrupted.sources[0].parts.unknown = { shots: null, goals: null, quality: unavailableQuality };
    expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects an observed source that leaves one part null instead of an actual zero", () => {
    const corrupted = structuredClone(included);
    corrupted.sources[0].parts.other = { shots: null, goals: null, quality: { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" } };
    const result = nativeBodyPartEnvelopeSchema.safeParse(corrupted);
    expect(result.success).toBe(false);
  });

  it("still accepts a genuinely observed part that is a real numeric zero (not the malformed null case above)", () => {
    const parsed = nativeBodyPartEnvelopeSchema.parse(included);
    expect(parsed.parts.other).toEqual({ shots: 0, goals: 0, quality: { xg: 0, xgot: 0, delta: 0, eligible: 0, state: "complete" } });
  });

  it("rejects a source whose fotmobPlayerId or season does not match the requested context", () => {
    const wrongPlayer = structuredClone(included);
    wrongPlayer.sources[0].fotmobPlayerId = 1;
    wrongPlayer.sources[0].mappingKey = `1:${wrongPlayer.sources[0].tournamentId}:${wrongPlayer.sources[0].seasonId}`;
    expect(nativeBodyPartEnvelopeSchema.safeParse(wrongPlayer).success).toBe(false);

    const wrongSeason = structuredClone(included);
    wrongSeason.sources[0].season = "2024/2025";
    expect(nativeBodyPartEnvelopeSchema.safeParse(wrongSeason).success).toBe(false);
  });

  it("rejects a source whose competition label contradicts its own tournamentId (Bundesliga label, UCL id)", () => {
    const corrupted = structuredClone(included);
    corrupted.sources[0].tournamentId = 7; // UEFA Champions League's real id, under the "Bundesliga" label
    corrupted.sources[0].mappingKey = `${corrupted.sources[0].fotmobPlayerId}:7:${corrupted.sources[0].seasonId}`;
    expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a source competition label absent from the fixed 11-tournament catalog", () => {
    const corrupted = structuredClone(included);
    corrupted.sources[0].competition = "Regional Cup";
    expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a league-mode context sourced from a UEFA competition", () => {
    const corrupted = structuredClone(included);
    corrupted.sources[0].competition = "UEFA Champions League";
    corrupted.sources[0].tournamentId = 7;
    corrupted.sources[0].mappingKey = `${corrupted.sources[0].fotmobPlayerId}:7:${corrupted.sources[0].seasonId}`;
    expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false); // context.mode is "league"
  });

  it("rejects a europe-mode context whose source is a different UEFA competition than the one selected", () => {
    const corrupted = structuredClone(included);
    corrupted.context = { ...corrupted.context, mode: "europe", scope: null, competition: "ucl" };
    corrupted.sources[0].competition = "UEFA Europa League"; // requested ucl, source is uel
    corrupted.sources[0].tournamentId = 679;
    corrupted.sources[0].mappingKey = `${corrupted.sources[0].fotmobPlayerId}:679:${corrupted.sources[0].seasonId}`;
    expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  describe("quality — xGOT−xG on paired native xg/xgot", () => {
    it("accepts a partial-eligible part unchanged — leftFoot's own unpaired shot (19/20 eligible) never blocks acceptance", () => {
      const parsed = nativeBodyPartEnvelopeSchema.parse(included);
      expect(parsed.parts.leftFoot.quality).toEqual({ xg: 3.687, xgot: 5.2205, delta: 1.5335, eligible: 19, state: "partial" });
    });

    it("rejects a quality.delta that does not equal round(xgot - xg, 4)", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality.delta = 99;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects quality.eligible exceeding the row's own shots", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality.eligible = 16; // head has only 15 shots
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects a negative quality.eligible", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality.eligible = -1;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects state 'complete' claimed alongside a partial eligible count (eligible < shots)", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.leftFoot.quality.state = "complete"; // real eligible is 19 of 20
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects state 'unavailable' declared alongside a nonzero eligible count — unavailable means zero paired shots, not merely unreported", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality.state = "unavailable";
      // head really did have 15/15 eligible pairs — claiming "unavailable" while still reporting a nonzero eligible count is self-contradictory
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects an observed nonzero-shot part with paired zero shots claiming state complete instead of unavailable", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality = { xg: null, xgot: null, delta: null, eligible: 0, state: "complete" };
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects a zero-shot part (real observed zero) whose quality is anything but an honest complete zero", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.other.quality.state = "unavailable";
      corrupted.parts.other.quality.eligible = null;
      corrupted.parts.other.quality.xg = null;
      corrupted.parts.other.quality.xgot = null;
      corrupted.parts.other.quality.delta = null;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects an unobserved (null-shots) part carrying anything but unavailable quality", () => {
      const unavailableEnvelope = structuredClone(included);
      unavailableEnvelope.completeness = "unavailable";
      unavailableEnvelope.sources = [];
      const unavailableQuality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const };
      unavailableEnvelope.totals = { admittedShots: null, excludedPenaltyShots: null, excludedPenaltyGoals: null, shots: null, goals: null, quality: unavailableQuality };
      unavailableEnvelope.parts = Object.fromEntries(["head", "leftFoot", "rightFoot", "other", "unknown"].map((part) => [part, { shots: null, goals: null, quality: unavailableQuality }]));
      // now corrupt just one part to claim a real (nonzero-state) quality despite null shots
      unavailableEnvelope.parts.head = { shots: null, goals: null, quality: { xg: 1, xgot: 2, delta: 1, eligible: 1, state: "complete" } };
      expect(nativeBodyPartEnvelopeSchema.safeParse(unavailableEnvelope).success).toBe(false);
    });

    it("accepts a negative quality.delta (a body part performing worse than its shot quality) without treating the sign as an error", () => {
      // A single-source fixture — head's new xg/xgot must be threaded through
      // both the source row and every ancestor sum (source totals, envelope
      // part, envelope totals) or the new cross-level reconciliation below
      // would (correctly) reject this as a sum mismatch instead of proving
      // the actual thing under test: that a negative sign alone is not an error.
      const corrupted = structuredClone(included);
      const negativeHead = { xg: 5, xgot: 3, delta: -2, eligible: 15, state: "complete" as const };
      corrupted.parts.head.quality = negativeHead;
      corrupted.sources[0].parts.head.quality = negativeHead;
      const xgDelta = negativeHead.xg - included.parts.head.quality.xg;
      const xgotDelta = negativeHead.xgot - included.parts.head.quality.xgot;
      const newTotalsQuality = {
        ...included.totals.quality,
        xg: Math.round((included.totals.quality.xg + xgDelta) * 1e4) / 1e4,
        xgot: Math.round((included.totals.quality.xgot + xgotDelta) * 1e4) / 1e4,
      };
      newTotalsQuality.delta = Math.round((newTotalsQuality.xgot - newTotalsQuality.xg) * 1e4) / 1e4;
      corrupted.totals.quality = newTotalsQuality;
      corrupted.sources[0].totals.quality = newTotalsQuality; // single source, so its totals mirror the envelope's exactly
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(true);
    });

    it("rejects negative xg/xgot — a shot-quality score can never be negative, unlike delta", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality.xg = -1;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);

      const corruptedXgot = structuredClone(included);
      corruptedXgot.parts.head.quality.xgot = -1;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corruptedXgot).success).toBe(false);
    });

    it("accepts the genuine no-pair shape — real shots but zero paired metrics — distinct from a never-observed row", () => {
      // shots > 0, eligible 0, state unavailable, every metric null: this is
      // the exact shape the standalone quality-object check previously (and
      // wrongly) rejected by requiring eligible itself to be null too.
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality = { xg: null, xgot: null, delta: null, eligible: 0, state: "unavailable" };
      // head no longer contributes any paired shots — its old sum share must be removed from every ancestor.
      const removedHead = included.parts.head.quality;
      const newTotalsQuality = {
        xg: Math.round((included.totals.quality.xg - removedHead.xg) * 1e4) / 1e4,
        xgot: Math.round((included.totals.quality.xgot - removedHead.xgot) * 1e4) / 1e4,
        eligible: included.totals.quality.eligible - removedHead.eligible,
        state: "partial" as const, delta: 0,
      };
      newTotalsQuality.delta = Math.round((newTotalsQuality.xgot - newTotalsQuality.xg) * 1e4) / 1e4;
      corrupted.totals.quality = newTotalsQuality;
      corrupted.sources[0].parts.head.quality = corrupted.parts.head.quality;
      corrupted.sources[0].totals.quality = newTotalsQuality;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(true);
    });

    it("rejects an envelope part quality whose eligible does not sum exactly from its own contributing sources", () => {
      const corrupted = structuredClone(included);
      // still internally consistent with its own shots (15, partial coverage) — only the
      // cross-level sum against the real single source (which still reports eligible 15) is wrong.
      corrupted.parts.head.quality.eligible = 14;
      corrupted.parts.head.quality.state = "partial";
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("rejects an envelope totals.quality.xg that drifts from the sum of its parts beyond the documented rounding tolerance", () => {
      const corrupted = structuredClone(included);
      corrupted.totals.quality.xg = included.totals.quality.xg + 1; // real per-part sum is off by a whole 1.0, far past (childCount+1)*0.00005+1e-9
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("accepts source-level completeness partial coexisting with that same source's quality complete — the two coverages are independent", () => {
      // The real fixture already carries this exact valid combination: leftFoot's OWN metric
      // pairing is partial while its shots/goals source coverage is complete — prove the
      // reverse direction (source partial, quality complete) also decodes as valid by
      // constructing a source whose match coverage is partial but whose sole paired part is
      // a full complete-quality zero, and confirming this is not rejected.
      const corrupted = structuredClone(included);
      const source = corrupted.sources[0];
      expect(source.coverage.state).toBe("complete");
      source.coverage.state = "partial";
      source.coverage.validMatchIds = source.coverage.expectedMatchIds.slice(0, -1);
      source.coverage.missingMatchIds = source.coverage.expectedMatchIds.slice(-1);
      corrupted.completeness = "partial";
      // source totals/parts stay fully observed (their own quality.state values are untouched,
      // e.g. head/rightFoot remain "complete") — only the match-coverage flag changed.
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(true);
    });

    // Four minimal regressions requested by an independent forward review of
    // this exact decoder, each isolating one specific mismatch against
    // native_body_part_contract.py's own _check_quality_for_shots /
    // _check_quality_children (SHA256 1731D08469EEBDE1C86CBB889FDD2EBDAEAEF4C07447AB0F0ECEFC63BF94491A).

    it("[A] rejects a fully-unavailable source whose quality reports eligible 0 instead of null", () => {
      const corrupted = structuredClone(included);
      const unavailableCoverage = { state: "unavailable" as const, expectedMatchIds: [], validMatchIds: [], missingMatchIds: [], invalidMatchIds: [], invalidReasons: {} };
      const nullTotals = { admittedShots: null, excludedPenaltyShots: null, excludedPenaltyGoals: null, shots: null, goals: null };
      corrupted.completeness = "unavailable";
      corrupted.sources = [{
        ...corrupted.sources[0], coverage: unavailableCoverage, totals: { ...nullTotals, quality: { xg: null, xgot: null, delta: null, eligible: 0, state: "unavailable" } },
        parts: Object.fromEntries(["head", "leftFoot", "rightFoot", "other", "unknown"].map((part) => [part, { shots: null, goals: null, quality: { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" } }])),
      }];
      corrupted.totals = { ...nullTotals, quality: { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" } };
      corrupted.parts = Object.fromEntries(["head", "leftFoot", "rightFoot", "other", "unknown"].map((part) => [part, { shots: null, goals: null, quality: { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" } }]));
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("[B] rejects observed shots (>0) with no paired metrics whose eligible is null instead of exactly 0", () => {
      const corrupted = structuredClone(included);
      corrupted.parts.head.quality = { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" };
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("[C] rejects source+envelope totals declaring unavailable/eligible-0 while their own parts still report real paired shots", () => {
      const corrupted = structuredClone(included);
      const unavailableZero = { xg: null, xgot: null, delta: null, eligible: 0, state: "unavailable" as const };
      // parts keep their real (paired) quality untouched — only totals lie about having nothing paired.
      corrupted.totals.quality = unavailableZero;
      corrupted.sources[0].totals.quality = unavailableZero;
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });

    it("[D] does not let an added unavailable sibling source widen the rounding tolerance for the real sources", () => {
      // A drift of 0.00012 sits OUTSIDE the real single-source tolerance
      // ((1+1)*0.00005+1e-9 ≈ 0.0001) but INSIDE what a (wrongly) inflated
      // 2-child tolerance would allow ((2+1)*0.00005+1e-9 ≈ 0.00015) — so
      // this specific size only rejects correctly if the phantom source
      // does NOT count toward the tolerance's child count. No 4-decimal
      // rounding here on purpose: it would collapse this sub-0.0001 offset.
      const corrupted = structuredClone(included);
      corrupted.totals.quality.xg = included.totals.quality.xg + 0.00012;
      const phantomSource = {
        ...included.sources[0], mappingKey: `${included.sources[0].fotmobPlayerId}:7:${included.sources[0].seasonId}`, tournamentId: 7, competition: "UEFA Champions League",
        coverage: { state: "unavailable" as const, expectedMatchIds: [], validMatchIds: [], missingMatchIds: [], invalidMatchIds: [], invalidReasons: {} },
        totals: { admittedShots: null, excludedPenaltyShots: null, excludedPenaltyGoals: null, shots: null, goals: null, quality: { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const } },
        parts: Object.fromEntries(["head", "leftFoot", "rightFoot", "other", "unknown"].map((part) => [part, { shots: null, goals: null, quality: { xg: null, xgot: null, delta: null, eligible: null, state: "unavailable" as const } }])),
      };
      corrupted.context = { ...corrupted.context, mode: "europe" as const, scope: null, competition: "all" as const };
      corrupted.sources[0].competition = "UEFA Europa League"; corrupted.sources[0].tournamentId = 679;
      corrupted.sources[0].mappingKey = `${corrupted.sources[0].fotmobPlayerId}:679:${corrupted.sources[0].seasonId}`;
      corrupted.completeness = "partial"; // one complete real source + one unavailable phantom source
      corrupted.sources = [corrupted.sources[0], phantomSource];
      expect(nativeBodyPartEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    });
  });
});
