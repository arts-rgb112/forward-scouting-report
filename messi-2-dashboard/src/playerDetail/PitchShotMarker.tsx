import type { ShotmapPoint } from "../dashboard/types";

import type { ShotOutcome } from "./shotOutcomeVisibility";

/** The only pitch-shot marker vocabulary used by the four-tab workspace. */
const presentation: Record<ShotOutcome, { fill: string; stroke: string; strokeOpacity: number; strokeWidth: number }> = {
  goal: { fill: "#BEF264", stroke: "#0A1F10", strokeOpacity: 1, strokeWidth: 1.4 },
  on_target: { fill: "#38BDF8", stroke: "#0A1F10", strokeOpacity: 1, strokeWidth: 1.1 },
  off_target: { fill: "none", stroke: "#E2E8F0", strokeOpacity: .65, strokeWidth: 1.2 },
  blocked: { fill: "none", stroke: "#94A3B8", strokeOpacity: .6, strokeWidth: 1.2 },
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

export function PitchShotMarker({ outcome, radius, count = 1, outcomeCounts }: { outcome: ShotOutcome; radius: number; count?: number; outcomeCounts?: Readonly<Record<ShotOutcome, number>> }) {
  const style = presentation[outcome];
  const hasPentagon = radius >= 5;
  const hasSpokes = radius >= 9;
  return <g data-pitch-shot-marker data-marker-radius={radius} data-marker-pattern={hasSpokes ? "full" : hasPentagon ? "pentagon" : "circle"} data-marker-outcome={outcome}>
    <circle data-pitch-shot-glyph r={radius} fill={style.fill} stroke={style.stroke} strokeOpacity={style.strokeOpacity} strokeWidth={style.strokeWidth} vectorEffect="non-scaling-stroke" />
    {hasPentagon && <path data-marker-pentagon d={pentagonPath(radius)} fill={outcome === "off_target" ? "none" : "#0A1F10"} fillOpacity={outcome === "on_target" ? .75 : 1} stroke={outcome === "off_target" ? style.stroke : "#0A1F10"} strokeOpacity={outcome === "off_target" ? style.strokeOpacity : 1} strokeWidth={Math.max(.7, radius * .1)} vectorEffect="non-scaling-stroke" />}
    {hasSpokes && Array.from({ length: 5 }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / 5;
      const inner = radius * .42, outer = radius * .95;
      return <line key={index} data-marker-spoke x1={Math.cos(angle) * inner} y1={Math.sin(angle) * inner} x2={Math.cos(angle) * outer} y2={Math.sin(angle) * outer} stroke={outcome === "off_target" ? style.stroke : "#0A1F10"} strokeOpacity={outcome === "off_target" ? style.strokeOpacity : .9} strokeWidth={Math.max(.65, radius * .08)} vectorEffect="non-scaling-stroke" />;
    })}
    {outcome === "blocked" && <line data-marker-block-bar x1={-radius * .7} y1="0" x2={radius * .7} y2="0" stroke={style.stroke} strokeOpacity={style.strokeOpacity} strokeWidth={Math.max(1, radius * .28)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    {count > 1 && (() => { const composition = outcomeCounts ? stackCompositionLabel(outcomeCounts) : ""; const mixed = outcomeCounts && Object.values(outcomeCounts).filter((value) => value > 0).length > 1; const label = mixed ? `×${count} · ${composition}` : `×${count}`; const width = mixed ? Math.max(radius * 3.8, label.length * Math.max(3.4, radius * .38)) : Math.max(7.4, radius * 1.1); return <g data-marker-count-badge data-marker-stack-composition={mixed ? composition : undefined} transform={`translate(${radius * .72} ${-radius * .72})`}><rect x={-width / 2} y={-Math.max(3.7, radius * .55)} width={width} height={Math.max(7.4, radius * 1.1)} rx={Math.max(3.7, radius * .55)} fill="#0A1F10" stroke="#F8FAFC" strokeOpacity=".8" strokeWidth=".7" vectorEffect="non-scaling-stroke" /><text textAnchor="middle" dominantBaseline="central" fill="#F8FAFC" fontSize={Math.max(5.5, radius * .7)} fontWeight="900">{label}</text></g>; })()}
  </g>;
}

export const pitchMarkerRadius = (outcome: ShotOutcome) => ({ goal: 4.5, on_target: 4.1, off_target: 3.9, blocked: 3.7 })[outcome];
