import { describe, expect, it } from "vitest";
import { fullActivityHeatmapEnvelopeSchema } from "./fullActivityHeatmapContracts";

const fixture = () => ({
  schemaVersion: "1.0.0", heatmapTaxonomyVersion: "full-activity-heatmap-v1",
  context: { playerId: 194165, idNamespace: "fotmob", season: "2025/2026", mode: "league", scope: 7, competition: null },
  data: { available: true, reason: null, definitionVersion: "full-tier3-count-weighted-histogram-32x22-v1", columns: 32, rows: 22, cellCounts: [1401, ...new Array(703).fill(0)], validPointCount: 1401, activitySnapshotCount: 1, sourceDefinitionVersion: "sportsapi-heatmap-points-count-weighted-full-v1" },
});

describe("full activity heatmap contract", () => {
  it("accepts an exact count-reconciling 704-cell histogram", () => expect(fullActivityHeatmapEnvelopeSchema.safeParse(fixture()).success).toBe(true));
  it("rejects a histogram whose count differs from provenance", () => { const value = fixture(); value.data.validPointCount = 1400; expect(fullActivityHeatmapEnvelopeSchema.safeParse(value).success).toBe(false); });
});
