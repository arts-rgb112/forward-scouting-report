import type { ShotmapPoint } from "../dashboard/types";

import type { ShotOutcome } from "./shotOutcomeVisibility";

/** The only pitch-shot marker vocabulary used by the four-tab workspace. */
const presentation: Record<ShotOutcome, { resultColor: string; strokeOpacity: number; strokeWidth: number; reachesFrame: boolean }> = {
  goal: { resultColor: "#BEF264", strokeOpacity: 1, strokeWidth: 1.6, reachesFrame: true },
  on_target: { resultColor: "#38BDF8", strokeOpacity: 1, strokeWidth: 1.45, reachesFrame: true },
  off_target: { resultColor: "#E2E8F0", strokeOpacity: .75, strokeWidth: 1.3, reachesFrame: false },
  blocked: { resultColor: "#94A3B8", strokeOpacity: .7, strokeWidth: 1.3, reachesFrame: false },
};

/** Paint order is intentionally independent of the API/source order. */
export const pitchShotPaintOrder: readonly ShotOutcome[] = ["off_target", "blocked", "on_target", "goal"];

export type PitchShotGroup = {
  key: string;
  shot: ShotmapPoint;
  sourceIndexes: readonly number[];
  outcome: ShotOutcome;
  count: number;
  outcomeCounts: Readonly<Record<ShotOutcome, number>>;
};

const outcomeRank = (outcome: ShotOutcome) => pitchShotPaintOrder.indexOf(outcome);
/** Raw source numbers are the identity; rounded display coordinates must never merge events. */
const coordinateKey = (shot: ShotmapPoint) => `${shot.x}:${shot.y}`;

const stackLabels: Record<ShotOutcome, string> = { goal: "득점", on_target: "유효", off_target: "빗나감", blocked: "블록" };

export function stackCompositionLabel(outcomeCounts: Readonly<Record<ShotOutcome, number>>) {
  return pitchShotPaintOrder.slice().reverse().flatMap((outcome) => outcomeCounts[outcome] > 0 ? [`${stackLabels[outcome]} ${outcomeCounts[outcome]}`] : []).join(" · ");
}

/**
 * Exact coordinate collisions are rendered once, never jittered.  If several
 * outcomes share an anchor, the top paint-order outcome represents the stack.
 */
export function groupPitchShots(shots: readonly { shot: ShotmapPoint; sourceIndex: number }[]): PitchShotGroup[] {
  const groups = new Map<string, { shot: ShotmapPoint; sourceIndexes: number[]; outcome: ShotOutcome; outcomeCounts: Record<ShotOutcome, number> }>();
  for (const entry of shots) {
    const key = coordinateKey(entry.shot);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { shot: entry.shot, sourceIndexes: [entry.sourceIndex], outcome: entry.shot.outcome, outcomeCounts: { goal: entry.shot.outcome === "goal" ? 1 : 0, on_target: entry.shot.outcome === "on_target" ? 1 : 0, off_target: entry.shot.outcome === "off_target" ? 1 : 0, blocked: entry.shot.outcome === "blocked" ? 1 : 0 } });
      continue;
    }
    current.sourceIndexes.push(entry.sourceIndex);
    current.outcomeCounts[entry.shot.outcome]++;
    if (outcomeRank(entry.shot.outcome) >= outcomeRank(current.outcome)) {
      current.shot = entry.shot;
      current.outcome = entry.shot.outcome;
    }
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group, count: group.sourceIndexes.length }))
    .sort((left, right) => outcomeRank(left.outcome) - outcomeRank(right.outcome) || left.sourceIndexes[0] - right.sourceIndexes[0]);
}

const pentagonPath = (radius: number) => Array.from({ length: 5 }, (_, index) => {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / 5;
  const x = Math.cos(angle) * radius * .42;
  const y = Math.sin(angle) * radius * .42;
  return `${index ? "L" : "M"}${x.toFixed(3)} ${y.toFixed(3)}`;
}).join(" ") + " Z";

export function PitchShotMarker({ outcome, radius, count = 1, outcomeCounts, expandedStack = false }: { outcome: ShotOutcome; radius: number; count?: number; outcomeCounts?: Readonly<Record<ShotOutcome, number>>; expandedStack?: boolean }) {
  const style = presentation[outcome];
  const hasPattern = radius >= 7;
  const patternColor = style.reachesFrame ? "#111827" : style.resultColor;
  return <g data-pitch-shot-marker data-marker-radius={radius} data-marker-pattern={hasPattern ? "full" : "circle"} data-marker-outcome={outcome}>
    <circle data-marker-halo r={radius + Math.max(1.1, radius * .16)} fill="none" stroke="#0A1F10" strokeWidth={Math.max(2.2, radius * .34)} vectorEffect="non-scaling-stroke" />
    <circle data-pitch-shot-glyph data-marker-result-color={style.resultColor} r={radius} fill={style.reachesFrame ? "#F8FAFC" : "#0B1220"} fillOpacity={style.reachesFrame ? 1 : .35} stroke={style.resultColor} strokeOpacity={style.strokeOpacity} strokeWidth={Math.max(style.strokeWidth, outcome === "goal" ? radius * .3 : radius * .16)} vectorEffect="non-scaling-stroke" />
    {hasPattern && <path data-marker-pentagon d={pentagonPath(radius)} fill={style.reachesFrame ? "#111827" : "none"} stroke={patternColor} strokeOpacity={style.reachesFrame ? 1 : style.strokeOpacity} strokeWidth={Math.max(.75, radius * .1)} vectorEffect="non-scaling-stroke" />}
    {hasPattern && Array.from({ length: 5 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / 5;
      const inner = radius * .42, outer = radius * .95;
      return <line key={index} data-marker-spoke x1={Math.cos(angle) * inner} y1={Math.sin(angle) * inner} x2={Math.cos(angle) * outer} y2={Math.sin(angle) * outer} stroke={patternColor} strokeOpacity={style.reachesFrame ? .9 : style.strokeOpacity} strokeWidth={Math.max(.65, radius * .08)} vectorEffect="non-scaling-stroke" />;
    })}
    {outcome === "blocked" && <line data-marker-block-bar x1={-radius * .7} y1="0" x2={radius * .7} y2="0" stroke={style.resultColor} strokeOpacity={style.strokeOpacity} strokeWidth={Math.max(1, radius * .28)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    {count > 1 && (() => { const composition = outcomeCounts ? stackCompositionLabel(outcomeCounts) : ""; const mixed = outcomeCounts && Object.values(outcomeCounts).filter((value) => value > 0).length > 1; const label = expandedStack && mixed ? `×${count} · ${composition}` : `×${count}`; const width = expandedStack && mixed ? Math.max(radius * 3.8, label.length * Math.max(3.4, radius * .38)) : Math.max(7.4, radius * 1.1); return <g data-marker-count-badge data-marker-stack-composition={mixed ? composition : undefined} data-marker-stack-expanded={expandedStack && mixed ? "true" : "false"} transform={`translate(${radius * .72} ${-radius * .72})`}><rect x={-width / 2} y={-Math.max(3.7, radius * .55)} width={width} height={Math.max(7.4, radius * 1.1)} rx={Math.max(3.7, radius * .55)} fill="#0A1F10" stroke={mixed ? "#FBBF24" : "#F8FAFC"} strokeOpacity=".9" strokeWidth={mixed ? "1.2" : ".7"} strokeDasharray={mixed ? "2 1" : undefined} vectorEffect="non-scaling-stroke" />{mixed && !expandedStack && <circle data-marker-mixed-stack-indicator cx={width / 2 - 1.7} cy={-Math.max(3.7, radius * .55) + 1.7} r="1.35" fill="#FBBF24" />}<text textAnchor="middle" dominantBaseline="central" fill="#F8FAFC" fontSize={Math.max(5.5, radius * .7)} fontWeight="900">{label}</text></g>; })()}
  </g>;
}

export function medianObservedXg(shots: readonly Pick<ShotmapPoint, "xg">[]) {
  const values = shots.map((shot) => shot.xg).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** xG controls marker footprint; result is encoded only by the marker treatment. */
export function pitchMarkerRadius(xg: number | null | undefined, medianXg: number | null = null) {
  const sourceXg = typeof xg === "number" && Number.isFinite(xg) && xg >= 0 ? xg : medianXg;
  // If an entire payload has no xG, the visual centre remains neutral while its label says xG 미상.
  const visualXg = typeof sourceXg === "number" && Number.isFinite(sourceXg) && sourceXg >= 0 ? sourceXg : .25;
  return 3 + 7 * Math.sqrt(visualXg);
}
