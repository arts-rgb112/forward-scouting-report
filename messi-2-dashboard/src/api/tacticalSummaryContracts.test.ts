import { describe, expect, it } from "vitest";
import complete from "../../../docs/fixtures/tactical_summary_v1/complete.json";
import europeAll from "../../../docs/fixtures/tactical_summary_v1/europe_all_partial_source_imputed.json";
import partial from "../../../docs/fixtures/tactical_summary_v1/partial_source_imputed.json";
import unavailable from "../../../docs/fixtures/tactical_summary_v1/unavailable.json";

import { tacticalSummaryEnvelopeSchema } from "./tacticalSummaryContracts";

describe("tactical summary v1 contract", () => {
  it("parses the canonical complete, partial-imputed, and unavailable fixtures directly", () => {
    for (const fixture of [complete, partial, europeAll, unavailable]) expect(tacticalSummaryEnvelopeSchema.parse(fixture).schemaVersion).toBe("1.0.0");
  });
  it("strictly accepts Europe all alongside the supported named competitions", () => {
    const parsed = tacticalSummaryEnvelopeSchema.parse(europeAll).data; expect(parsed.sourceContext).toEqual({ mode: "europe", scope: null, competition: "all" });
    expect(tacticalSummaryEnvelopeSchema.safeParse({ ...europeAll, data: { ...europeAll.data, sourceContext: { mode: "europe", scope: null, competition: "invalid" } } }).success).toBe(false);
  });
  it("requires the authoritative three-line order and reason/imputation consistency", () => {
    expect(tacticalSummaryEnvelopeSchema.safeParse({ ...complete, data: { ...complete.data, lines: [...complete.data.lines].reverse() } }).success).toBe(false);
    expect(tacticalSummaryEnvelopeSchema.safeParse({ ...complete, data: { ...complete.data, reason: "partial_source_imputed" } }).success).toBe(false);
    expect(tacticalSummaryEnvelopeSchema.safeParse({ ...unavailable, data: { ...unavailable.data, lines: [complete.data.lines[0]] } }).success).toBe(false);
  });
});
