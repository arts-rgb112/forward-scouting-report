import { describe, expect, it } from "vitest";
import { volumeBenchmarkEnvelopeSchema } from "./volumeBenchmarkContracts";
import { benchmarkAxes, benchmarkEnvelope } from "../test/volumeBenchmarkFixtures";
describe("volume benchmark contract", () => {
  it("accepts the exact ordered tuple including zero and nullable raw", () => expect(volumeBenchmarkEnvelopeSchema.parse(benchmarkEnvelope).data.available).toBe(true));
  it("rejects wrong order, extra keys and version mismatches", () => { expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...benchmarkEnvelope, schemaVersion: "2.0.0" }).success).toBe(false); expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...benchmarkEnvelope, extra: true }).success).toBe(false); expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...benchmarkEnvelope, data: { ...benchmarkEnvelope.data, sourceContext:{...benchmarkEnvelope.data.sourceContext,season:"2025/2026"} } }).success).toBe(false); expect(volumeBenchmarkEnvelopeSchema.safeParse({ ...benchmarkEnvelope, data: { ...benchmarkEnvelope.data, axes: [...benchmarkAxes].reverse() } }).success).toBe(false); });
  it("allows only an empty tuple for unavailable", () => expect(volumeBenchmarkEnvelopeSchema.parse({ ...benchmarkEnvelope, data: { ...benchmarkEnvelope.data, available: false, reason: "benchmark_source_unavailable", axes: [] } }).data.available).toBe(false));
});
