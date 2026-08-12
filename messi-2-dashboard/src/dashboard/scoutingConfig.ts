import type { MetricKey, TierCode } from "./types";

export { metricKeys } from "./types";

/** Shared by desktop/mobile metric cells and the score legend. */
export const scoreBands = [
  { min: 90, label: "90 to 100", rangeLabel: "90–100", className: "border-cyan-400/40 bg-cyan-400/10 text-cyan-300", dotClassName: "bg-cyan-300" },
  { min: 80, label: "80 to 89", rangeLabel: "80–89", className: "border-sky-400/40 bg-sky-400/10 text-sky-300", dotClassName: "bg-sky-300" },
  { min: 70, label: "70 to 79", rangeLabel: "70–79", className: "border-amber-400/40 bg-amber-400/10 text-amber-300", dotClassName: "bg-amber-300" },
  { min: 60, label: "60 to 69", rangeLabel: "60–69", className: "border-zinc-400/40 bg-zinc-400/10 text-zinc-300", dotClassName: "bg-zinc-300" },
  { min: 50, label: "50 to 59", rangeLabel: "50–59", className: "border-orange-400/40 bg-orange-400/10 text-orange-300", dotClassName: "bg-orange-300" },
  { min: 0, label: "0 to 49", rangeLabel: "0–49", className: "border-stone-400/40 bg-stone-400/10 text-stone-300", dotClassName: "bg-stone-300" },
] as const;

export function getScoreBand(score: number) {
  if (!Number.isFinite(score)) return scoreBands[5];
  return scoreBands.find((band) => score >= band.min) ?? scoreBands[5];
}

export const metricConfig: Record<MetricKey, { label: string; short: string; detail: string }> = {
  outsideShot: { label: "박스 밖 슈팅", short: "중거리", detail: "박스 밖 슈팅 위협 (20%)" },
  boxThreat: { label: "박스 안 슈팅", short: "박스 안", detail: "박스 안 슈팅 지표 (30%)" },
  dangerZone: { label: "드리블 능력", short: "드리블", detail: "드리블 능력 지표 (15%)" },
  aerial: { label: "공중 경합", short: "공중", detail: "공중 경합 영향력 (10%)" },
  groundDuel: { label: "지상 경합", short: "지상", detail: "지상 경합 영향력 (10%)" },
  spaceControl: { label: "오프 더 볼", short: "오프 더 볼", detail: "오프 더 볼 움직임 지표 (15%)" },
};

export const tierConfig: Record<TierCode, { label: string; glyph: string; className: string }> = {
  diamond: { label: "Diamond", glyph: "◆", className: "text-cyan-200 border-cyan-300/35 bg-cyan-300/10" },
  platinum: { label: "Platinum", glyph: "⬟", className: "text-sky-200 border-sky-300/35 bg-sky-300/10" },
  gold: { label: "Gold", glyph: "●", className: "text-amber-200 border-amber-300/35 bg-amber-300/10" },
  silver: { label: "Silver", glyph: "●", className: "text-zinc-200 border-zinc-300/35 bg-zinc-300/10" },
  bronze: { label: "Bronze", glyph: "●", className: "text-orange-300 border-orange-400/35 bg-orange-400/10" },
  iron: { label: "Iron", glyph: "■", className: "text-stone-300 border-stone-400/35 bg-stone-400/10" },
};
