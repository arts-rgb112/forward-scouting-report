import { useEffect, useId, useRef, useState } from "react";

import type { PlayerAnalysis, ShotmapPoint } from "../dashboard/types";
import { LegacyShotShape, LegacySpatialPitchFigure } from "./LegacySpatialPitch";
import { legacyDensityGrid, marchingSquares, normalizeDensity } from "./legacyHeatmap";
import { formatShotMetric, outcomeOrder, outcomePresentation, outcomeSummary, OutcomeControls, shotIntegrity, shotMarkerLabel, type ShotOutcome, useShotOutcomeVisibility } from "./shotOutcomeVisibility";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";

export const POSITIONAL_DEPTH_BOUNDARIES = [0, 16.67, 33.33, 50, 66.67, 83.33, 100] as const;
export const POSITIONAL_LANE_BOUNDARIES = [0, 21.82, 37, 63, 78.18, 100] as const;

type PitchPoint = { x: number; y: number };
type ScreenPoint = { x: number; y: number };
type Projection = (point: PitchPoint) => ScreenPoint;
type ViewMode = "perspective" | "plan";

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/**
 * Provider coordinates are attack-relative: x grows left-to-right and y=0 is
 * the player's right touchline. The near edge is therefore the right lane.
 */
export function projectPerspective(point: PitchPoint): ScreenPoint {
  const x = clamp(point.x) / 100;
  const y = clamp(point.y) / 100;
  const left = 30 + (190 - 30) * y;
  const right = 970 + (810 - 970) * y;
  return { x: left + (right - left) * x, y: 560 + (90 - 560) * y };
}

export function projectPlan(point: PitchPoint): ScreenPoint {
  return { x: 30 + clamp(point.x) * 9.4, y: 610 - clamp(point.y) * 5.6 };
}

function usePrefersReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

const pathBetween = (projection: Projection, start: PitchPoint, end: PitchPoint) => {
  const a = projection(start); const b = projection(end);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
};

const polygonPath = (projection: Projection, points: PitchPoint[]) => {
  const projected = points.map(projection);
  return `${projected.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ")} Z`;
};

function projectedCircle(projection: Projection, center: PitchPoint, radiusX: number, radiusY = radiusX) {
  const points = Array.from({ length: 49 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 48;
    return { x: center.x + Math.cos(angle) * radiusX, y: center.y + Math.sin(angle) * radiusY };
  });
  return polygonPath(projection, points);
}

function PitchMarkings({ projection }: { projection: Projection }) {
  const pitch = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const boxes = [
    [{ x: 0, y: 21.8 }, { x: 16.5, y: 21.8 }, { x: 16.5, y: 78.2 }, { x: 0, y: 78.2 }],
    [{ x: 83.5, y: 21.8 }, { x: 100, y: 21.8 }, { x: 100, y: 78.2 }, { x: 83.5, y: 78.2 }],
  ];
  return <g data-layer="pitch-markings" fill="none" stroke="#d7eadf" strokeWidth="2.1" vectorEffect="non-scaling-stroke">
    <path d={polygonPath(projection, pitch)} />
    <path d={pathBetween(projection, { x: 50, y: 0 }, { x: 50, y: 100 })} />
    <path d={projectedCircle(projection, { x: 50, y: 50 }, 9.15, 13.45)} />
    {boxes.map((box, index) => <path key={index} d={polygonPath(projection, box)} />)}
  </g>;
}

function PositionalGrid({ projection }: { projection: Projection }) {
  return <g data-layer="positional-grid">
    <g fill="none" stroke="#fb923c" strokeOpacity=".92" strokeWidth="1.35" vectorEffect="non-scaling-stroke">
      {POSITIONAL_DEPTH_BOUNDARIES.map((depth) => <path key={`depth-${depth}`} data-grid-axis="depth" data-boundary={depth} d={pathBetween(projection, { x: depth, y: 0 }, { x: depth, y: 100 })} />)}
      {POSITIONAL_LANE_BOUNDARIES.map((lane) => <path key={`lane-${lane}`} data-grid-axis="lane" data-boundary={lane} d={pathBetween(projection, { x: 0, y: lane }, { x: 100, y: lane })} />)}
    </g>
    <g className="hidden sm:inline" fill="#fed7aa" fillOpacity=".76" fontSize="18" fontWeight="700" textAnchor="middle" aria-hidden="true">
      {POSITIONAL_DEPTH_BOUNDARIES.slice(0, -1).flatMap((depth, depthIndex) => POSITIONAL_LANE_BOUNDARIES.slice(0, -1).map((lane, laneIndex) => {
        const center = projection({ x: (depth + POSITIONAL_DEPTH_BOUNDARIES[depthIndex + 1]) / 2, y: (lane + POSITIONAL_LANE_BOUNDARIES[laneIndex + 1]) / 2 });
        return <text key={`${depthIndex}-${laneIndex}`} data-zone-label={`depth${depthIndex + 1}_lane${laneIndex + 1}`} x={center.x} y={center.y}>D{depthIndex + 1}·L{laneIndex + 1}</text>;
      }))}
    </g>
  </g>;
}

function HeatLayer({ points, projection, filterId }: { points: PitchPoint[]; projection: Projection; filterId: string }) {
  return <g data-layer="heat" filter={`url(#${filterId})`} style={{ mixBlendMode: "screen" }} aria-hidden="true">
    {points.map((point, index) => {
      const screen = projection(point); const perspectiveScale = .62 + (1 - point.y / 100) * .46;
      return <circle key={index} data-heat-point data-pitch-x={point.x} data-pitch-y={point.y} data-screen-x={screen.x} data-screen-y={screen.y} cx={screen.x} cy={screen.y} r={18 * perspectiveScale} fill="#fb923c" fillOpacity=".2" />;
    })}
  </g>;
}

const outcomeLabel: Record<ShotmapPoint["outcome"], string> = { goal: "Goal", on_target: "On target", off_target: "Off target", blocked: "Blocked" };

function ShotGlyph({ shot, sourceIndex, projection, perspective, id, active, tooltipId, registerRef, onActivate, onDeactivate, onNavigate }: {
  shot: ShotmapPoint; sourceIndex: number; projection: Projection; perspective: boolean; id: string; active: boolean; tooltipId: string;
  registerRef(element: SVGGElement | null): void; onActivate(id: string): void; onDeactivate(id: string): void; onNavigate(direction: 1 | -1): void;
}) {
  const anchor = projection(shot);
  const markerSize = outcomePresentation[shot.outcome].size;
  const markerY = perspective ? anchor.y - 8 - markerSize * .55 : anchor.y;
  return <g ref={registerRef} id={id} role="img" tabIndex={active ? 0 : -1} aria-label={shotMarkerLabel(shot)} aria-describedby={tooltipId} data-shot-marker data-shot-index={sourceIndex} data-shot-outcome={shot.outcome} data-marker-symbol={outcomePresentation[shot.outcome].symbol} data-marker-size={markerSize} data-pitch-x={shot.x} data-pitch-y={shot.y} data-screen-x={anchor.x} data-screen-y={anchor.y} className="cursor-help" onFocus={() => onActivate(id)} onPointerEnter={() => onActivate(id)} onPointerLeave={(event) => { if (document.activeElement !== event.currentTarget) onDeactivate(id); }} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); onNavigate(1); } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); onNavigate(-1); } }}>
    <title>{shotMarkerLabel(shot)}</title>
    {perspective && <><line x1={anchor.x} y1={anchor.y} x2={anchor.x} y2={markerY} stroke={outcomePresentation[shot.outcome].color} strokeOpacity=".7" strokeWidth="1.5" strokeDasharray="3 3"/><ellipse cx={anchor.x} cy={anchor.y} rx={markerSize * .9} ry={markerSize * .28} fill="#020617" fillOpacity=".55"/></>}
    <g transform={`translate(${anchor.x} ${markerY})`}><LegacyShotShape shot={shot}/><circle r="12" fill="transparent" pointerEvents="all" /></g>
  </g>;
}

function PitchSvg({ spatial, mode, filterId, visibleOutcomes, markerLayerId }: { spatial: PlayerAnalysis["spatial"] | undefined; mode: ViewMode; filterId: string; visibleOutcomes: ReadonlySet<ShotOutcome>; markerLayerId: string }) {
  const perspective = mode === "perspective";
  const projection = perspective ? projectPerspective : projectPlan;
  const heat = spatial?.available ? spatial.heatmapPoints : [];
  const shotsValid = shotIntegrity(spatial);
  const shots = shotsValid ? spatial!.shotmapPoints.map((shot, sourceIndex) => ({ shot, sourceIndex })).filter(({ shot }) => visibleOutcomes.has(shot.outcome)) : [];
  const heatState = !spatial?.available ? "Activity heatmap unavailable" : heat.length ? `${heat.length} activity points` : "Verified zero activity points";
  const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !shotsValid ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const contour = spatial?.available && spatial.continuousCore.available && spatial.continuousCore.thresholdOfPeak > 0 ? marchingSquares(normalizeDensity(legacyDensityGrid(heat)), spatial.continuousCore.thresholdOfPeak) : [];
  const pitchShape = polygonPath(projection, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  const markerRefs = useRef(new Map<string, SVGGElement>()), tooltipId = `${filterId}-shot-tooltip`;
  const [activeId, setActiveId] = useState<string | null>(null), [tooltipIdState, setTooltipIdState] = useState<string | null>(null);
  const firstId = shots.length ? `${filterId}-shot-${shots[0].sourceIndex}` : null;
  const activeVisibleId = shots.some(({ sourceIndex }) => `${filterId}-shot-${sourceIndex}` === activeId) ? activeId : firstId;
  const tooltipEntry = shots.find(({ sourceIndex }) => `${filterId}-shot-${sourceIndex}` === tooltipIdState);
  const navigate = (visibleIndex: number, direction: 1 | -1) => { if (!shots.length) return; const next = shots[(visibleIndex + direction + shots.length) % shots.length]; const id = `${filterId}-shot-${next.sourceIndex}`; setActiveId(id); setTooltipIdState(id); markerRefs.current.get(id)?.focus(); };
  const visibleGroups = outcomeOrder.filter((outcome) => visibleOutcomes.has(outcome) && spatial?.shotmapPoints.some((shot) => shot.outcome === outcome));
  return <svg viewBox="0 0 1000 650" preserveAspectRatio="xMidYMid meet" className="block h-auto w-full rounded-lg bg-[#070b0d]" role="img" aria-label={`${perspective ? "Perspective" : "Two-dimensional"} attacking pitch with exact 6-depth by 5-lane positional grid. ${heatState}. ${shotState}. Visible shot outcomes: ${outcomeSummary(visibleGroups)}. Outcome controls change markers only.`}>
    <defs><filter id={filterId} x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation={perspective ? "9" : "11"}/></filter><linearGradient id={`${filterId}-grass`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#0f6f42"/><stop offset="1" stopColor="#06432e"/></linearGradient></defs>
    <path d={pitchShape} fill={`url(#${filterId}-grass)`} stroke="#143d2f" strokeWidth="9" />
    <HeatLayer points={heat} projection={projection} filterId={filterId}/>
    <PitchMarkings projection={projection}/>
    <PositionalGrid projection={projection}/>
    {contour.length > 0 && <g data-layer="cca-contour" fill="none" stroke="#c044ff" strokeWidth="3" vectorEffect="non-scaling-stroke">{contour.map(([x1, y1, x2, y2], index) => <path key={index} d={pathBetween(projection, { x: x1, y: 100 - y1 }, { x: x2, y: 100 - y2 })}/>)}</g>}
    <g id={markerLayerId} data-layer="shots">{shots.map(({ shot, sourceIndex }, visibleIndex) => { const id = `${filterId}-shot-${sourceIndex}`; return <ShotGlyph key={id} shot={shot} sourceIndex={sourceIndex} projection={projection} perspective={perspective} id={id} active={id === activeVisibleId} tooltipId={tooltipId} registerRef={(element) => { if (element) markerRefs.current.set(id, element); else markerRefs.current.delete(id); }} onActivate={(markerId) => { setActiveId(markerId); setTooltipIdState(markerId); }} onDeactivate={(markerId) => { if (tooltipIdState === markerId) setTooltipIdState(null); }} onNavigate={(direction) => navigate(visibleIndex, direction)}/>; })}</g>
    {tooltipEntry && (() => { const anchor = projection(tooltipEntry.shot); const x = Math.min(830, Math.max(20, anchor.x - 70)), y = Math.min(570, Math.max(12, anchor.y - 82)); return <g id={tooltipId} role="tooltip" pointerEvents="none" transform={`translate(${x} ${y})`}><rect width="150" height="62" rx="7" fill="#0b0e0f" fillOpacity=".96" stroke="#ffffff" strokeOpacity=".25"/><text x="10" y="18" fill="#f4f4f5" fontSize="12" fontWeight="700">{outcomePresentation[tooltipEntry.shot.outcome].label}</text><text x="10" y="37" fill="#e4e4e7" fontSize="11">xG {formatShotMetric(tooltipEntry.shot.xg)}</text><text x="10" y="53" fill="#e4e4e7" fontSize="11">xGOT {formatShotMetric(tooltipEntry.shot.xgot)}</text></g>; })()}
    <g fill="#e4e4e7" fontSize="13" fontWeight="700" aria-hidden="true"><text x="36" y="630">Attack direction 0 → 100</text><text x="835" y="584">Lane 1 · right</text><text x="194" y="73">Lane 5 · left</text></g>
  </svg>;
}

export function SpatialPitch({ analysis, contextIdentity = "" }: { analysis?: PlayerAnalysis; contextIdentity?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  const [manualMode, setManualMode] = useState<ViewMode | null>(null);
  const mode = manualMode ?? (reducedMotion ? "plan" : "perspective");
  const spatial = analysis?.spatial;
  const controller = useShotOutcomeVisibility(spatial, contextIdentity);
  const heatState = !spatial?.available ? "Activity heatmap unavailable" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points";
  const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : !controller.integrity ? "Shot snapshot integrity mismatch" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const counts = controller.counts;
  const rawId = useId().replace(/:/g, "");
  const markerLayerId = `spatial-shot-markers-${rawId}`;
  return <section className={panel} aria-labelledby={`spatial-pitch-${rawId}`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id={`spatial-pitch-${rawId}`} className="text-sm font-black">Spatial pitch</h2><p className="mt-1 text-[11px] text-zinc-400">Attack left → right · Lane 1 is the near/right touchline · exact positional-6×5 grid</p></div><div role="group" aria-label="Pitch view" className="flex rounded-lg border border-white/15 bg-black/30 p-1"><button type="button" aria-pressed={mode === "perspective"} onClick={() => setManualMode("perspective")} className="min-h-9 rounded px-3 text-xs font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">Perspective</button><button type="button" aria-pressed={mode === "plan"} onClick={() => setManualMode("plan")} className="min-h-9 rounded px-3 text-xs font-bold aria-pressed:bg-orange-400 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-orange-200">2D plan</button></div></div>
    {reducedMotion && manualMode === null && <p className="mt-2 text-xs text-zinc-400">Reduced-motion preference detected; the 2D plan fallback is active.</p>}
    {controller.integrity && controller.presentOutcomes.length > 0 && <OutcomeControls outcomes={controller.presentOutcomes} counts={controller.counts} visible={controller.visibleOutcomes} markerLayerId={markerLayerId} onClick={controller.onClick} onDoubleClick={controller.onDoubleClick}/>}<p role="status" aria-live="polite" className="sr-only">Visible shot outcomes: {outcomeSummary(controller.presentOutcomes.filter((outcome) => controller.visibleOutcomes.has(outcome)))}.</p>
    <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-white/10">{mode === "plan" ? <LegacySpatialPitchFigure analysis={analysis} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId} showCounts={false}/> : <figure><PitchSvg spatial={spatial} mode={mode} filterId={`spatial-heat-${rawId}`} visibleOutcomes={controller.visibleOutcomes} markerLayerId={markerLayerId}/><figcaption className="border-t border-white/10 bg-black/25 px-3 py-2 text-xs text-zinc-300">{heatState}. {shotState}. Heat glows, the authoritative CCA contour, and shot anchors share the server 0–100 coordinate transform; outcome controls affect markers only.</figcaption></figure>}</div>
    <div className="mt-3 grid gap-2 text-xs text-zinc-400 sm:grid-cols-2"><p aria-live="polite">{heatState}. Thirty tactical cells are visual guides; no browser-side score or zone value is calculated.</p><p aria-live="polite">{shotState}. Unavailable and available-with-zero are kept distinct.</p></div>
    {controller.integrity ? <ul aria-label="Shot outcome legend" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-300"><li>◇ Goals {counts.goal}</li><li>● On target {counts.on_target}</li><li>× Off target {counts.off_target}</li><li>■ Blocked {counts.blocked}</li></ul> : <p className="mt-2 text-xs text-zinc-500">Outcome totals are unavailable because no valid shot snapshot exists for this context.</p>}
    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 text-xs text-zinc-300"><summary className="min-h-11 cursor-pointer px-3 py-3 font-bold focus-visible:ring-2 focus-visible:ring-orange-200">30-zone and shot details</summary><div className="border-t border-white/10 p-3"><p>Depth runs D1→D6 with the attack; Lane 1 is right/near and Lane 5 is left/far. The exact non-uniform boundaries remain visible on the pitch.</p><ul data-zone-key aria-label="Thirty positional zone labels" className="mt-2 grid grid-cols-5 gap-1 text-center text-[10px] sm:grid-cols-10">{Array.from({ length: 30 }, (_, index) => <li key={index} className="rounded bg-white/5 px-1 py-1">D{Math.floor(index / 5) + 1}·L{index % 5 + 1}</li>)}</ul>{!controller.integrity ? <p className="mt-3">Shot event details unavailable.</p> : spatial!.shotmapPoints.length === 0 ? <p className="mt-3">Verified zero shot events.</p> : <ol aria-label="Authoritative shot events" className="mt-3 max-h-48 space-y-1 overflow-y-auto pr-1">{spatial!.shotmapPoints.map((shot, index) => <li key={index} className="rounded bg-white/5 px-2 py-1">{index + 1}. {outcomeLabel[shot.outcome]} · xG {shot.xg == null ? "unavailable" : shot.xg.toFixed(2)} · xGOT {shot.xgot == null ? "unavailable" : shot.xgot.toFixed(2)} · ({shot.x.toFixed(1)}, {shot.y.toFixed(1)})</li>)}</ol>}</div></details>
  </section>;
}
