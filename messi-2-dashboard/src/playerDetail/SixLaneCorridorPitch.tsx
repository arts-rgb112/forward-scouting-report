import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { HeatmapCanvas } from "./LegacySpatialPitch";
import { legacyDensityGrid, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { CCA_STYLE, ZONE20 } from "./pitchGeometry";
import type { PitchLayerVisibility } from "./pitchLayers";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { excludePenaltyShots, isPenaltyShot } from "./pitchPenalties";
import { shotIntegrity } from "./shotOutcomeVisibility";

const COPY = {
  fieldLabel: "6레인 슈팅 회랑",
  tableLabel: "레인별 슈팅·활동 요약",
  pending: "정확한 6레인 서버 집계가 아직 연결되지 않아 브라우저에서 값을 만들지 않았습니다.",
  reading: "레인별 슛·득점·xG·활동 비율은 서버 집계가 준비되면 이 위치에 표시됩니다.",
  penalty: "페널티는 PK 축 위라 레인에 배정하지 않고 항상 별도로 표시합니다.",
  attack: "공격 방향 →",
  zoom: "2D 확대/축소",
  reset: "초기화",
  zoneInfo: "선택 구역 정보",
} as const;

const LANES = [
  { id: "L5", label: "좌 외곽", low: 78.18, high: 100, fill: "#64748B", opacity: .10 },
  { id: "L4", label: "좌 하프", low: 63, high: 78.18, fill: "#BEF264", opacity: .10 },
  // The approved revision removes the former brown L3 tint; boundaries and labels do the separating.
  { id: "L3L", label: "중좌", low: 50, high: 63, fill: "#FFFFFF", opacity: 0 },
  { id: "L3R", label: "중우", low: 37, high: 50, fill: "#FFFFFF", opacity: 0 },
  { id: "L2", label: "우 하프", low: 21.82, high: 37, fill: "#BEF264", opacity: .10 },
  { id: "L1", label: "우 외곽", low: 0, high: 21.82, fill: "#64748B", opacity: .10 },
] as const;

const world = (shot: Pick<ShotmapPoint, "x" | "y">) => ({ x: shot.x * 1.05, y: (100 - shot.y) * .68 });
const lineY = (sourceY: number) => (100 - sourceY) * .68;

function PitchLines() {
  return <g data-layer="six-lane-markings" fill="none" vectorEffect="non-scaling-stroke">
    <rect x="0" y="0" width="105" height="68" stroke="#FFFFFF" strokeOpacity=".5" strokeWidth=".42" />
    <path d="M52.5 0V68M0 34H105M52.5 27.9a6.2 6.2 0 1 0 0 12.4a6.2 6.2 0 1 0 0-12.4" stroke="#FFFFFF" strokeOpacity=".32" strokeWidth=".35" />
    <path d="M0 13.84H16.54V54.16H0M105 13.84H88.46V54.16H105" stroke="#FFFFFF" strokeOpacity=".36" strokeWidth=".42" />
    <path d="M0 24.84H5.51V43.16H0M105 24.84H99.49V43.16H105" stroke="#FFFFFF" strokeOpacity=".3" strokeWidth=".35" />
  </g>;
}

function CorridorShotMarker({ shot }: { shot: ShotmapPoint }) {
  if (shot.outcome === "goal") return <circle r="1.45" fill="#BEF264" stroke="#0A1F10" strokeWidth=".35" />;
  if (shot.outcome === "on_target") return <circle r="1.45" fill="#38BDF8" stroke="#0A1F10" strokeWidth=".35" />;
  if (shot.outcome === "off_target") return <path d="M-1.5 -1.5L1.5 1.5M1.5 -1.5L-1.5 1.5" fill="none" stroke="#E2E8F0" strokeOpacity=".85" strokeWidth=".5" vectorEffect="non-scaling-stroke"/>;
  return <circle r="1.45" fill="none" stroke="#94A3B8" strokeOpacity=".9" strokeWidth=".5" vectorEffect="non-scaling-stroke"/>;
}

function GuardiolaDepthGrid() {
  const wide = ZONE20.depthWide.slice(1, -1);
  const centre = [15.71, 50, 84.29];
  return <g data-layer="positional-grid" fill="none" stroke="#FFFFFF" strokeOpacity=".13" strokeWidth=".34" vectorEffect="non-scaling-stroke">
    {wide.map((depth) => <path key={`wide-${depth}`} d={`M${(depth * 1.05).toFixed(4)} 0V68`}/>)}
    {centre.map((depth) => <path key={`centre-${depth}`} d={`M${(depth * 1.05).toFixed(4)} ${(lineY(78.18)).toFixed(4)}V${(lineY(21.82)).toFixed(4)}`}/>)}
  </g>;
}

const contourPath = (segments: readonly (readonly [number, number, number, number])[]) => segments.map(([x1, y1, x2, y2]) => {
  const start = world({ x: x1, y: y1 }), end = world({ x: x2, y: y2 });
  return `M${start.x.toFixed(4)} ${start.y.toFixed(4)}L${end.x.toFixed(4)} ${end.y.toFixed(4)}`;
}).join("");

export function SixLaneCorridorPitch({ analysis, layers }: { analysis?: PlayerAnalysis; layers: PitchLayerVisibility }) {
  const spatial = analysis?.spatial;
  const shots = spatial?.shotmapPoints;
  const { includePenalties } = usePitchPenalty();
  const stageRef = useRef<HTMLDivElement>(null);
  const touchPoints = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; zoom: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selectedShot, setSelectedShot] = useState<ShotmapPoint | null>(null);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const validShots = Boolean(shots && shotIntegrity(analysis?.spatial));
  const validHeat = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100));
  const displayedShots = useMemo(() => validShots ? excludePenaltyShots(shots!, includePenalties) : [], [includePenalties, shots, validShots]);
  const penalties = useMemo(() => validShots ? shots!.filter(isPenaltyShot) : [], [shots, validShots]);
  const normalized = useMemo(() => validHeat ? normalizeDensity(legacyDensityGrid(spatial!.heatmapPoints)) : undefined, [spatial?.heatmapPoints, validHeat]);
  const contour = useMemo(() => normalized && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [], [normalized, spatial?.continuousCore.available, spatial?.continuousCore.thresholdOfPeak]);
  const markerDescription = validShots ? `${includePenalties ? "PK 포함" : "PK 제외"} 슛 ${displayedShots.length}발, 페널티 ${penalties.length}발 별도` : "서버 슈팅 스냅샷 사용 불가";
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); setZoom((current) => Math.min(3, Math.max(1, current + (event.deltaY < 0 ? .2 : -.2)))); };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);
  const zoneAt = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.defaultPrevented) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = Math.min(100, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * 100));
    const y = Math.min(100, Math.max(0, 100 - ((event.clientY - bounds.top) / bounds.height) * 100));
    const lane = LANES.find((candidate) => y >= candidate.low && y < candidate.high) ?? LANES[LANES.length - 1];
    const depth = Math.min(6, Math.max(1, Math.ceil(x / (100 / 6))));
    setSelectedZone(`${lane.id} · 깊이 ${depth}`);
  };
  const finishPointer = (pointerId: number) => { touchPoints.current.delete(pointerId); if (touchPoints.current.size < 2) pinch.current = null; };

  return <section data-layout="six-lane-corridor-pitch" className="rounded-xl border border-white/10 bg-[#0b1011] p-3" aria-label={COPY.fieldLabel}>
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem] xl:items-start">
      <figure className="min-w-0" aria-describedby="six-lane-corridor-caption">
        <div ref={stageRef} className="relative overflow-hidden rounded-lg border border-white/10 bg-[#123A20] touch-none" style={{ aspectRatio: "105 / 68" }}>
          <div className="absolute inset-0 origin-center" style={{ transform: `scale(${zoom})` }}>
          <HeatmapCanvas points={validHeat ? spatial!.heatmapPoints : []} enabled={layers.heatmap && validHeat} opacity={.62}/>
          <svg viewBox="-2 -2 109 72" role="img" aria-label={`${COPY.fieldLabel}. ${markerDescription}`} className="h-full w-full" onClick={zoneAt} onPointerDown={(event) => { if (event.pointerType !== "touch") return; touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touchPoints.current.size === 2) { const points = [...touchPoints.current.values()]; pinch.current = { gap: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), zoom }; } event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={(event) => { if (event.pointerType !== "touch" || !touchPoints.current.has(event.pointerId) || !pinch.current || touchPoints.current.size !== 2) return; touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); const points = [...touchPoints.current.values()]; const gap = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y); if (gap > 0) setZoom(Math.min(3, Math.max(1, pinch.current.zoom * gap / pinch.current.gap))); }} onPointerUp={(event) => finishPointer(event.pointerId)} onPointerCancel={(event) => finishPointer(event.pointerId)}>
            {LANES.map((lane) => {
              const y = lineY(lane.high);
              const height = lineY(lane.low) - y;
              return <g key={lane.id} data-lane={lane.id}><rect x="0" y={y} width="105" height={height} fill={lane.fill} fillOpacity={lane.opacity}/></g>;
            })}
            <PitchLines />
            <GuardiolaDepthGrid />
            {LANES.slice(1).map((lane) => <path key={lane.id} d={`M0 ${lineY(lane.high)}H105`} stroke="#FFFFFF" strokeOpacity=".26" strokeWidth=".34" vectorEffect="non-scaling-stroke" />)}
            {layers.cca && contour.length > 0 && <path data-layer="cca-contour" d={contourPath(contour)} fill="none" stroke={CCA_STYLE.stroke} strokeOpacity={CCA_STYLE.opacity} strokeWidth={CCA_STYLE.width * .42} strokeDasharray={CCA_STYLE.dash} vectorEffect="non-scaling-stroke"/>}
            <circle cx="93.999" cy="34" r="1.1" fill="#FFFFFF" fillOpacity=".8" />
            <circle cx="93.999" cy="34" r="2.9" fill="none" stroke="#FBBF24" strokeOpacity=".9" strokeWidth=".45" strokeDasharray="1.2 .9" vectorEffect="non-scaling-stroke" />
            {layers.trajectories && <g data-layer="shot-trajectories-2d" fill="none" pointerEvents="none">{displayedShots.map((shot, index) => shot.trajectory ? <path key={index} d={`M${world(shot).x.toFixed(4)} ${world(shot).y.toFixed(4)}L${(shot.trajectory.endX * 1.05).toFixed(4)} ${((100 - shot.trajectory.endY) * .68).toFixed(4)}`} stroke="#E2E8F0" strokeOpacity=".24" strokeWidth=".28" vectorEffect="non-scaling-stroke"/> : null)}</g>}
            {layers.markers && displayedShots.map((shot, index) => {
              const point = world(shot);
              return <g key={index} transform={`translate(${point.x.toFixed(4)} ${point.y.toFixed(4)})`} role="button" tabIndex={0} aria-label={`${shot.outcome} 슛 상세`} onClick={(event) => { event.stopPropagation(); setSelectedShot(shot); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedShot(shot); } }}><CorridorShotMarker shot={shot}/></g>;
            })}
          </svg>
          </div>
          <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] font-semibold text-zinc-300">{COPY.attack}</span>
        </div>
        <div role="group" aria-label={COPY.zoom} className="mt-2 flex items-center gap-1"><button type="button" aria-label="축소" onClick={() => setZoom((current) => Math.max(1, current - .2))} disabled={zoom <= 1} className="min-h-8 min-w-8 rounded border border-white/15 font-bold disabled:opacity-40">−</button><button type="button" aria-label="확대" onClick={() => setZoom((current) => Math.min(3, current + .2))} disabled={zoom >= 3} className="min-h-8 min-w-8 rounded border border-white/15 font-bold disabled:opacity-40">+</button><button type="button" onClick={() => setZoom(1)} className="min-h-8 rounded border border-white/15 px-2 text-xs font-bold">{COPY.reset}</button><span aria-live="polite" className="ml-1 text-xs text-zinc-400">{zoom.toFixed(1)}배</span></div>
        <figcaption id="six-lane-corridor-caption" className="mt-2 text-xs text-zinc-400">{markerDescription} · {COPY.penalty}</figcaption>
      </figure>
      <aside className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-3" aria-label={COPY.tableLabel}>
        <table className="w-full text-xs"><thead className="text-zinc-500"><tr><th className="pb-2 text-left">레인</th><th className="pb-2 text-right">슛</th><th className="pb-2 text-right">득점</th><th className="pb-2 text-right">xG</th><th className="pb-2 text-right">활동</th></tr></thead><tbody>{LANES.map((lane) => <tr key={lane.id} className="border-t border-white/10"><th className="py-2 text-left font-semibold text-zinc-200">{lane.id} · {lane.label}</th><td className="text-right text-zinc-500">—</td><td className="text-right text-zinc-500">—</td><td className="text-right text-zinc-500">—</td><td className="text-right text-zinc-500">—</td></tr>)}</tbody></table>
        <p role="status" className="mt-3 text-xs text-amber-200">{COPY.pending}</p>
      </aside>
    </div>
    {(selectedShot || selectedZone) && <aside data-layout="corridor-inspector" className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-zinc-300" aria-label={selectedShot ? "슈팅 상세" : COPY.zoneInfo}>{selectedShot ? <>슛 상세 · xG {typeof selectedShot.xg === "number" ? selectedShot.xg.toFixed(2) : "—"} · xGOT {typeof selectedShot.xgot === "number" ? selectedShot.xgot.toFixed(2) : "—"}</> : <>{COPY.zoneInfo} · {selectedZone} · 슛 — · 득점 — · xG — · 히트맵 점유 —</>}</aside>}
    <div className="mt-3 border-t border-white/10 pt-3 text-xs leading-5 text-zinc-300"><b className="text-zinc-100">판독</b> · {COPY.reading}</div>
  </section>;
}
