import { describe, expect, it } from "vitest";
import { tacticalSummaryV2Enabled } from "./tacticalSummaryV2FeatureGate";
describe("tactical-summary-v2 feature gate", () => { it("only enables on the exact literal true", () => { expect(tacticalSummaryV2Enabled({ VITE_TACTICAL_SUMMARY_V2_ENABLED: "true" })).toBe(true); expect(tacticalSummaryV2Enabled({ VITE_TACTICAL_SUMMARY_V2_ENABLED: "TRUE" })).toBe(false); expect(tacticalSummaryV2Enabled({})).toBe(false); }); });
