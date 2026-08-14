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
    const params = new URL(detail).searchParams;
    expect(params.get("mode")).toBe("europe");
    expect(params.get("competition")).toBe("ucl");
    expect(params.has("scope")).toBe(false);
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
    expect(legacyDetailHref(1, { name: "x", clubName: "y" }, { ...dataset, mode: "league", scope: 4 as 7, competition: "all" })).toBeNull();
  });
  it("keeps domestic detail context separate from Europe competition context", () => {
    const href = legacyDetailHref(1, { name: "x", clubName: "y" }, { season: "2025/2026", mode: "league", scope: 5, competition: "all" })!;
    const params = new URL(href).searchParams;
    expect(params.get("mode")).toBe("league");
    expect(params.get("scope")).toBe("5");
    expect(params.has("competition")).toBe(false);
  });
  it("preserves scope 8 in the fixed Streamlit handoff", () => {
    const href = legacyDetailHref(1, { name: "x", clubName: "y" }, { season: "2025/2026", mode: "league", scope: 8, competition: "all" })!;
    expect(new URL(href).searchParams.get("scope")).toBe("8");
  });
  it("serializes exactly two independent watchlist contexts for Streamlit Compare", () => {
    const href = legacyCompareHref([
      { playerId: 101, snapshot: { name: "A & B", clubName: "FC / One" }, context: { season: "2025/2026", mode: "league", scope: 5, competition: null } },
      { playerId: 202, snapshot: { name: "C D", clubName: "Two" }, context: { season: "2024/2025", mode: "europe", scope: null, competition: "uel" } },
    ])!;
    const params = new URL(href).searchParams;
    expect(params.get("page")).toBe("compare");
    expect(params.get("left_player")).toBe("101");
    expect(params.get("left_name")).toBe("A & B");
    expect(params.get("left_team")).toBe("FC / One");
    expect(params.get("left_season")).toBe("25/26");
    expect(params.get("left_mode")).toBe("league");
    expect(params.get("left_scope")).toBe("5");
    expect(params.has("left_competition")).toBe(false);
    expect(params.get("right_player")).toBe("202");
    expect(params.get("right_name")).toBe("C D");
    expect(params.get("right_team")).toBe("Two");
    expect(params.get("right_season")).toBe("24/25");
    expect(params.get("right_mode")).toBe("europe");
    expect(params.get("right_competition")).toBe("uel");
    expect(params.has("right_scope")).toBe(false);
  });
  it("refuses incomplete or unsupported Compare selections", () => {
    const entry = { playerId: 101, snapshot: { name: "A", clubName: "Club" }, context: { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: null } };
    expect(legacyCompareHref([entry])).toBeNull();
    expect(legacyCompareHref([{ ...entry, context: { ...entry.context, scope: null } }, entry])).toBeNull();
  });
});
