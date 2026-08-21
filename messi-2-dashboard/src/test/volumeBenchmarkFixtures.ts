import observedZeroFixture from "../../../docs/fixtures/volume_benchmark_v1/observed_zero.json";
import successFixture from "../../../docs/fixtures/volume_benchmark_v1/success.json";
import unavailableFixture from "../../../docs/fixtures/volume_benchmark_v1/unavailable.json";

import { volumeBenchmarkEnvelopeSchema, type VolumeBenchmark } from "../api/volumeBenchmarkContracts";

// This is test-only: tsconfig.build.json excludes src/test. The canonical fixtures
// live outside the Vite app root, so application code must never bundle them.
export { observedZeroFixture, successFixture, unavailableFixture };

function availableFixture(fixture: unknown): Extract<VolumeBenchmark, { available: true }> {
  const data = volumeBenchmarkEnvelopeSchema.parse(fixture).data;
  if (!data.available) throw new Error("Expected an available volume benchmark fixture");
  return data;
}

function unavailableFixtureData(fixture: unknown): Extract<VolumeBenchmark, { available: false }> {
  const data = volumeBenchmarkEnvelopeSchema.parse(fixture).data;
  if (data.available) throw new Error("Expected an unavailable volume benchmark fixture");
  return data;
}

export const successBenchmarkData = availableFixture(successFixture);
export const observedZeroBenchmarkData = availableFixture(observedZeroFixture);
export const unavailableBenchmarkData = unavailableFixtureData(unavailableFixture);

// Kept as the shared API-test value; its player id is intentionally 1.
export const benchmarkEnvelope = { schemaVersion: "1.0.0" as const, data: observedZeroBenchmarkData };
export const benchmarkAxes = observedZeroBenchmarkData.axes;
