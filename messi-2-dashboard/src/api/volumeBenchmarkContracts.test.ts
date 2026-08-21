import { describe, expect, it } from "vitest";

import { observedZeroFixture, successFixture, unavailableFixture } from "../test/volumeBenchmarkFixtures";
import { volumeBenchmarkEnvelopeSchema } from "./volumeBenchmarkContracts";

describe("volume benchmark contract", () => {
  it("parses every canonical backend fixture", () => {
    for (const fixture of [successFixture, unavailableFixture, observedZeroFixture]) {
      expect(volumeBenchmarkEnvelopeSchema.parse(fixture).schemaVersion).toBe("1.0.0");
    }
  });

  it("rejects source-context extras, wrong axis order, and non-canonical benchmark scope", () => {
    expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...successFixture, extra: true }).success).toBe(false);
    expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...successFixture, data: { ...successFixture.data, sourceContext: { ...successFixture.data.sourceContext, season: "2025/2026" } } }).success).toBe(false);
    expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...successFixture, data: { ...successFixture.data, axes: [...successFixture.data.axes].reverse() } }).success).toBe(false);
    expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...successFixture, data: { ...successFixture.data, benchmark: { ...successFixture.data.benchmark, scope: 7 } } }).success).toBe(false);
  });

  it("keeps observed zero distinct from null and accepts both ready reasons", () => {
    const data = volumeBenchmarkEnvelopeSchema.parse(observedZeroFixture).data;
    if (!data.available) throw new Error("fixture must be ready");
    expect(data.reason).toBe("partial_source_imputed");
    expect(data.axes[0].playerRawValue).toBe(0);
    expect(data.axes[1].playerRawValue).toBeNull();
    expect(data.axes[1].imputed).toBe(true);
  });

  it("requires zero axes and the unavailable reason for unavailable data", () => {
    const data = volumeBenchmarkEnvelopeSchema.parse(unavailableFixture).data;
    expect(data.available).toBe(false);
    if (!data.available) expect(data.axes).toHaveLength(0);
  });
});
