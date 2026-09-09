import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fullActivityDisplayEnvelopeSchema } from "./fullActivityDisplayContracts";

// Backend-owned scalar evidence for the real Kane selection. It deliberately
// contains only immutable CCA acceptance values, so this test supplies the
// 704-cell transport shell without deriving any display statistic.
const kaneEvidence = JSON.parse(readFileSync(
  new URL("../../../docs/fixtures/full_activity_display_v1/kane_2025_2026_expected.json", import.meta.url),
  "utf-8",
));

export function fullActivityDisplayFixture() {
  const evidence = kaneEvidence.fullSourceCca;
  return {
    schemaVersion: "full-activity-display-v1",
    context: kaneEvidence.context,
    fullHeat: {
      available: true,
      reason: null,
      definitionVersion: "full-tier3-count-weighted-histogram-32x22-v1",
      columns: 32,
      rows: 22,
      cellCounts: [evidence.validPointCount, ...new Array(703).fill(0)],
      validPointCount: evidence.validPointCount,
      activitySnapshotCount: 1,
      sourceDefinitionVersion: "sportsapi-heatmap-points-count-weighted-full-v1",
    },
    fullSourceCca: {
      available: true,
      reason: null,
      definitionVersion: evidence.definitionVersion,
      formulaVersion: evidence.formulaVersion,
      inputDefinition: evidence.inputDefinition,
      heatmapDefinition: evidence.heatmapDefinition,
      sourceRevision: evidence.sourceRevision,
      coverage: { expectedKeys: evidence.expectedKeys, observedKeys: evidence.expectedKeys, missingKeys: [] },
      gridColumns: 32,
      gridRows: 22,
      validPointCount: evidence.validPointCount,
      standardizedTarget: evidence.standardizedTarget,
      densityThreshold: evidence.densityThreshold,
      thresholdOfPeak: evidence.thresholdOfPeak,
      coreAreaPct: evidence.coreAreaPct,
      ccaAreaPct: evidence.coreAreaPct,
      containedMassPct: evidence.containedMassPct,
      lowSample: evidence.lowSample,
    },
  };
}

describe("full-activity-display-v1 contract", () => {
  it("accepts the real Kane CCA fixture values with an exact 704-cell display transport", () => {
    const parsed = fullActivityDisplayEnvelopeSchema.parse(fullActivityDisplayFixture());
    expect(parsed.fullHeat.cellCounts).toHaveLength(704);
    expect(parsed.fullSourceCca.sourceRevision).toBe("87b0d583a5d62b92abf2169476353032e5ef1a174faf04c07dc4a6d6eff2fbf0");
    expect(parsed.fullSourceCca.thresholdOfPeak).toBe(0.48658798);
    expect(parsed.fullSourceCca.densityThreshold).toBe(3.54296875);
    expect(parsed.fullSourceCca.ccaAreaPct).toBe(15.483);
  });

  it("rejects unknown display fields and a full-grid count mismatch", () => {
    const unknown = { ...fullActivityDisplayFixture(), clientCca: 1 };
    expect(fullActivityDisplayEnvelopeSchema.safeParse(unknown).success).toBe(false);

    const wrongCounts = fullActivityDisplayFixture();
    wrongCounts.fullHeat.validPointCount -= 1;
    expect(fullActivityDisplayEnvelopeSchema.safeParse(wrongCounts).success).toBe(false);
  });

  it("rejects CCA availability that hides missing raw-source coverage or mismatches the full grid", () => {
    const missingSource = fullActivityDisplayFixture();
    missingSource.fullSourceCca.coverage.observedKeys = [];
    missingSource.fullSourceCca.coverage.missingKeys = [...missingSource.fullSourceCca.coverage.expectedKeys];
    expect(fullActivityDisplayEnvelopeSchema.safeParse(missingSource).success).toBe(false);

    const wrongCcaCount = fullActivityDisplayFixture();
    wrongCcaCount.fullSourceCca.validPointCount -= 1;
    expect(fullActivityDisplayEnvelopeSchema.safeParse(wrongCcaCount).success).toBe(false);
  });

  it("accepts only an explicit fail-closed unavailable CCA state", () => {
    const unavailable = fullActivityDisplayFixture();
    unavailable.fullSourceCca = {
      ...unavailable.fullSourceCca,
      available: false,
      reason: "full_source_grid_mismatch",
      validPointCount: 0,
      standardizedTarget: null,
      densityThreshold: null,
      thresholdOfPeak: null,
      coreAreaPct: null,
      ccaAreaPct: null,
      containedMassPct: null,
    };
    expect(fullActivityDisplayEnvelopeSchema.safeParse(unavailable).success).toBe(true);

    unavailable.fullSourceCca.densityThreshold = 3.5;
    expect(fullActivityDisplayEnvelopeSchema.safeParse(unavailable).success).toBe(false);
  });
});
