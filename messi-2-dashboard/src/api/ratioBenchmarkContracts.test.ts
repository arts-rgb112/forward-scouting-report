import { describe, expect, it } from "vitest";
import observedZeroImputed from "../../../docs/fixtures/ratio_benchmark_v1/observed_zero_imputed.json";
import europeAll from "../../../docs/fixtures/ratio_benchmark_v1/europe_all_observed_zero_imputed.json";
import populationZero from "../../../docs/fixtures/ratio_benchmark_v1/population_zero.json";
import success from "../../../docs/fixtures/ratio_benchmark_v1/success.json";
import unavailable from "../../../docs/fixtures/ratio_benchmark_v1/unavailable.json";

import { ratioBenchmarkEnvelopeSchema } from "./ratioBenchmarkContracts";

describe("ratio benchmark v1 contract", () => {
  it("parses canonical fixtures directly", () => {
    for (const fixture of [success, observedZeroImputed, europeAll, populationZero, unavailable]) expect(ratioBenchmarkEnvelopeSchema.parse(fixture).schemaVersion).toBe("1.0.0");
  });
  it("accepts Europe all and backend-valid zero population only when ranks are unavailable", () => {
    const europe = ratioBenchmarkEnvelopeSchema.parse(europeAll).data; expect(europe.sourceContext).toEqual({ mode: "europe", scope: null, competition: "all" });
    const zero = ratioBenchmarkEnvelopeSchema.parse(populationZero).data; if (!zero.available) throw new Error("fixture must be available"); expect(zero.axes.every((axis) => axis.population === 0 && axis.playerRank === null)).toBe(true);
    expect(ratioBenchmarkEnvelopeSchema.safeParse({ ...populationZero, data: { ...populationZero.data, axes: populationZero.data.axes.map((axis, index) => index ? axis : { ...axis, playerRank: 1 }) } }).success).toBe(false);
  });
  it("preserves observed zero, null, and source imputation without a score fallback", () => {
    const data = ratioBenchmarkEnvelopeSchema.parse(observedZeroImputed).data;
    if (!data.available) throw new Error("fixture must be available");
    expect(data.axes[0].playerRawValue).toBe(0); expect(data.axes[1].playerRawValue).toBeNull(); expect(data.axes[1].imputed).toBe(true);
  });
  it("rejects extras, non-ratio descriptors, and reordered axes", () => {
    expect(ratioBenchmarkEnvelopeSchema.safeParse({ ...success, extra: true }).success).toBe(false);
    expect(ratioBenchmarkEnvelopeSchema.safeParse({ ...success, data: { ...success.data, benchmark: { ...success.data.benchmark, kind: "volume" } } }).success).toBe(false);
    expect(ratioBenchmarkEnvelopeSchema.safeParse({ ...success, data: { ...success.data, axes: [...success.data.axes].reverse() } }).success).toBe(false);
  });
});
