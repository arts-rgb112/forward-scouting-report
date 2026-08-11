import { describe, expect, it } from "vitest";

import { LEGACY_ORIGIN, enabledLegacyHref, legacyAboutHref, legacyCompareHref, legacyDetailHref, legacyHandoffEnabled, legacySeason } from "./legacyHandoff";

const dataset = { season: "2025/2026", mode: "europe" as const, scope: 7 as const, competition: "ucl" as const };
describe("legacy handoff", () => {
  it("uses a fixed origin and known routes only", () => {
    expect(legacyCompareHref()).toBe(`${LEGACY_ORIGIN}/?page=compare`);
    expect(legacyAboutHref()).toBe(`${LEGACY_ORIGIN}/?page=about`);
    const detail = legacyDetailHref(7, { name: "A & B", clubName: "Club" }, dataset)!;
    expect(detail).toContain(LEGACY_ORIGIN);
    expect(detail).toContain("season=25%2F26");
    expect(detail).not.toContain("competition");
  });
  it("does not activate outbound navigation without the exact flag", () => {
    expect(legacyHandoffEnabled({ VITE_LEGACY_HANDOFF_ENABLED: "false" })).toBe(false);
    expect(enabledLegacyHref(legacyCompareHref(), { VITE_LEGACY_HANDOFF_ENABLED: "false" })).toBeNull();
    expect(legacyHandoffEnabled({ VITE_LEGACY_HANDOFF_ENABLED: "true" })).toBe(true);
  });
  it("strictly converts seasons and accepts only numeric players/scopes", () => {
    expect(legacySeason("2025/2026")).toBe("25/26");
    expect(legacySeason("2025/26")).toBeNull();
    expect(legacySeason("2025/2025")).toBeNull();
    expect(legacyDetailHref(0, { name: "x", clubName: "y" }, dataset)).toBeNull();
    expect(legacyDetailHref(1, { name: "x", clubName: "y" }, { ...dataset, scope: 4 as 7 })).toBeNull();
  });
});
