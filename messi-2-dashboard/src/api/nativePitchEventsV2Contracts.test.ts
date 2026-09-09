import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NATIVE_PITCH_V2_BOX_ZONE_IDS,
  NATIVE_PITCH_V2_GRID_ZONE_IDS,
  nativePitchEventsV2EnvelopeSchema,
} from "./nativePitchEventsV2Contracts";

const canonicalFixture = JSON.parse(readFileSync(
  new URL("../../../docs/fixtures/native_pitch_v2/canonical_response.json", import.meta.url),
  "utf-8",
));
const terminalCases = JSON.parse(readFileSync(
  new URL("../../../docs/fixtures/native_pitch_v2/source_terminal_cases.json", import.meta.url),
  "utf-8",
));

describe("native-pitch-events-v2 contract", () => {
  it("keeps raw provider precision distinct from four-decimal paired quality", () => {
    const packet = structuredClone(canonicalFixture);
    const event = packet.events.find((item: {xg: number | null; xgot: number | null}) => item.xg !== null && item.xgot !== null);
    event.xg = event.quality.xg + 0.00001;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(packet).success).toBe(true);
    event.xg = event.quality.xg + 0.00006;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(packet).success).toBe(false);
  });
  it("accepts the canonical strict-builder response and its exact 30+4 selection taxonomy", () => {
    const parsed = nativePitchEventsV2EnvelopeSchema.parse(canonicalFixture);
    expect(parsed.schemaVersion).toBe("native-pitch-events-v2");
    expect(parsed.selectionZones.grid.map((zone) => zone.id)).toEqual(NATIVE_PITCH_V2_GRID_ZONE_IDS);
    expect(parsed.selectionZones.box.map((zone) => zone.id)).toEqual(NATIVE_PITCH_V2_BOX_ZONE_IDS);
    expect(parsed.selectionZones.grid).toHaveLength(30);
    expect(parsed.selectionZones.box).toHaveLength(4);
  });

  it("preserves every reviewed source-terminal case without inventing a miss/post terminal", () => {
    const parsed = nativePitchEventsV2EnvelopeSchema.parse(canonicalFixture);
    for (const fixtureCase of terminalCases.cases) {
      // The canonical envelope is built from a deterministic fixture source
      // whose synthetic match identity is `1`; shot IDs remain the reviewed
      // native vectors from `source_terminal_cases.json`.
      const event = parsed.events.find((entry) => entry.identity.shotId === fixtureCase.shotId);
      expect(event).toBeDefined();
      expect(event?.shotType).toBe(fixtureCase.shotType);
      expect(event?.destination.kind).toBe(fixtureCase.expectedKind);
      if (fixtureCase.expectedKind === "unavailable") {
        expect(event?.destination.x).toBeNull();
        expect(event?.destination.y).toBeNull();
        expect(event?.destination.reason).toBe(fixtureCase.expectedReason);
      } else {
        expect(event?.destination.x).toBe(fixtureCase.expectedX ?? 100);
        expect(event?.destination.y).toBe(fixtureCase.expectedY);
      }
    }
  });

  it("rejects a wrong schema version and unknown envelope fields", () => {
    const wrongVersion = structuredClone(canonicalFixture);
    wrongVersion.schemaVersion = "native-pitch-events-v1";
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(wrongVersion).success).toBe(false);

    const unknownField = { ...canonicalFixture, untrustedClientAggregate: true };
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(unknownField).success).toBe(false);

    const nestedUnknownField = structuredClone(canonicalFixture);
    nestedUnknownField.selectionZones.grid[0].untrustedClientAggregate = true;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(nestedUnknownField).success).toBe(false);
  });

  it("rejects a terminal kind or goal-plane coordinate that contradicts its source shot type", () => {
    const malformedKind = structuredClone(canonicalFixture);
    const goal = malformedKind.events.find((event: { shotType: string }) => event.shotType === "goal");
    expect(goal).toBeDefined();
    goal.destination = { kind: "block", x: 99, y: 50, observedHeightMeters: null, reason: null };
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(malformedKind).success).toBe(false);

    const malformedGoalLine = structuredClone(canonicalFixture);
    const goalLine = malformedGoalLine.events.find((event: { shotType: string }) => event.shotType === "goal");
    expect(goalLine).toBeDefined();
    goalLine.destination = { kind: "goal_plane", x: 99.9, y: 50, observedHeightMeters: null, reason: null };
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(malformedGoalLine).success).toBe(false);
  });

  it("rejects tampered event-to-body-part, 30-grid, and non-PK box reconciliations", () => {
    const wrongParts = structuredClone(canonicalFixture);
    wrongParts.bodyParts.parts.head.shots += 1;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(wrongParts).success).toBe(false);

    const wrongGrid = structuredClone(canonicalFixture);
    wrongGrid.selectionZones.gridAccounting.assigned += 1;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(wrongGrid).success).toBe(false);

    const wrongBox = structuredClone(canonicalFixture);
    wrongBox.selectionZones.boxAccounting.denominator += 1;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(wrongBox).success).toBe(false);
  });

  it("rejects a body summary context/PK filter that does not match the event response", () => {
    const wrongContext = structuredClone(canonicalFixture);
    wrongContext.bodyParts.context.playerId += 1;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(wrongContext).success).toBe(false);

    const wrongPenaltyFilter = structuredClone(canonicalFixture);
    wrongPenaltyFilter.bodyParts.includePenalties = !wrongPenaltyFilter.includePenalties;
    expect(nativePitchEventsV2EnvelopeSchema.safeParse(wrongPenaltyFilter).success).toBe(false);
  });
});
