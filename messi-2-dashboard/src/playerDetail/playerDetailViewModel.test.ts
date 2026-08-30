import { describe, expect, it } from "vitest";

import { samplePlayers } from "../test/fixtures/players";
import { axesById, detailMetrics, metricProfile, seasonScoreRows, tacticalCopy, wholeScore } from "./playerDetailViewModel";

const player = samplePlayers[0];
const axis = (id: string, score = 60) => ({ id, label: id, score, percentile: null, rank: null, population: 0, rawValue: null, tier: "B" as const, imputed: false });
describe("player detail view model", () => {
  it("floors the selected server score and keeps fixed card abbreviations", () => {
    expect(wholeScore(player, { score: { value: 81.99, rank: null, topPercent: null, population: 1, archetype: "Type A" }, volumeRadar: { kind: "volume", axes: [] }, ratioRadar: { kind: "ratio", axes: [] }, rawMetrics: {}, spatial: {} as never })).toBe(81);
    expect(detailMetrics.map((metric) => metric[1])).toEqual(["OTS", "BOX", "OBP", "AER", "GND", "OTB"]);
  });
  it("matches radar axes by stable id rather than server order", () => {
    const analysis = { volumeRadar: { axes: [axis("spaceControl"), axis("outsideShot")] }, ratioRadar: { axes: [axis("aerial"), axis("boxThreat")] } } as never;
    expect(axesById(analysis).volume.get("outsideShot")?.id).toBe("outsideShot");
    expect(axesById(analysis).ratio.get("aerial")?.id).toBe("aerial");
  });
  it("uses inclusive quadrant medians and conservative imputed activity copy", () => {
    const analysis = { volumeRadar: { axes: [axis("spaceControl", 70)] }, ratioRadar: { axes: [] }, spatial: { laneRatios: [10, 15, 20, 15, 10] } } as never;
    const quadrant = { available: true, selectedPoint: { netProgressionPer90: 1, inBoxXgotMinusXg: 2 }, xMedian: 1, yMedian: 2 } as never;
    expect(tacticalCopy(player, analysis, quadrant, { kind: "incomplete", dataQuality: { imputedMetrics: ["spaceControl"], imputedComponents: [], reason: "source_metric_missing", qualityVersion: "messi-quality-v1", spatialAvailable: false, messiScoreComplete: false, observedWeightPct: 0, fallbackComponentScore: 20 } })[0]).toContain("Complete forward");
    expect(tacticalCopy(player, analysis, quadrant, { kind: "incomplete", dataQuality: { imputedMetrics: ["spaceControl"], imputedComponents: [], reason: "source_metric_missing", qualityVersion: "messi-quality-v1", spatialAvailable: false, messiScoreComplete: false, observedWeightPct: 0, fallbackComponentScore: 20 } })[2]).toContain("Conservative substitute");
  });
  it("pins selected analysis score ahead of higher historical rows and respects authoritative axis imputation", () => {
    const selected = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    const history = [{ player: { ...player, score: 99 }, context: { ...selected, season: "2024/2025" } }, { player: { ...player, score: 98 }, context: { ...selected, season: "2023/2024" } }];
    const analysis = { score: { value: 81.99 }, volumeRadar: { axes: [axis("spaceControl")], kind: "volume" }, ratioRadar: { axes: [{ ...axis("spaceControl"), imputed: true }], kind: "ratio" } } as never;
    const rows = seasonScoreRows(player, analysis, selected, history);
    expect(rows[0]).toMatchObject({ selected: true, score: 81.99 }); expect(rows[1]?.score).toBe(99); expect(metricProfile(player, analysis, { kind: "idle" }).find((metric) => metric.id === "spaceControl")?.imputed).toBe(true);
  });
  it("deduplicates history to the highest server score for each non-selected season before taking five", () => {
    const selected = { season: "2025/2026", mode: "league" as const, scope: 8 as const, competition: "all" as const };
    const history = [
      { player: { ...player, score: 81 }, context: { ...selected, season: "2024/2025", mode: "league" as const } },
      { player: { ...player, score: 92 }, context: { ...selected, season: "2024/2025", mode: "europe" as const, competition: "ucl" as const } },
      { player: { ...player, score: 89 }, context: { ...selected, season: "2023/2024" } },
      { player: { ...player, score: 99 }, context: selected },
      { player: { ...player, score: 88 }, context: { ...selected, season: "2022/2023" } },
      { player: { ...player, score: 87 }, context: { ...selected, season: "2021/2022" } },
      { player: { ...player, score: 86 }, context: { ...selected, season: "2020/2021" } },
    ];
    const rows = seasonScoreRows(player, undefined, selected, history);
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.context.season)).toEqual(["2025/2026", "2024/2025", "2023/2024", "2022/2023", "2021/2022", "2020/2021"]);
    expect(rows[1]).toMatchObject({ score: 92, context: { mode: "europe" } });
  });
});
