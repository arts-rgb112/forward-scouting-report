import type { Player, PlayerAnalysis, RadarAxis, TacticalQuadrant } from "../dashboard/types";
import { getScoreBand, metricKeys } from "../dashboard/scoutingConfig";
import { metricIsImputed, type QualityDisplay } from "../dashboard/dataQualityViewModel";

export const detailMetrics = [
  ["outsideShot", "OTS", "Outside-the-box shooting", "attempts", "quality"],
  ["boxThreat", "BOX", "Box threat", "box volume", "deep finish"],
  ["dangerZone", "OBP", "On-ball progression", "dribble attempts", "danger progression"],
  ["aerial", "AER", "Aerial duels", "attempts", "margin"],
  ["groundDuel", "GND", "Ground duels", "attempts", "margin"],
  ["spaceControl", "OTB", "Off-the-ball movement", "radius", "space efficiency"],
] as const;

export type DetailMetric = (typeof detailMetrics)[number][0];
export const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const selectedScore = (player: Player, analysis?: PlayerAnalysis) => analysis?.score.value ?? player.score;
export const wholeScore = (player: Player, analysis?: PlayerAnalysis) => Math.floor(selectedScore(player, analysis));
export type SeasonHistoryRow = { player: Player; context: Pick<import("../dashboard/types").DatasetRouteState, "season" | "mode" | "scope" | "competition"> };
export function seasonScoreRows(player: Player, analysis: PlayerAnalysis | undefined, selected: SeasonHistoryRow["context"], history: readonly SeasonHistoryRow[]) {
  const selectedRow = { player: { ...player, score: selectedScore(player, analysis) }, context: selected, score: selectedScore(player, analysis), selected: true };
  const historical = [...history].sort((a, b) => b.player.score - a.player.score || b.context.season.localeCompare(a.context.season) || (a.context.mode === "league" ? -1 : 1)).slice(0, 4)
    .map((row) => ({ ...row, score: row.player.score, selected: false }));
  return [selectedRow, ...historical];
}

export function axesById(analysis: PlayerAnalysis | undefined) {
  const volume = new Map(analysis?.volumeRadar.axes.map((axis) => [axis.id, axis]) ?? []);
  const ratio = new Map(analysis?.ratioRadar.axes.map((axis) => [axis.id, axis]) ?? []);
  return { volume, ratio };
}

export function metricProfile(player: Player, analysis: PlayerAnalysis | undefined, quality?: QualityDisplay) {
  const axes = axesById(analysis);
  return detailMetrics.map(([id, short, label, volumeLabel, ratioLabel]) => ({
    id, short, label, score: player.stats[id], band: getScoreBand(player.stats[id]),
    volumeLabel, ratioLabel, volume: axes.volume.get(id), ratio: axes.ratio.get(id), imputed: Boolean(axes.volume.get(id)?.imputed || axes.ratio.get(id)?.imputed || metricIsImputed(quality, id)),
  }));
}

export function tacticalCopy(player: Player, analysis: PlayerAnalysis | undefined, quadrant?: TacticalQuadrant, quality?: QualityDisplay): [string, string, string] {
  const selected = quadrant?.available && quadrant.selectedPoint && isFiniteNumber(quadrant.xMedian) && isFiniteNumber(quadrant.yMedian) ? quadrant.selectedPoint : undefined;
  const positioning = selected
    ? selected.netProgressionPer90 >= quadrant!.xMedian! && selected.inBoxXgotMinusXg >= quadrant!.yMedian! ? "Positioning: Complete forward."
      : selected.netProgressionPer90 < quadrant!.xMedian! && selected.inBoxXgotMinusXg >= quadrant!.yMedian! ? "Positioning: Poacher."
        : selected.netProgressionPer90 >= quadrant!.xMedian! && selected.inBoxXgotMinusXg < quadrant!.yMedian! ? "Positioning: False nine."
          : "Positioning: Low-output quadrant."
    : `Positioning: ${player.position} · ${player.archetype}; tactical quadrant is unavailable.`;
  const lanes = analysis?.spatial.laneRatios;
  let movement = "Movement: measured lane data unavailable.";
  if (lanes?.length === 5 && lanes.every(isFiniteNumber)) {
    const right = lanes[0] + lanes[1]; const left = lanes[3] + lanes[4];
    movement = right - left > 15 ? "Movement: right-sided lanes." : left - right > 15 ? "Movement: left-sided lanes."
      : lanes[1] + lanes[3] > 40 ? "Movement: halfspaces (lanes 2 and 4)." : lanes[2] > 50 ? "Movement: central lane."
        : lanes[0] + lanes[4] > 30 ? "Movement: wide wings." : "Movement: switching across lanes.";
  }
  const axis = axesById(analysis).volume.get("spaceControl");
  const activity = Boolean(axis?.imputed || metricIsImputed(quality, "spaceControl")) ? "Activity: Conservative substitute; not measured."
    : !axis ? "Activity: measured activity unavailable."
      : axis.score >= 65 ? `Activity: wide activity (${axis.score}).`
        : axis.score <= 35 ? `Activity: focused activity (${axis.score}).` : `Activity: balanced activity (${axis.score}).`;
  return [positioning, movement, activity];
}

export function axisDetail(axis: RadarAxis | undefined) {
  if (!axis) return "Measured data unavailable";
  const parts = [`score ${axis.score}`];
  if (axis.percentile !== null) parts.push(`percentile ${axis.percentile}`);
  if (axis.rank !== null) parts.push(`rank #${axis.rank}`);
  if (axis.population > 0) parts.push(`of ${axis.population}`);
  return parts.join(" · ");
}

export const radarAxisLabels = ["Outside shot attempts", "Box hits", "Dribble attempts", "Aerial attempts", "Ground attempts", "Core radius"] as const;
export function radarValues(analysis?: PlayerAnalysis): Array<number | undefined> {
  const byId = axesById(analysis).volume;
  return metricKeys.map((id) => byId.get(id)?.score);
}
