import type { MetricKey, TierCode } from "./types";
export { metricKeys } from "./types";
export const scoreBands = [
  { min: 90, label: "엘리트", rangeLabel: "90–100", className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300", dotClassName: "bg-emerald-300" },
  { min: 80, label: "우수", rangeLabel: "80–89", className: "border-lime-400/40 bg-lime-400/10 text-lime-300", dotClassName: "bg-lime-300" },
  { min: 70, label: "보통", rangeLabel: "70–79", className: "border-orange-400/40 bg-orange-400/10 text-orange-300", dotClassName: "bg-orange-300" },
  { min: 0, label: "보완", rangeLabel: "0–69", className: "border-rose-400/40 bg-rose-400/10 text-rose-300", dotClassName: "bg-rose-300" },
] as const;
export function getScoreBand(score: number) { if (!Number.isFinite(score)) return scoreBands[3]; return scoreBands.find((band) => score >= band.min) ?? scoreBands[3]; }
export const metricConfig: Record<MetricKey, { label: string; short: string; detail: string }> = {
  outsideShot: { label: "박스 밖 슈팅", short: "중거리", detail: "박스 밖 슈팅 위협 (20%)" },
  boxThreat: { label: "박스 위협", short: "박스", detail: "박스 안 공격 위협 (30%)" },
  dangerZone: { label: "위험 구역 전진", short: "전진", detail: "위험 지역으로의 전진 (15%)" },
  aerial: { label: "공중 경합", short: "공중", detail: "공중 경합 영향력 (10%)" },
  groundDuel: { label: "지상 경합", short: "지상", detail: "지상 경합 영향력 (10%)" },
  spaceControl: { label: "공간 지배", short: "공간", detail: "공간 점유와 지배 (15%)" },
};
export const tierConfig: Record<TierCode, { label: string; glyph: string; className: string }> = {
  diamond: { label: "Diamond", glyph: "◆", className: "text-cyan-200 border-cyan-300/35 bg-cyan-300/10" },
  platinum: { label: "Platinum", glyph: "⬟", className: "text-sky-200 border-sky-300/35 bg-sky-300/10" },
  gold: { label: "Gold", glyph: "●", className: "text-amber-200 border-amber-300/35 bg-amber-300/10" },
  silver: { label: "Silver", glyph: "●", className: "text-zinc-200 border-zinc-300/35 bg-zinc-300/10" },
  bronze: { label: "Bronze", glyph: "●", className: "text-orange-300 border-orange-400/35 bg-orange-400/10" },
  iron: { label: "Iron", glyph: "■", className: "text-stone-300 border-stone-400/35 bg-stone-400/10" },
};
