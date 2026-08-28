import type { MetricKey, Tier } from "./types";
import { duelPressAxisLabels } from "./duelPressAxisLabels";

export { metricKeys } from "./types";

/** Shared by desktop/mobile metric cells and the score legend. */
export const scoreBands = [
  { min: 90, label: "90 to 100", rangeLabel: "90–100", className: "border-violet-300/45 bg-violet-400/15 text-violet-100", dotClassName: "bg-violet-300" },
  { min: 80, label: "80 to 89", rangeLabel: "80–89", className: "border-emerald-300/45 bg-emerald-400/15 text-emerald-100", dotClassName: "bg-emerald-300" },
  { min: 70, label: "70 to 79", rangeLabel: "70–79", className: "border-cyan-300/45 bg-cyan-400/15 text-cyan-100", dotClassName: "bg-cyan-300" },
  { min: 60, label: "60 to 69", rangeLabel: "60–69", className: "border-amber-300/45 bg-amber-400/15 text-amber-100", dotClassName: "bg-amber-300" },
  { min: 50, label: "50 to 59", rangeLabel: "50–59", className: "border-slate-300/45 bg-slate-400/15 text-slate-100", dotClassName: "bg-slate-300" },
  { min: 0, label: "0 to 49", rangeLabel: "0–49", className: "border-orange-300/45 bg-orange-400/15 text-orange-100", dotClassName: "bg-orange-300" },
] as const;

export function getScoreBand(score: number) {
  if (!Number.isFinite(score)) return scoreBands[5];
  return scoreBands.find((band) => score >= band.min) ?? scoreBands[5];
}

export const metricConfig: Record<MetricKey, { label: string; short: string; detail: string; formula: string }> = {
  outsideShot: { label: duelPressAxisLabels.outsideShot, short: "중거리", detail: "박스 밖에서의 슈팅 영향력을 평가합니다.", formula: "박스 밖 슈팅 시도량 50%와 슈팅 품질 50%를 동일 문맥 코호트 백분위로 결합합니다." },
  boxThreat: { label: duelPressAxisLabels.boxThreat, short: "박스 안", detail: "박스 안에서의 득점 위협을 평가합니다.", formula: "박스 안 슈팅 시도량 50%와 인박스 피니싱/90 70%·딥박스 존 활동 30%의 결합 점수 50%를 동일 문맥 코호트 백분위로 결합합니다." },
  dangerZone: { label: duelPressAxisLabels.dangerZone, short: "온볼 전개", detail: "공을 소유한 상태에서 전진과 위험 창출에 미친 영향을 평가합니다.", formula: "시즌 드리블 시도량 50%, 드리블 순마진 35%, 위험구역 활동밀도 15%를 결합합니다. 모든 구성요소는 동일 문맥 코호트 백분위입니다." },
  aerial: { label: "공중 경합", short: "공중", detail: "공중 경합 영향력을 평가합니다.", formula: "공중 경합 시도량 50%와 공중 경합 승패 마진/90 50%를 동일 문맥 코호트 백분위로 결합합니다." },
  groundDuel: { label: "지상 경합", short: "지상", detail: "지상 경합 영향력을 평가합니다.", formula: "지상 경합 시도량 50%와 지상 경합 승패 마진/90 50%를 동일 문맥 코호트 백분위로 결합합니다." },
  spaceControl: { label: duelPressAxisLabels.spaceControl, short: duelPressAxisLabels.spaceControl, detail: "위치 분포와 위험구역 활동 밀도를 평가합니다.", formula: "CCA 면적 50%와 위험구역 활동밀도 50%를 동일 문맥 코호트 백분위로 결합합니다." },
};

type TierVisual = { label: string; glyph: string; className: string };
export type TierPresentation = TierVisual & { taxonomy: "crystal-v2" | "legacy-v1" | "unknown"; tooltip: string };

/** Shared ordinal palette: Diamond, Emerald, Platinum, Gold, Silver, Bronze. */
const tierPalette = {
  diamond: { glyph: "◆", className: "border-violet-300/45 bg-violet-400/15 text-violet-100" },
  emerald: { glyph: "✦", className: "border-emerald-300/45 bg-emerald-400/15 text-emerald-100" },
  platinum: { glyph: "⬟", className: "border-cyan-300/45 bg-cyan-400/15 text-cyan-100" },
  gold: { glyph: "●", className: "border-amber-300/45 bg-amber-400/15 text-amber-100" },
  silver: { glyph: "●", className: "border-slate-300/45 bg-slate-400/15 text-slate-100" },
  bronze: { glyph: "●", className: "border-orange-300/45 bg-orange-400/15 text-orange-100" },
  unknown: { glyph: "?", className: "border-zinc-400/45 bg-zinc-400/10 text-zinc-100" },
} as const;

const crystalTierConfig: Record<string, TierVisual> = Object.fromEntries(
  (["diamond", "emerald", "platinum", "gold", "silver", "bronze"] as const).map((code) => [code, { label: code[0].toUpperCase() + code.slice(1), ...tierPalette[code] }]),
);
const legacyTierConfig: Record<string, TierVisual> = {
  diamond: { label: "Legacy Diamond", ...tierPalette.diamond },
  platinum: { label: "Legacy Platinum", ...tierPalette.emerald },
  gold: { label: "Legacy Gold", ...tierPalette.platinum },
  silver: { label: "Legacy Silver", ...tierPalette.gold },
  bronze: { label: "Legacy Bronze", ...tierPalette.silver },
  iron: { label: "Legacy Iron", ...tierPalette.bronze },
};

/** No-version payloads are deliberately legacy: only an explicit crystal-v2 contract may use the new names. */
export function resolveTierPresentation(tier: Tier): TierPresentation {
  const version = tier.taxonomyVersion ?? "legacy-v1";
  if (version === "crystal-v2" && crystalTierConfig[tier.code]) return { ...crystalTierConfig[tier.code], taxonomy: "crystal-v2", tooltip: `${crystalTierConfig[tier.code].label}, level ${tier.level}` };
  if (version === "legacy-v1" && legacyTierConfig[tier.code]) return { ...legacyTierConfig[tier.code], taxonomy: "legacy-v1", tooltip: `${legacyTierConfig[tier.code].label}, level ${tier.level}. Legacy tier taxonomy.` };
  return { label: "Unknown tier", ...tierPalette.unknown, taxonomy: "unknown", tooltip: `Unknown tier: unrecognized ${version === "crystal-v2" || version === "legacy-v1" ? "code" : "taxonomy version"}.` };
}
