import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { nativePitchEventsEnvelopeSchema } from "./nativePitchEventsContracts";

// Real, independently-reviewed canonical-v2 fixtures — the corrected lateral
// (left/right) mapping. The superseded native-pitch-http-20260908-v1 fixture
// had the wrong rotation and must never be consumed for UI or evidence.
const included = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/included.json", import.meta.url),
  "utf-8",
));
const excluded = JSON.parse(readFileSync(
  new URL("../../../../messi-specs/evidence/native-pitch-http-20260908-canonical-v2/excluded.json", import.meta.url),
  "utf-8",
));

function findEvent(envelope: typeof included, matchId: number, shotId: number) {
  return envelope.events.find((event: { identity: { matchId: number; shotId: number } }) => event.identity.matchId === matchId && event.identity.shotId === shotId);
}

describe("native-pitch-events-v1 contract", () => {
  it("accepts the real reviewed included fixture — 119 events, 36 goals, bodyParts/box embedded in the same bundle", () => {
    const parsed = nativePitchEventsEnvelopeSchema.parse(included);
    expect(parsed.events).toHaveLength(119);
    expect(parsed.events.filter((event) => event.shotType === "goal")).toHaveLength(36);
    expect(parsed.bodyParts.totals.shots).toBe(119);
    expect(parsed.bodyParts.totals.goals).toBe(36);
    expect(parsed.includePenalties).toBe(true);
  });

  it("accepts the real excluded fixture — PK filtered out of both events and the embedded bodyParts/box in the same way", () => {
    const parsed = nativePitchEventsEnvelopeSchema.parse(excluded);
    expect(parsed.events).toHaveLength(108);
    expect(parsed.bodyParts.totals.shots).toBe(108);
    expect(parsed.bodyParts.totals.goals).toBe(26);
    expect(parsed.includePenalties).toBe(false);
  });

  it("reproduces the three independently-audited real identity vectors exactly (bodyPart, origin, and goal-plane destination)", () => {
    const parsed = nativePitchEventsEnvelopeSchema.parse(included);
    const leftFootGoal = findEvent(included, 14056037, 5473386);
    expect(leftFootGoal).toBeTruthy();
    const decodedLeft = parsed.events.find((e) => e.identity.matchId === 14056037 && e.identity.shotId === 5473386)!;
    expect(decodedLeft.bodyPart).toBe("leftFoot");
    expect(decodedLeft.plot).toEqual({ state: "projected", x: 92, y: 62.2, reason: null });
    expect(decodedLeft.destination).toEqual({ kind: "goal_plane_projection", x: 100, y: 45.7, observedHeightMeters: null, reason: null });

    const decodedRight = parsed.events.find((e) => e.identity.matchId === 14056037 && e.identity.shotId === 5473363)!;
    expect(decodedRight.bodyPart).toBe("rightFoot");
    expect(decodedRight.plot).toEqual({ state: "projected", x: 85, y: 71.9, reason: null });
    expect(decodedRight.destination.y).toBe(45.8);

    const decodedHead = parsed.events.find((e) => e.identity.matchId === 14062150 && e.identity.shotId === 6390845)!;
    expect(decodedHead.bodyPart).toBe("head");
    expect(decodedHead.shotType).toBe("save");
    expect(decodedHead.outcome).toBe("on_target");
    expect(decodedHead.plot).toEqual({ state: "projected", x: 91.5, y: 56.6, reason: null });
    expect(decodedHead.destination.y).toBe(51.2);
  });

  it("reconstructs each event's own key from its identity — a mismatched key is rejected", () => {
    const corrupted = structuredClone(included);
    corrupted.events[0].key = "sportsapi:999:1:1:1:1";
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a duplicate event identity even with an otherwise-identical payload", () => {
    const corrupted = structuredClone(included);
    corrupted.events.push({ ...corrupted.events[0] });
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects an outcome that contradicts its own shotType (deterministic goal/save/miss,post/block map)", () => {
    const corrupted = structuredClone(included);
    corrupted.events[0] = { ...corrupted.events[0], shotType: "save", outcome: "goal" };
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a block event whose destination kind is goal_plane_projection — block destinations are only block_projection or unavailable", () => {
    const corrupted = structuredClone(included);
    const blockEvent = corrupted.events.find((e: { shotType: string }) => e.shotType === "block");
    expect(blockEvent).toBeTruthy();
    blockEvent.destination = { kind: "goal_plane_projection", x: 100, y: 50, observedHeightMeters: null, reason: null };
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a goal_plane_projection destination whose x is not exactly 100", () => {
    const corrupted = structuredClone(included);
    corrupted.events[0].destination = { kind: "goal_plane_projection", x: 99.9, y: 50, observedHeightMeters: null, reason: null };
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a destination that smuggles a real observedHeightMeters value — this schema requires it always null", () => {
    const corrupted = structuredClone(included);
    corrupted.events[0].destination = { ...corrupted.events[0].destination, observedHeightMeters: 1.8 };
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("accepts a real unlocated plot (null coordinates, a real reason) and rejects a projected plot missing its reason-null invariant", () => {
    // event[0] is a real non-penalty L3R shot (x86.4,y43.2) in this fixture — moving it to
    // unlocated must also move its own share out of L3R and into the unlocated bucket to stay
    // internally consistent under the new event↔box reconciliation (denominator is unaffected:
    // it counts all non-penalty shots regardless of location).
    const unlocated = structuredClone(included);
    unlocated.events[0] = { ...unlocated.events[0], plot: { state: "unlocated", x: null, y: null, reason: "missing source coordinates" } };
    unlocated.box.regions.L3R.shots -= 1;
    unlocated.box.accounting.unlocated.shots += 1;
    expect(nativePitchEventsEnvelopeSchema.safeParse(unlocated).success).toBe(true);

    const brokenProjected = structuredClone(included);
    brokenProjected.events[0] = { ...brokenProjected.events[0], plot: { state: "projected", x: 50, y: 50, reason: "should be null" } };
    expect(nativePitchEventsEnvelopeSchema.safeParse(brokenProjected).success).toBe(false);
  });

  it("rejects unknown fields anywhere in the envelope — this is a strict, non-extensible contract", () => {
    const corrupted = { ...included, extra: "not allowed" };
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects negative or non-finite xg/xgot on an event", () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const corrupted = structuredClone(included);
      corrupted.events[0].xg = bad;
      expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
    }
  });

  it("rejects an envelope whose embedded bodyParts PK filter or context contradicts the envelope's own", () => {
    const wrongFilter = structuredClone(included);
    wrongFilter.bodyParts.includePenalties = false; // envelope itself says true
    expect(nativePitchEventsEnvelopeSchema.safeParse(wrongFilter).success).toBe(false);

    const wrongContext = structuredClone(included);
    wrongContext.bodyParts.context.playerId = 1;
    expect(nativePitchEventsEnvelopeSchema.safeParse(wrongContext).success).toBe(false);
  });

  it("decodes real box regions with their own id/label/bounds/shootingSharePct fields alongside the shared summary fields — not a broken strict-intersection shape", () => {
    const parsed = nativePitchEventsEnvelopeSchema.parse(included);
    expect(parsed.box.regions.L3L.id).toBe("L3L");
    expect(parsed.box.regions.L3L.label.length).toBeGreaterThan(0);
    expect(parsed.box.regions.L3L.shots).toBeGreaterThan(0);
    expect(typeof parsed.box.regions.L3L.shootingSharePct).toBe("number");
  });

  it("rejects an envelope whose events are not in deterministic (mappingKey, matchId, shotId) order", () => {
    const corrupted = structuredClone(included);
    [corrupted.events[0], corrupted.events[1]] = [corrupted.events[1], corrupted.events[0]];
    // only reorder if this actually produces an out-of-order pair (real fixture ordering may already differ)
    const a = `${corrupted.events[0].identity.mappingKey}:${corrupted.events[0].identity.matchId}:${corrupted.events[0].identity.shotId}`;
    const b = `${corrupted.events[1].identity.mappingKey}:${corrupted.events[1].identity.matchId}:${corrupted.events[1].identity.shotId}`;
    if (a > b) expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects bodyParts.parts counts that do not reconcile from the raw event list", () => {
    const corrupted = structuredClone(included);
    corrupted.bodyParts.parts.head.shots = corrupted.bodyParts.parts.head.shots + 1;
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a box.denominator that does not reconcile from the raw non-penalty event count", () => {
    const corrupted = structuredClone(included);
    corrupted.box.denominator = corrupted.box.denominator + 1;
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects an event whose matchId falls outside bodyParts' own validMatchIds coverage", () => {
    const corrupted = structuredClone(included);
    corrupted.events[0] = { ...corrupted.events[0], identity: { ...corrupted.events[0].identity, matchId: 99999999 }, key: corrupted.events[0].key.replace(/:\d+:\d+$/, `:99999999:${corrupted.events[0].identity.shotId}`) };
    expect(nativePitchEventsEnvelopeSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects an events list emptied out without also updating bodyParts/box — the new event↔aggregate reconciliation catches exactly this forgery", () => {
    // Proves the reconciliation added above actually runs: a naively-emptied `events` array with
    // its bodyParts/box aggregates left at the real fixture's nonzero totals must be rejected.
    const forged = { ...structuredClone(included), events: [] };
    expect(nativePitchEventsEnvelopeSchema.safeParse(forged).success).toBe(false);
  });
});
