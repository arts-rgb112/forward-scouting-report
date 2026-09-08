import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import type { FullActivityHeatmapData } from "../api/fullActivityHeatmapContracts";
import { HeatmapCanvas } from "./LegacySpatialPitch";
import { legacyDensityGrid, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { CCA_STYLE, ZONE20 } from "./pitchGeometry";
import { groupPitchShots, stackCompositionLabel, type PitchShotGroup } from "./PitchShotMarker";
import type { PitchLayerVisibility } from "./pitchLayers";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { BoxSubregionPanel } from "./BoxSubregionPanel";
import type { BoxSubregionStatsState } from "./useBoxSubregionStats";
import { BOX_SUBREGION_BOUNDS, BOX_SUBREGION_ORDER, resolveBoxSubregionId, type BoxSubregionRegion } from "../api/boxSubregionContracts";
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
// The <svg viewBox="-2 -2 109 72"> below is NOT the same aspect ratio as the
// 105×68 pitch it draws (109/72 ≈ 1.514 vs 105/68 ≈ 1.544), so the browser's
// default preserveAspectRatio="xMidYMid meet" letterboxes it — the rendered
// content occupies less than the full element box on one axis, centred.
// A click handler that just divides (clientX-left) by the element's full
// width therefore drifts from the real pitch coordinate by the letterbox
// margin. This reproduces exactly what the browser does, from the same
// constants the markup itself uses, so it works under both real layout and
// a stubbed getBoundingClientRect() in tests — no getScreenCTM dependency,
// which jsdom does not implement.
export const CORRIDOR_VIEW_BOX = { x: -2, y: -2, width: 109, height: 72 } as const;
function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / CORRIDOR_VIEW_BOX.width, rect.height / CORRIDOR_VIEW_BOX.height);
  const offsetX = (rect.width - CORRIDOR_VIEW_BOX.width * scale) / 2;
  const offsetY = (rect.height - CORRIDOR_VIEW_BOX.height * scale) / 2;
  return {
    x: (clientX - rect.left - offsetX) / scale + CORRIDOR_VIEW_BOX.x,
    y: (clientY - rect.top - offsetY) / scale + CORRIDOR_VIEW_BOX.y,
  };
}

/** The exact forward transform (pitch-percent → real screen point), given a
 * concrete element rect — the inverse of the letterbox-aware math above.
 * Exported purely so tests can synthesize a real click position without
 * duplicating (and silently drifting from) that math by hand. */
export function corridorClientPointForPitchPercent(rect: { left: number; top: number; width: number; height: number }, x: number, y: number) {
  const scale = Math.min(rect.width / CORRIDOR_VIEW_BOX.width, rect.height / CORRIDOR_VIEW_BOX.height);
  const offsetX = (rect.width - CORRIDOR_VIEW_BOX.width * scale) / 2;
  const offsetY = (rect.height - CORRIDOR_VIEW_BOX.height * scale) / 2;
  const local = world({ x, y });
  return {
    clientX: rect.left + offsetX + (local.x - CORRIDOR_VIEW_BOX.x) * scale,
    clientY: rect.top + offsetY + (local.y - CORRIDOR_VIEW_BOX.y) * scale,
  };
}
/** Disabled: the approved small marker set remains readable without proximity merging. */
export const CORRIDOR_CLUSTER_DISTANCE = 0;
export const CORRIDOR_MARKER_RADIUS = {
  goal: .72,
  on_target: .56,
  off_target: .5,
  blocked: .5,
} as const;
export type CorridorShotCluster = PitchShotGroup & { shots: readonly ShotmapPoint[] };
export type SelectedCorridorZone = { kind: "legacy"; label: string } | { kind: "box"; id: (typeof BOX_SUBREGION_ORDER)[number] };

/** Renders the exact selected server box record — real xG/quality/shares,
 * never a browser-computed stand-in — or an honest unavailable state keyed
 * to the box's own fixed label/bounds while the route is still 404ing. */
function BoxZoneInspector({ id, boxSubregion }: { id: (typeof BOX_SUBREGION_ORDER)[number]; boxSubregion?: BoxSubregionStatsState }) {
  const bounds = BOX_SUBREGION_BOUNDS[id];
  const region: BoxSubregionRegion | undefined = boxSubregion?.kind === "ready" ? boxSubregion.data.regions.find((candidate) => candidate.id === id) : undefined;
  if (!region || region.shots === null) return <p data-corridor-box-zone={id} data-corridor-box-zone-state="unavailable">{COPY.zoneInfo} · {bounds.label} · 박스 구역 통계를 사용할 수 없습니다.</p>;
  return <div data-corridor-box-zone={id} data-corridor-box-zone-state="ready">
    <p>{COPY.zoneInfo} · {region.label}</p>
    <p className="mt-1">슛 {region.shots} · 득점 {region.goals} · xG {region.xg === null ? "—" : region.xg.toFixed(2)}</p>
    <p className="mt-1">활동 {region.activitySharePct === null ? "—" : `${region.activitySharePct.toFixed(1)}%`} · 슈팅 {region.shootingSharePct === null ? "—" : `${region.shootingSharePct.toFixed(1)}%`}</p>
    <p className="mt-1" data-corridor-box-zone-quality={region.quality.state}>
      {region.quality.state === "unavailable" ? "xGOT−xG —" : `xGOT−xG ${region.quality.delta! >= 0 ? "+" : ""}${region.quality.delta!.toFixed(2)} · 적격 ${region.quality.eligible}/${region.shots}`}
    </p>
  </div>;
}

/**
 * First preserve exact raw-coordinate stacks, then deterministically merge
 * visual collisions. The source list remains intact for the accessible detail
 * panel; no provider event is discarded or browser-aggregated into a metric.
 */
export function clusterCorridorShotGroups(groups: readonly PitchShotGroup[], displayedShots: readonly ShotmapPoint[]): CorridorShotCluster[] {
  const rank = { off_target: 0, blocked: 1, on_target: 2, goal: 3 } as const;
  const mutable: Array<{ groups: PitchShotGroup[]; anchor: PitchShotGroup }> = [];
  for (const group of [...groups].sort((left, right) => left.sourceIndexes[0] - right.sourceIndexes[0])) {
    const point = world(group.shot);
    const target = mutable.find((candidate) => {
      const anchor = world(candidate.anchor.shot);
      return Math.hypot(point.x - anchor.x, point.y - anchor.y) <= CORRIDOR_CLUSTER_DISTANCE;
    });
    if (target) target.groups.push(group);
    else mutable.push({ groups: [group], anchor: group });
  }
  return mutable.map(({ groups: clustered }) => {
    const sourceIndexes = clustered.flatMap((group) => group.sourceIndexes).sort((left, right) => left - right);
    const outcomeCounts = { goal: 0, on_target: 0, off_target: 0, blocked: 0 };
    let representative = clustered[0];
    for (const group of clustered) {
      outcomeCounts.goal += group.outcomeCounts.goal;
      outcomeCounts.on_target += group.outcomeCounts.on_target;
      outcomeCounts.off_target += group.outcomeCounts.off_target;
      outcomeCounts.blocked += group.outcomeCounts.blocked;
      if (rank[group.outcome] >= rank[representative.outcome]) representative = group;
    }
    return { key: `cluster:${sourceIndexes.join(",")}`, shot: representative.shot, outcome: representative.outcome, sourceIndexes, count: sourceIndexes.length, outcomeCounts, shots: sourceIndexes.map((index) => displayedShots[index]).filter((shot): shot is ShotmapPoint => Boolean(shot)) };
  }).sort((left, right) => rank[left.outcome] - rank[right.outcome] || left.sourceIndexes[0] - right.sourceIndexes[0]);
}

function PitchLines() {
  return <g data-layer="six-lane-markings" fill="none" vectorEffect="non-scaling-stroke">
    <rect x="0" y="0" width="105" height="68" stroke="#FFFFFF" strokeOpacity=".5" strokeWidth=".42" />
    <path d="M52.5 0V68M0 34H105M52.5 27.9a6.2 6.2 0 1 0 0 12.4a6.2 6.2 0 1 0 0-12.4" stroke="#FFFFFF" strokeOpacity=".32" strokeWidth=".35" />
    <path d="M0 13.84H16.54V54.16H0M105 13.84H88.46V54.16H105" stroke="#FFFFFF" strokeOpacity=".36" strokeWidth=".42" />
    <path d="M0 24.84H5.51V43.16H0M105 24.84H99.49V43.16H105" stroke="#FFFFFF" strokeOpacity=".3" strokeWidth=".35" />
  </g>;
}

function CorridorShotMarker({ group }: { group: PitchShotGroup }) {
  const { shot, count, outcomeCounts } = group;
  const radius = CORRIDOR_MARKER_RADIUS[shot.outcome];
  const marker = shot.outcome === "goal"
    ? <circle data-marker-radius={radius} r={radius} fill="#BEF264" stroke="#0A1F10" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    : shot.outcome === "on_target"
      ? <circle data-marker-radius={radius} r={radius} fill="#38BDF8" stroke="#0A1F10" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      : shot.outcome === "off_target"
        ? <path data-marker-radius={radius} d={`M${-radius} ${-radius}L${radius} ${radius}M${radius} ${-radius}L${-radius} ${radius}`} fill="none" stroke="#94A3B8" strokeOpacity=".55" strokeWidth="1.1" vectorEffect="non-scaling-stroke"/>
        : <circle data-marker-radius={radius} r={radius} fill="none" stroke="#E2E8F0" strokeOpacity=".6" strokeWidth="1.1" vectorEffect="non-scaling-stroke"/>;
  return <>
    {/* Painted first (so it sits behind the marker/badge) and outline-only
        (fill="none"): even at opacity 1 it frames the cluster, it never
        fills over the ×N count or a neighbouring shot. */}
    <circle className="corridor-focus-ring" r={radius + 1.1} fill="none" stroke="#F8FAFC" strokeWidth="1" vectorEffect="non-scaling-stroke" pointerEvents="none" />
    {marker}
    {count > 1 && <g data-corridor-shot-stack aria-hidden="true" transform={`translate(${radius * .8} ${-radius * .8}) scale(.5)`}><circle r="1.45" fill="#0A1F10" stroke="#F8FAFC" strokeWidth=".32" vectorEffect="non-scaling-stroke"/><text transform="scale(.18)" y="2.3" textAnchor="middle" fill="#F8FAFC" fontSize="12" fontWeight="900">×{count}</text></g>}
  </>;
}

function GuardiolaDepthGrid() {
  const wide = ZONE20.depthWide.slice(1, -1);
  const centre = [15.71, 50, 84.29];
  return <g data-layer="positional-grid" fill="none" stroke="#FFFFFF" strokeOpacity=".13" strokeWidth=".34" vectorEffect="non-scaling-stroke">
    {wide.map((depth) => <path key={`wide-${depth}`} d={`M${(depth * 1.05).toFixed(4)} 0V68`}/>)}
    {centre.map((depth) => <path key={`centre-${depth}`} d={`M${(depth * 1.05).toFixed(4)} ${(lineY(78.18)).toFixed(4)}V${(lineY(21.82)).toFixed(4)}`}/>)}
  </g>;
}

export const corridorContourPath = (segments: readonly (readonly [number, number, number, number])[]) => segments.map(([x1, y1, x2, y2]) => {
  // marchingSquares already returns screen Y (100 - provider Y).
  const start = { x: x1 * 1.05, y: y1 * .68 }, end = { x: x2 * 1.05, y: y2 * .68 };
  return `M${start.x.toFixed(4)} ${start.y.toFixed(4)}L${end.x.toFixed(4)} ${end.y.toFixed(4)}`;
}).join("");

export function SixLaneCorridorPitch({ analysis, layers, fullActivityHeatmap, boxSubregion }: { analysis?: PlayerAnalysis; layers: PitchLayerVisibility; fullActivityHeatmap?: FullActivityHeatmapData; boxSubregion?: BoxSubregionStatsState }) {
  const spatial = analysis?.spatial;
  const shots = spatial?.shotmapPoints;
  const { includePenalties } = usePitchPenalty();
  const stageRef = useRef<HTMLDivElement>(null);
  const touchPoints = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ gap: number; zoom: number } | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const moved = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedCluster, setSelectedCluster] = useState<CorridorShotCluster | null>(null);
  const [selectedZone, setSelectedZone] = useState<SelectedCorridorZone | null>(null);
  const validShots = Boolean(shots && shotIntegrity(analysis?.spatial));
  const validHeat = Boolean(spatial?.available && spatial.heatmapPointCount === spatial.heatmapPoints.length && spatial.heatmapPoints.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100));
  const displayedShots = useMemo(() => validShots ? excludePenaltyShots(shots!, includePenalties) : [], [includePenalties, shots, validShots]);
  const markerGroups = useMemo(() => clusterCorridorShotGroups(groupPitchShots(displayedShots.map((shot, sourceIndex) => ({ shot, sourceIndex }))), displayedShots), [displayedShots]);
  const penalties = useMemo(() => validShots ? shots!.filter(isPenaltyShot) : [], [shots, validShots]);
  const normalized = useMemo(() => validHeat ? normalizeDensity(legacyDensityGrid(spatial!.heatmapPoints)) : undefined, [spatial?.heatmapPoints, validHeat]);
  const contour = useMemo(() => normalized && spatial?.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalized, spatial.continuousCore.thresholdOfPeak) : [], [normalized, spatial?.continuousCore.available, spatial?.continuousCore.thresholdOfPeak]);
  const markerDescription = validShots ? `${includePenalties ? "PK 포함" : "PK 제외"} 슛 ${displayedShots.length}발, 페널티 ${penalties.length}발 별도` : "서버 슈팅 스냅샷 사용 불가";
  const clampPan = (next: { x: number; y: number }, nextZoom = zoom) => {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return next;
    const maxX = Math.max(0, (nextZoom - 1) * bounds.width / 2);
    const maxY = Math.max(0, (nextZoom - 1) * bounds.height / 2);
    return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  };
  const changeZoom = (nextZoom: number) => {
    const safeZoom = Math.min(3, Math.max(1, nextZoom));
    setZoom(safeZoom);
    setPan((current) => safeZoom === 1 ? { x: 0, y: 0 } : clampPan(current, safeZoom));
  };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(zoom + (event.deltaY < 0 ? .2 : -.2)); };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoom]);
  const zoneAt = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.defaultPrevented) return;
    const point = svgPointFromClient(event.currentTarget, event.clientX, event.clientY);
    if (!point) return;
    const x = Math.min(100, Math.max(0, point.x / 1.05));
    const y = Math.min(100, Math.max(0, 100 - point.y / 0.68));
    // A genuine field/region click always replaces a previously-selected
    // shot stack — otherwise the inspector kept showing the old stack's
    // detail (it takes priority over selectedZone) even after this click
    // resolved a real box/lane region. Marker clicks never reach here at
    // all (they stopPropagation before the event bubbles to this handler).
    setSelectedCluster(null);
    // The box endpoint's own boundary is authoritative inside the box; the
    // generic 6-lane depth grid below it is a visual guide only and must
    // never stand in for that exact server region once inside it. Shared
    // with the 3D ray-hit resolver so the two can never disagree at an edge.
    const boxId = resolveBoxSubregionId(x, y);
    if (boxId) { setSelectedZone({ kind: "box", id: boxId }); return; }
    const lane = LANES.find((candidate) => y >= candidate.low && y < candidate.high) ?? LANES[LANES.length - 1];
    const depth = Math.min(6, Math.max(1, Math.ceil(x / (100 / 6))));
    setSelectedZone({ kind: "legacy", label: `${lane.id} · 깊이 ${depth}` });
  };
  const finishPointer = (pointerId: number) => { touchPoints.current.delete(pointerId); if (touchPoints.current.size < 2) pinch.current = null; if (drag.current?.pointerId === pointerId) drag.current = null; };

  return <section data-layout="six-lane-corridor-pitch" className="rounded-xl border border-white/10 bg-[#0b1011] p-3" aria-label={COPY.fieldLabel}>
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem] xl:items-start">
      <figure className="min-w-0" aria-describedby="six-lane-corridor-caption">
        <div ref={stageRef} className="relative overflow-hidden rounded-lg border border-white/10 bg-[#123A20] touch-none" style={{ aspectRatio: "105 / 68" }}>
          <div data-zoom-pan className="absolute inset-0 origin-center" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {layers.heatmap && <HeatmapCanvas cellCounts={fullActivityHeatmap?.available ? fullActivityHeatmap.cellCounts : undefined} enabled={Boolean(fullActivityHeatmap?.available)}/>}
          <svg viewBox="-2 -2 109 72" role="img" aria-label={`${COPY.fieldLabel}. ${markerDescription}`} className="h-full w-full" onClick={(event) => { if (!moved.current) zoneAt(event); moved.current = false; }} onPointerDown={(event) => { if (event.pointerType === "touch") { touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touchPoints.current.size === 2) { const points = [...touchPoints.current.values()]; pinch.current = { gap: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), zoom }; } } if (zoom > 1 && !(event.target instanceof Element && event.target.closest("[data-corridor-shot-marker]"))) drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan }; event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={(event) => { if (event.pointerType === "touch" && touchPoints.current.has(event.pointerId)) { touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (pinch.current && touchPoints.current.size === 2) { const points = [...touchPoints.current.values()]; const gap = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y); if (gap > 0) changeZoom(pinch.current.zoom * gap / pinch.current.gap); return; } } const start = drag.current; if (!start || start.pointerId !== event.pointerId) return; const dx = event.clientX - start.x, dy = event.clientY - start.y; if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true; setPan(clampPan({ x: start.pan.x + dx, y: start.pan.y + dy })); }} onPointerUp={(event) => finishPointer(event.pointerId)} onPointerCancel={(event) => finishPointer(event.pointerId)}>
            {/* A plain-tabindex SVG <g> picks up the browser's default auto
                focus ring, which at this marker's tiny on-screen scale can
                paint as an oversized halo that covers the marker's own ×N
                stack badge (2026-09-08 real-capture review: Enter/Space
                selection was already correct, only the focus PAINT hid the
                count). Suppress the native ring and draw an explicit thin
                one sized to the marker itself instead — same opacity-toggle
                technique already used by AnatomicalShotFigure's .asf-focus. */}
            <style>{`
              .corridor-shot-target { outline: none; }
              .corridor-focus-ring { opacity: 0; }
              .corridor-shot-target:focus-visible .corridor-focus-ring { opacity: 1; }
            `}</style>
            {LANES.map((lane) => {
              const y = lineY(lane.high);
              const height = lineY(lane.low) - y;
              return <g key={lane.id} data-lane={lane.id}><rect x="0" y={y} width="105" height={height} fill={lane.fill} fillOpacity={lane.opacity}/></g>;
            })}
            <PitchLines />
            <GuardiolaDepthGrid />
            {LANES.slice(1).map((lane) => <path key={lane.id} d={`M0 ${lineY(lane.high)}H105`} stroke="#FFFFFF" strokeOpacity=".26" strokeWidth=".34" vectorEffect="non-scaling-stroke" />)}
            {layers.cca && contour.length > 0 && <path data-layer="cca-contour" d={corridorContourPath(contour)} fill="none" stroke={CCA_STYLE.stroke} strokeOpacity={CCA_STYLE.opacity} strokeWidth={CCA_STYLE.width} strokeDasharray={CCA_STYLE.dash} vectorEffect="non-scaling-stroke"/>}
            <circle data-penalty-spot cx="93.999" cy="34" r=".3" fill="#FFFFFF" fillOpacity=".8" />
            <circle data-penalty-guide cx="93.999" cy="34" r="1.2" fill="none" stroke="#FBBF24" strokeOpacity=".9" strokeWidth=".3" strokeDasharray=".6 .45" vectorEffect="non-scaling-stroke" />
            {layers.trajectories && <g data-layer="shot-trajectories-2d" fill="none" pointerEvents="none">{displayedShots.map((shot, index) => shot.trajectory ? <path key={index} d={`M${world(shot).x.toFixed(4)} ${world(shot).y.toFixed(4)}L${(shot.trajectory.endX * 1.05).toFixed(4)} ${((100 - shot.trajectory.endY) * .68).toFixed(4)}`} stroke="#E2E8F0" strokeOpacity=".24" strokeWidth=".28" vectorEffect="non-scaling-stroke"/> : null)}</g>}
            {layers.markers && markerGroups.map((group) => {
              const point = world(group.shot);
              const composition = group.count > 1 ? ` · ${stackCompositionLabel(group.outcomeCounts)}` : "";
              return <g key={group.key} className="corridor-shot-target" data-corridor-shot-marker data-corridor-shot-count={group.count} data-corridor-cluster={group.count > 1 ? "true" : "false"} transform={`translate(${point.x.toFixed(4)} ${point.y.toFixed(4)})`} role="button" tabIndex={0} aria-label={`${group.shot.outcome} 슛 상세${group.count > 1 ? `, 묶음 ${group.count}발${composition}` : ""}`} onClick={(event) => { event.stopPropagation(); setSelectedCluster(group); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedCluster(group); } }}><CorridorShotMarker group={group}/></g>;
            })}
          </svg>
          </div>
          <span className="pointer-events-none absolute bottom-2 right-3 type-caption font-semibold text-zinc-300">{COPY.attack}</span>
        </div>
        <div role="group" aria-label={COPY.zoom} className="mt-2 flex items-center gap-1"><button type="button" aria-label="축소" onClick={() => changeZoom(zoom - .2)} disabled={zoom <= 1} className="min-h-10 min-w-10 rounded border border-white/15 type-label font-bold disabled:opacity-40">−</button><button type="button" aria-label="확대" onClick={() => changeZoom(zoom + .2)} disabled={zoom >= 3} className="min-h-10 min-w-10 rounded border border-white/15 type-label font-bold disabled:opacity-40">+</button><button type="button" onClick={() => changeZoom(1)} className="min-h-10 rounded border border-white/15 px-3 type-label font-bold">{COPY.reset}</button><span aria-live="polite" className="ml-1 type-label text-zinc-400">{zoom.toFixed(1)}배</span></div>
        <figcaption id="six-lane-corridor-caption" className="mt-2 type-caption text-zinc-400">{markerDescription} · {COPY.penalty}</figcaption>
      </figure>
      <aside className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-3" aria-label={COPY.tableLabel}>
        <table className="w-full text-base"><thead className="text-zinc-500"><tr><th className="pb-2 text-left">레인</th><th className="pb-2 text-right">슛</th><th className="pb-2 text-right">득점</th><th className="pb-2 text-right">xG</th><th className="pb-2 text-right">활동</th></tr></thead><tbody>{LANES.map((lane) => <tr key={lane.id} className="border-t border-white/10"><th className="py-2 text-left font-semibold text-zinc-200">{lane.id} · {lane.label}</th><td className="text-right text-zinc-500">—</td><td className="text-right text-zinc-500">—</td><td className="text-right text-zinc-500">—</td><td className="text-right text-zinc-500">—</td></tr>)}</tbody></table>
        <p role="status" className="mt-3 type-caption text-amber-200">{COPY.pending}</p>
      </aside>
    </div>
    {boxSubregion && <div className="mt-3"><BoxSubregionPanel state={boxSubregion} activeRegionId={selectedZone?.kind === "box" ? selectedZone.id : null} /></div>}
    {(selectedCluster || selectedZone) && <aside data-layout="corridor-inspector" className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3 text-base text-zinc-300" aria-label={selectedCluster ? "슈팅 상세" : COPY.zoneInfo}>{selectedCluster ? <><p>슛 상세{selectedCluster.count > 1 ? ` · 묶음 ${selectedCluster.count}발` : ""}</p><ol aria-label="묶음 슈팅 이벤트" className="mt-2 space-y-1">{selectedCluster.shots.map((shot, index) => <li key={`${shot.x}:${shot.y}:${index}`}>#{index + 1} · {shot.outcome} · xG {typeof shot.xg === "number" ? shot.xg.toFixed(2) : "—"} · xGOT {typeof shot.xgot === "number" ? shot.xgot.toFixed(2) : "—"}</li>)}</ol></> : selectedZone!.kind === "box" ? <BoxZoneInspector id={selectedZone!.id} boxSubregion={boxSubregion} /> : <>{COPY.zoneInfo} · {selectedZone!.label} · 슛 — · 득점 — · xG — · 히트맵 점유 —</>}</aside>}
    <div className="mt-3 border-t border-white/10 pt-3 text-base leading-6 text-zinc-300"><b className="text-zinc-100">판독</b> · {COPY.reading}</div>
  </section>;
}
