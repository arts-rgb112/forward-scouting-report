import { describe, expect, it } from "vitest";
import { getScoreBand, resolveTierPresentation } from "./scoutingConfig";

describe("getScoreBand", () => {
  it.each([[100, "90–100"], [90, "90–100"], [89, "80–89"], [80, "80–89"], [79, "70–79"], [70, "70–79"], [69, "60–69"], [60, "60–69"], [59, "50–59"], [50, "50–59"], [49, "0–49"], [0, "0–49"]] as const)("maps %s to %s", (score, rangeLabel) => expect(getScoreBand(score).rangeLabel).toBe(rangeLabel));
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("uses the stone fallback for invalid %s", (score) => expect(getScoreBand(score).rangeLabel).toBe("0–49"));
  it.each([
    [100, "90–100", "border-violet-300/45"], [90, "90–100", "border-violet-300/45"],
    [89, "80–89", "border-emerald-300/45"], [80, "80–89", "border-emerald-300/45"],
    [79, "70–79", "border-cyan-300/45"], [70, "70–79", "border-cyan-300/45"],
    [69, "60–69", "border-amber-300/45"], [60, "60–69", "border-amber-300/45"],
    [59, "50–59", "border-slate-300/45"], [50, "50–59", "border-slate-300/45"],
    [49, "0–49", "border-orange-300/45"], [0, "0–49", "border-orange-300/45"],
  ] as const)("keeps exact boundaries and the approved %s token", (score, rangeLabel, token) => {
    const band = getScoreBand(score);
    expect(band.rangeLabel).toBe(rangeLabel);
    expect(band.className).toContain(token);
  });
});

describe("tier taxonomy presentation", () => {
  it.each([
    ["diamond", "Diamond", "◆", "border-violet-300/45"], ["emerald", "Emerald", "✦", "border-emerald-300/45"],
    ["platinum", "Platinum", "⬟", "border-cyan-300/45"], ["gold", "Gold", "●", "border-amber-300/45"],
    ["silver", "Silver", "●", "border-slate-300/45"], ["bronze", "Bronze", "●", "border-orange-300/45"],
  ] as const)("renders crystal-v2 %s unchanged", (code, label, glyph, token) => {
    expect(resolveTierPresentation({ code, label, level: 2, taxonomyVersion: "crystal-v2" })).toMatchObject({ taxonomy: "crystal-v2", label, glyph, className: expect.stringContaining(token) });
  });
  it.each([
    ["diamond", "Legacy Diamond", "border-violet-300/45"], ["platinum", "Legacy Platinum", "border-emerald-300/45"],
    ["gold", "Legacy Gold", "border-cyan-300/45"], ["silver", "Legacy Silver", "border-amber-300/45"],
    ["bronze", "Legacy Bronze", "border-slate-300/45"], ["iron", "Legacy Iron", "border-orange-300/45"],
  ] as const)("keeps legacy %s explicit and in its ordinal palette slot", (code, label, token) => {
    expect(resolveTierPresentation({ code, label, level: 1 })).toMatchObject({ taxonomy: "legacy-v1", label, className: expect.stringContaining(token) });
  });
  it("never guesses unknown versions or codes", () => {
    expect(resolveTierPresentation({ code: "platinum", label: "Platinum", level: 1, taxonomyVersion: "unexpected-v3" })).toMatchObject({ taxonomy: "unknown", label: "Unknown tier" });
    expect(resolveTierPresentation({ code: "ruby", label: "Ruby", level: 1, taxonomyVersion: "crystal-v2" })).toMatchObject({ taxonomy: "unknown", label: "Unknown tier" });
  });
});
