import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import type { MessiApiConfig } from "../api/env";
import type { GoalMouthBaselineCell, GoalMouthBaselineData } from "../api/goalMouthBaselineContracts";
import type { FinalThirdShot } from "../api/finalThirdShotMapContracts";
import type { FinalThirdRenderableData } from "../api/finalThirdShotMapV2Contracts";
import type { FinalThirdShotMapV3Data } from "../api/finalThirdShotMapV3Contracts";
import { useGoalMouthBaseline, type GoalMouthBaselineState } from "./useGoalMouthBaseline";
import { usePitchPenalty } from "./PitchPenaltyContext";
import { excludePenaltyShots, penaltyStateLabel, summarizeShots } from "./pitchPenalties";
import { medianObservedXg, pitchMarkerRadius, PitchShotMarker } from "./PitchShotMarker";

type RenderableData = FinalThirdRenderableData | FinalThirdShotMapV3Data;
type ShotStatus = Exclude<FinalThirdShot["status"], "blocked">;
type VisibleStatus = "all" | ShotStatus;
const statuses = ["goal", "on_target", "off_target"] as const satisfies readonly ShotStatus[];
const statusStyle = { goal: { color: "#22c55e", text: "G", label: "Goal" }, on_target: { color: "#38bdf8", text: "T", label: "On target" }, off_target: { color: "#fbbf24", text: "X", label: "Off target" }, blocked: { color: "#EAB308", text: "B", label: "Blocked" } } as const;
const GOAL_MOUTH_COPY = {
  title: "골문 슈팅맵",
  baseline: "배경 = 리그 baseline",
  cellGuide: "각 칸: 득점 확률 · 아래 작은 숫자: 해당 칸 리그 슈팅 수 · 공격수가 바라보는 방향",
  playerCellGuide: "축구공 = 이 선수의 골문 도달 슛",
  crossbar: "크로스바",
  ground: "골라인 (지면)",
  leftPost: "왼쪽 포스트",
  rightPost: "오른쪽 포스트",
  penaltyAxis: "PK 스팟 축",
  baselineToggle: "골문 득점 확률 기준선",
  baselineLoading: "5시즌 리그 골문 기준선을 불러오는 중입니다.",
  baselineUnavailable: "5시즌 리그 골문 기준선을 사용할 수 없습니다.",
  baselineError: "5시즌 리그 골문 기준선을 불러오지 못했습니다.",
} as const;
/** Project normalized provider coordinates onto a regulation 7.32m × 2.44m goal. */
const GOAL_WIDTH_METERS = 7.32;
const GOAL_HEIGHT_METERS = 2.44;
const SVG_UNITS_PER_METER = 100;
const GOAL_DEPTH_METERS = 2;
const frame = {
  left: 180,
  right: 180 + GOAL_WIDTH_METERS * SVG_UNITS_PER_METER,
  top: 220,
  bottom: 220 + GOAL_HEIGHT_METERS * SVG_UNITS_PER_METER,
} as const;
const vanishingPoint = { x: (frame.left + frame.right) / 2, y: frame.top - 142 } as const;
const REAR_PROJECTION = .82;
const projectTowardVanishingPoint = (point: { x: number; y: number }) => ({
  x: vanishingPoint.x + (point.x - vanishingPoint.x) * REAR_PROJECTION,
  y: vanishingPoint.y + (point.y - vanishingPoint.y) * REAR_PROJECTION,
});
/** Compact rear guide, derived by projecting each front-frame corner to one VP. */
const rearFrame = {
  left: projectTowardVanishingPoint({ x: frame.left, y: frame.top }).x,
  right: projectTowardVanishingPoint({ x: frame.right, y: frame.top }).x,
  top: projectTowardVanishingPoint({ x: frame.left, y: frame.top }).y,
  bottom: projectTowardVanishingPoint({ x: frame.left, y: frame.bottom }).y,
} as const;
/** Fixed 1× framing; source endpoints never enlarge the regulation goal. */
const compactBaseViewBox = {
  minX: frame.left - 140,
  minY: rearFrame.top - 96,
  width: (frame.right - frame.left) + 280,
  height: (frame.bottom - (rearFrame.top - 96)) + 135,
} as const;
const edgeMarkerBounds = {
  left: frame.left - 108,
  right: frame.right + 108,
  top: frame.top - 82,
  bottom: frame.bottom + 82,
} as const;
type ZoomLevel = 1 | 2 | 3;
type Viewport = { x: number; y: number };
type TooltipBounds = { minX: number; minY: number; maxX: number; maxY: number };

const zoomViewport = (base: { width: number; height: number }, zoom: ZoomLevel) => ({ width: base.width / zoom, height: base.height / zoom });
const clampViewport = (viewport: Viewport, base: { width: number; height: number }, zoom: ZoomLevel): Viewport => {
  const visible = zoomViewport(base, zoom);
  return {
    x: Math.min(Math.max(0, base.width - visible.width), Math.max(0, viewport.x)),
    y: Math.min(Math.max(0, base.height - visible.height), Math.max(0, viewport.y)),
  };
};
const centeredViewport = (from: Viewport, base: { width: number; height: number }, fromZoom: ZoomLevel, toZoom: ZoomLevel): Viewport => {
  const previous = zoomViewport(base, fromZoom), next = zoomViewport(base, toZoom);
  return clampViewport({ x: from.x + previous.width / 2 - next.width / 2, y: from.y + previous.height / 2 - next.height / 2 }, base, toZoom);
};

function zoomedViewBox(base: { minX: number; minY: number; width: number; height: number }, zoom: ZoomLevel) {
  if (zoom === 1) return `${base.minX} ${base.minY} ${base.width} ${base.height}`;
  // Keep the real goal as the focal point; off-frame source endpoints use
  // explicit edge indicators instead of expanding the compact 1× viewport.
  const centerX = (frame.left + frame.right) / 2;
  const centerY = (frame.top + frame.bottom) / 2;
  const width = base.width / zoom;
  const height = base.height / zoom;
  return `${centerX - width / 2} ${centerY - height / 2} ${width} ${height}`;
}

function Shape({ shot, size }: { shot: FinalThirdShot; size: number }) {
  return <g data-marker-shape="football" data-shot-status={shot.status}>
    <PitchShotMarker outcome={shot.status} radius={size}/>
  </g>;
}

function markerSize(shot: FinalThirdShot, medianXg: number | null) {
  return pitchMarkerRadius(shot.xg, medianXg);
}

function endpointPoint(shot: FinalThirdShot) {
  return { x: frame.left + (shot.goalMouthY ?? 0) * (frame.right - frame.left), y: frame.bottom - (shot.goalMouthZ ?? 0) * (frame.bottom - frame.top) };
}

function offFrameDescription(shot: FinalThirdShot) {
  const y = shot.goalMouthY!, z = shot.goalMouthZ!;
  const labels: string[] = [];
  if (y < 0) labels.push(`왼쪽 포스트 밖 ${(Math.abs(y) * GOAL_WIDTH_METERS).toFixed(1)}m`);
  if (y > 1) labels.push(`오른쪽 포스트 밖 ${((y - 1) * GOAL_WIDTH_METERS).toFixed(1)}m`);
  if (z > 1) labels.push(`크로스바 위 ${((z - 1) * GOAL_HEIGHT_METERS).toFixed(1)}m`);
  if (z < 0) labels.push(`골대 아래 ${(Math.abs(z) * GOAL_HEIGHT_METERS).toFixed(1)}m`);
  return labels;
}

function isOffFrame(shot: FinalThirdShot) {
  return shot.goalMouthY! < 0 || shot.goalMouthY! > 1 || shot.goalMouthZ! < 0 || shot.goalMouthZ! > 1;
}

function proportionalMarginOffset(distance: number, maximumDistance: number, margin: number) {
  if (distance <= 0) return 0;
  const progress = Math.log1p(distance) / Math.log1p(Math.max(distance, maximumDistance));
  return 14 + progress * Math.max(0, margin - 14);
}

function compressedEdgePoint(shot: FinalThirdShot, endpointShots: FinalThirdShot[], fanOffset: number) {
  const y = shot.goalMouthY!, z = shot.goalMouthZ!;
  const maximum = (axis: "left" | "right" | "top" | "bottom") => Math.max(0.0001, ...endpointShots.map((candidate) => {
    const candidateY = candidate.goalMouthY!, candidateZ = candidate.goalMouthZ!;
    if (axis === "left") return Math.max(0, -candidateY);
    if (axis === "right") return Math.max(0, candidateY - 1);
    if (axis === "top") return Math.max(0, candidateZ - 1);
    return Math.max(0, -candidateZ);
  }));
  const horizontalMargin = frame.left - edgeMarkerBounds.left;
  const verticalMargin = frame.top - edgeMarkerBounds.top;
  const x = y < 0
    ? frame.left - proportionalMarginOffset(-y, maximum("left"), horizontalMargin)
    : y > 1 ? frame.right + proportionalMarginOffset(y - 1, maximum("right"), horizontalMargin)
      : frame.left + y * (frame.right - frame.left);
  const yPosition = z > 1
    ? frame.top - proportionalMarginOffset(z - 1, maximum("top"), verticalMargin)
    : z < 0 ? frame.bottom + proportionalMarginOffset(-z, maximum("bottom"), edgeMarkerBounds.bottom - frame.bottom)
      : frame.bottom - z * (frame.bottom - frame.top);
  // A fan is used only for exact duplicate source coordinates; all other
  // locations retain their order through the proportional mapping above.
  const fanned = fanOffset * 11;
  return { x: x + (z < 0 || z > 1 ? fanned : 0), y: yPosition + (y < 0 || y > 1 ? fanned : 0) };
}

function estimatedTooltipWidth(lines: readonly string[]) {
  const widest = Math.max(...lines.map((line) => [...line].reduce((width, character) => width + (/[^\x00-\x7F]/.test(character) ? 11 : 7), 0)));
  return Math.max(150, widest + 20);
}

function edgeTooltipLayout(point: { x: number; y: number }, size: number, lines: readonly string[], bounds: TooltipBounds) {
  const width = estimatedTooltipWidth(lines), height = lines.length * 16 + 18, gap = 12, inset = 8;
  const rightX = point.x + size + gap;
  const leftX = point.x - size - gap - width;
  const side = rightX + width > bounds.maxX - inset ? "left" : "right";
  const preferredY = point.y - size - gap - height;
  const vertical = preferredY < bounds.minY + inset ? "below" : "above";
  const rawY = vertical === "below" ? point.y + size + gap : preferredY;
  return {
    x: Math.min(Math.max(bounds.minX + inset, side === "left" ? leftX : rightX), bounds.maxX - inset - width),
    y: Math.min(Math.max(bounds.minY + inset, rawY), bounds.maxY - inset - height),
    width,
    height,
    side,
    vertical,
  } as const;
}

function EdgeMarker({ shot, medianXg, endpointShots, fanOffset, fanCount, active, onActivate, onDeactivate, tooltipBounds }: { shot: FinalThirdShot; medianXg: number | null; endpointShots: FinalThirdShot[]; fanOffset: number; fanCount: number; active: boolean; onActivate: () => void; onDeactivate: () => void; tooltipBounds: TooltipBounds }) {
  const point = compressedEdgePoint(shot, endpointShots, fanOffset);
  const descriptionLines = offFrameDescription(shot);
  const description = descriptionLines.join(" · ");
  const rawCoordinates = `원본 좌표 Y ${shot.goalMouthY}, Z ${shot.goalMouthZ}`;
  const style = statusStyle[shot.status], size = Math.max(5, markerSize(shot, medianXg) * .7), xgUnavailable = shot.xg === null, xgLabel = shot.xg === null ? "xG 미상; 중앙값 크기" : `xG ${shot.xg.toFixed(2)}`;
  const tooltip = edgeTooltipLayout(point, size, descriptionLines, tooltipBounds);
  return <g data-goal-mouth-shot={shot.shotId} data-goal-mouth-off-frame-shot={shot.shotId} data-xg-size={xgUnavailable ? "unavailable" : "observed"} data-marker-footprint={size} transform={`translate(${point.x} ${point.y})`} tabIndex={0} role="img" aria-label={`${style.label}, ${description}. ${xgLabel}. ${rawCoordinates}`} onMouseEnter={onActivate} onMouseLeave={onDeactivate} onFocus={onActivate} onBlur={onDeactivate}>
    <title>{`${description}. ${xgLabel}. ${rawCoordinates}`}</title>
    <Shape shot={shot} size={size}/>
    {fanCount > 1 && <g data-off-frame-duplicate-count><circle cx={size * .72} cy={-size * .72} r="8" fill="#111827" stroke="#fbbf24" strokeWidth="1.5"/><text x={size * .72} y={-size * .72 + 3.5} textAnchor="middle" fill="#fde68a" fontSize="12" fontWeight="900">×{fanCount}</text></g>}
    {active && <g data-off-frame-tooltip data-tooltip-side={tooltip.side} data-tooltip-vertical={tooltip.vertical} transform={`translate(${tooltip.x - point.x} ${tooltip.y - point.y})`} pointerEvents="none"><rect data-off-frame-tooltip-background x="0" y="0" width={tooltip.width} height={tooltip.height} rx="6" fill="#111827" stroke="#fbbf24"/>{descriptionLines.map((line, index) => <text key={line} x="10" y={18 + index * 16} fill="#fde68a" fontSize="12" fontWeight="800">{line}</text>)}</g>}
  </g>;
}

function Marker({ shot, medianXg, endpointShots, fanOffset, fanCount, active, onActivate, onDeactivate, tooltipBounds }: { shot: FinalThirdShot; medianXg: number | null; endpointShots: FinalThirdShot[]; fanOffset: number; fanCount: number; active: boolean; onActivate: () => void; onDeactivate: () => void; tooltipBounds: TooltipBounds }) {
  if (!shot.endpointAvailable || shot.goalMouthY === null || shot.goalMouthZ === null || shot.status === "blocked") return null;
  if (isOffFrame(shot)) return <EdgeMarker shot={shot} medianXg={medianXg} endpointShots={endpointShots} fanOffset={fanOffset} fanCount={fanCount} active={active} onActivate={onActivate} onDeactivate={onDeactivate} tooltipBounds={tooltipBounds}/>;
  const style = statusStyle[shot.status], xgUnavailable = shot.xg === null, xgLabel = shot.xg === null ? "xG 미상; 중앙값 크기" : shot.xg.toFixed(2), size = markerSize(shot, medianXg), point = endpointPoint(shot);
  return <g data-goal-mouth-shot={shot.shotId} data-xg-size={xgUnavailable ? "unavailable" : "observed"} data-marker-footprint={size} transform={`translate(${point.x} ${point.y})`} aria-label={`${style.label}; xG ${xgLabel}`}><title>{`${style.label}; xG ${xgLabel}`}</title><rect data-marker-footprint-box x={-size} y={-size} width={size * 2} height={size * 2} fill="none" stroke="none" pointerEvents="none"/><Shape shot={shot} size={size}/>{xgUnavailable && <text data-size-unavailable y="4" textAnchor="middle" fill="#111827" fontSize="12" fontWeight="900">?</text>}<text y={size + 13} textAnchor="middle" fill="#f4f4f5" fontSize="12" fontWeight="800">{style.text}</text></g>;
}

const BASELINE_COLD = [35, 58, 94] as const;
const BASELINE_MID = [74, 98, 122] as const;
const BASELINE_HOT = [186, 74, 66] as const;
const mixBaselineColor = (from: readonly number[], to: readonly number[], amount: number) => `#${from.map((value, index) => Math.round(value + (to[index] - value) * amount).toString(16).padStart(2, "0")).join("")}`;
function baselineFill(rate: number | null) {
  if (rate === null) return "#334155";
  // These are presentation anchors from the approved Figma ramp, not a
  // recomputed league average. Every displayed rate still comes from the API.
  if (rate < 33) return mixBaselineColor(BASELINE_COLD, BASELINE_MID, Math.max(0, Math.min(1, (rate - 12) / 21)));
  return mixBaselineColor(BASELINE_MID, BASELINE_HOT, Math.max(0, Math.min(1, (rate - 33) / 30)));
}

function baselineTooltip(cell: GoalMouthBaselineCell) {
  const rate = cell.goalRatePct === null ? "rate unavailable" : `${cell.goalRatePct.toFixed(1)}%`;
  const confidence = cell.confidenceIntervalPct === null ? "confidence unavailable" : `95% CI ${cell.confidenceIntervalPct.lower.toFixed(1)}–${cell.confidenceIntervalPct.upper.toFixed(1)}%`;
  return `${cell.cellId}: ${rate}; ${cell.shots ?? "—"} shots; ${confidence}${cell.state === "low_sample" ? "; low sample" : ""}`;
}

function GoalMouthBaselineLayer({ baseline, activeCellId, onActivate, onDeactivate, patternId }: { baseline: GoalMouthBaselineData; activeCellId: string | null; onActivate: (cellId: string) => void; onDeactivate: (cellId: string) => void; patternId: string }) {
  return <g data-goal-mouth-baseline data-goal-mouth-baseline-source={baseline.provenance.source} aria-label="5시즌 리그 골문 득점 확률 기준선">
    <defs><pattern id={patternId} width="11" height="11" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="11" stroke="#f8fafc" strokeOpacity=".55" strokeWidth="3"/></pattern></defs>
    {baseline.cells.map((cell) => {
      // Use server-provided intervals directly. SVG y increases downward whereas mouth Z increases upward.
      const x = frame.left + cell.yMin * (frame.right - frame.left), y = frame.bottom - cell.zMax * (frame.bottom - frame.top), width = (cell.yMax - cell.yMin) * (frame.right - frame.left), height = (cell.zMax - cell.zMin) * (frame.bottom - frame.top), active = activeCellId === cell.cellId;
      return <g key={cell.cellId} data-goal-mouth-baseline-cell={cell.cellId} data-baseline-state={cell.state} tabIndex={0} role="img" aria-label={baselineTooltip(cell)} onMouseEnter={() => onActivate(cell.cellId)} onMouseLeave={() => onDeactivate(cell.cellId)} onFocus={() => onActivate(cell.cellId)} onBlur={() => onDeactivate(cell.cellId)}>
        <title>{baselineTooltip(cell)}</title><rect data-baseline-cell-fill x={x} y={y} width={width} height={height} fill={baselineFill(cell.goalRatePct)} fillOpacity={cell.state === "low_sample" ? ".48" : ".94"} stroke="#0B1220" strokeOpacity=".92" strokeWidth="1.4"/>
        {cell.state === "low_sample" && <rect data-baseline-low-sample-hatch x={x} y={y} width={width} height={height} fill={`url(#${patternId})`} opacity=".48" pointerEvents="none"/>}
        <text data-baseline-rate x={x + width / 2} y={y + height * .43} textAnchor="middle" fill="#FFFFFF" fillOpacity=".96" fontSize="16" fontWeight="800" pointerEvents="none">{cell.goalRatePct === null ? "—" : `${Math.round(cell.goalRatePct)}%`}</text>
        <text data-baseline-sample x={x + width / 2} y={y + height * .68} textAnchor="middle" fill="#FFFFFF" fillOpacity=".6" fontSize="12" fontWeight="650" pointerEvents="none">{cell.shots ?? "—"}</text>
        {active && <g data-goal-mouth-baseline-tooltip pointerEvents="none"><rect x={x + 5} y={y + 5} width="176" height="44" rx="5" fill="#020617" fillOpacity=".94" stroke="#cbd5e1" strokeOpacity=".75"/><text x={x + 12} y={y + 21} fill="#f8fafc" fontSize="12" fontWeight="800">{cell.goalRatePct === null ? "Rate unavailable" : `${cell.goalRatePct.toFixed(1)}% · ${cell.shots} shots`}</text><text x={x + 12} y={y + 37} fill="#cbd5e1" fontSize="12">{cell.confidenceIntervalPct === null ? "Confidence unavailable" : `95% CI ${cell.confidenceIntervalPct.lower.toFixed(1)}–${cell.confidenceIntervalPct.upper.toFixed(1)}%`}</text></g>}
      </g>;
    })}
    <path data-goal-mouth-pk-axis d={`M ${(frame.left + frame.right) / 2} ${frame.top - 28} V ${frame.bottom + 28}`} fill="none" stroke="#7DD3FC" strokeOpacity=".5" strokeWidth="1.4" strokeDasharray="7 5" pointerEvents="none"/>
    <text x={(frame.left + frame.right) / 2} y={frame.top - 38} textAnchor="middle" fill="#7DD3FC" fillOpacity=".9" fontSize="12" fontWeight="700">{GOAL_MOUTH_COPY.penaltyAxis}</text>
    <text x={(frame.left + frame.right) / 2} y={frame.top - 58} textAnchor="middle" fill="#A1A1AA" fontSize="12" fontWeight="700">{GOAL_MOUTH_COPY.crossbar}</text>
    <text x={(frame.left + frame.right) / 2} y={frame.bottom + 48} textAnchor="middle" fill="#A1A1AA" fontSize="12" fontWeight="700">{GOAL_MOUTH_COPY.ground}</text>
    <text x={frame.left - 62} y={(frame.top + frame.bottom) / 2} textAnchor="middle" fill="#A1A1AA" fontSize="12" fontWeight="700">{GOAL_MOUTH_COPY.leftPost}</text>
    <text x={frame.right + 62} y={(frame.top + frame.bottom) / 2} textAnchor="middle" fill="#A1A1AA" fontSize="12" fontWeight="700">{GOAL_MOUTH_COPY.rightPost}</text>
  </g>;
}

function GoalNet({ baselineLayer }: { baselineLayer?: ReactNode }) {
  const frontWidth = frame.right - frame.left;
  const frontHeight = frame.bottom - frame.top;
  if (baselineLayer) return <g data-goal-net-3d data-goal-mouth-baseline-flat data-goal-frame-width-meters={GOAL_WIDTH_METERS} data-goal-frame-height-meters={GOAL_HEIGHT_METERS} data-goal-frame-aspect-ratio={GOAL_WIDTH_METERS / GOAL_HEIGHT_METERS} data-goal-depth-meters={GOAL_DEPTH_METERS}>
    <rect x={frame.left - 12} y={frame.top - 12} width={frontWidth + 24} height={frontHeight + 24} fill="#E8E4DC" fillOpacity=".9"/>
    <rect x={frame.left} y={frame.top} width={frontWidth} height={frontHeight} fill="#0B1220"/>
    {baselineLayer}
    <rect x={frame.left} y={frame.top} width={frontWidth} height={frontHeight} fill="none" stroke="#0B1220" strokeWidth="1.4"/>
  </g>;
  return <g data-goal-net-3d data-goal-net-vanishing-point={`${vanishingPoint.x} ${vanishingPoint.y}`} data-goal-frame-width-meters={GOAL_WIDTH_METERS} data-goal-frame-height-meters={GOAL_HEIGHT_METERS} data-goal-frame-aspect-ratio={GOAL_WIDTH_METERS / GOAL_HEIGHT_METERS} data-goal-depth-meters={GOAL_DEPTH_METERS} aria-hidden={baselineLayer ? undefined : true}>
    <defs><linearGradient id="goal-pipe" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#ffffff"/><stop offset=".25" stopColor="#f8fafc"/><stop offset=".5" stopColor="#cbd5e1"/><stop offset=".75" stopColor="#64748b"/><stop offset="1" stopColor="#1e293b"/></linearGradient><filter id="goal-shadow"><feGaussianBlur stdDeviation="10"/></filter></defs>
    <ellipse cx={(frame.left + frame.right) / 2} cy={frame.bottom + 18} rx={frontWidth * .46} ry="18" fill="#020617" opacity=".76" filter="url(#goal-shadow)"/>
    {/* low-contrast rear frame is deliberately secondary to the front regulation opening */}
    <path d={`M ${frame.left} ${frame.top} L ${rearFrame.left} ${rearFrame.top} L ${rearFrame.left} ${rearFrame.bottom} L ${frame.left} ${frame.bottom} Z`} fill="#0f1d2c" fillOpacity=".46"/>
    <path d={`M ${frame.right} ${frame.top} L ${rearFrame.right} ${rearFrame.top} L ${rearFrame.right} ${rearFrame.bottom} L ${frame.right} ${frame.bottom} Z`} fill="#0f1d2c" fillOpacity=".46"/>
    <path d={`M ${rearFrame.left} ${rearFrame.top} H ${rearFrame.right} V ${rearFrame.bottom} H ${rearFrame.left} Z`} fill="#0f1d2c" fillOpacity=".42" stroke="#475569" strokeOpacity=".46" strokeWidth="2.5"/>
    <path d={`M ${frame.left} ${frame.top} L ${rearFrame.left} ${rearFrame.top} M ${frame.right} ${frame.top} L ${rearFrame.right} ${rearFrame.top} M ${frame.left} ${frame.bottom} L ${rearFrame.left} ${rearFrame.bottom} M ${frame.right} ${frame.bottom} L ${rearFrame.right} ${rearFrame.bottom}`} stroke="#475569" strokeOpacity=".46" strokeWidth="2.5"/>
    <g data-goal-net-mesh stroke="#64748b" strokeOpacity=".72" strokeWidth="1.65" fill="none">
      {Array.from({ length: 9 }, (_, index) => { const ratio = index / 8, frontX = frame.left + ratio * frontWidth, rearTop = projectTowardVanishingPoint({ x: frontX, y: frame.top }), rearBottom = projectTowardVanishingPoint({ x: frontX, y: frame.bottom }); return <path key={`mesh-v${index}`} d={`M ${frontX} ${frame.top} Q ${frontX + (vanishingPoint.x - frontX) * .34} ${(frame.top + rearTop.y) / 2} ${rearTop.x} ${rearTop.y} M ${frontX} ${frame.bottom} Q ${frontX + (vanishingPoint.x - frontX) * .38} ${frame.bottom + 10 + ratio * 8} ${rearBottom.x} ${rearBottom.y}`}/>; })}
      {Array.from({ length: 8 }, (_, index) => { const ratio = index / 7, frontY = frame.top + ratio * frontHeight, rearLeft = projectTowardVanishingPoint({ x: frame.left, y: frontY }), rearRight = projectTowardVanishingPoint({ x: frame.right, y: frontY }), sag = 2 + ratio * ratio * 15; return <path key={`mesh-h${index}`} d={`M ${frame.left} ${frontY} Q ${(frame.left + frame.right) / 2} ${frontY + sag} ${frame.right} ${frontY} M ${rearLeft.x} ${rearLeft.y} Q ${(rearLeft.x + rearRight.x) / 2} ${rearLeft.y + sag * .45} ${rearRight.x} ${rearRight.y}`}/>; })}
      {Array.from({ length: 8 }, (_, index) => { const ratio = index / 7, frontY = frame.top + ratio * frontHeight, rearLeft = projectTowardVanishingPoint({ x: frame.left, y: frontY }), rearRight = projectTowardVanishingPoint({ x: frame.right, y: frontY }), sag = 3 + ratio * ratio * 18; return <path key={`mesh-side-${index}`} d={`M ${frame.left} ${frontY} Q ${rearLeft.x - 8} ${frontY + sag} ${rearLeft.x} ${rearLeft.y} M ${frame.right} ${frontY} Q ${rearRight.x + 8} ${frontY + sag} ${rearRight.x} ${rearRight.y}`}/>; })}
    </g>
    {/* layered stroke creates a pipe with bright highlight and shaded underside */}
    <path d={`M ${frame.left} ${frame.top} H ${frame.right} V ${frame.bottom} H ${frame.left} Z`} fill="#0b1520" fillOpacity=".74" stroke="#020617" strokeWidth="19" strokeLinejoin="round"/>
    {baselineLayer}
    <path d={`M ${frame.left} ${frame.top} H ${frame.right} V ${frame.bottom} H ${frame.left} Z`} fill="none" stroke="url(#goal-pipe)" strokeWidth="13" strokeLinejoin="round"/>
    <path d={`M ${frame.left + 6} ${frame.top + 5} H ${frame.right - 6} M ${frame.left + 5} ${frame.top + 6} V ${frame.bottom - 8}`} fill="none" stroke="#ffffff" strokeOpacity=".94" strokeWidth="2.5" strokeLinecap="round"/>
    <path d={`M ${frame.left + 5} ${frame.bottom} H ${frame.right - 5}`} fill="none" stroke="#0f172a" strokeWidth="3.5"/>
  </g>;
}

function ShootingQualityModule({ data }: { data: RenderableData }) {
  if (!("shootingQuality" in data)) return null;
  const quality = data.shootingQuality;
  const unavailable = quality.state === "unavailable";
  const tone = quality.xgotMinusXg === null
    ? "text-slate-300"
    : quality.xgotMinusXg > 0 ? "text-emerald-300"
      : quality.xgotMinusXg < 0 ? "text-rose-300"
        : "text-slate-200";
  const value = quality.xgotMinusXg === null
    ? null
    : `${quality.xgotMinusXg > 0 ? "+" : ""}${quality.xgotMinusXg.toFixed(2)}`;
  const hasServerSample = quality.eligibleShotCount !== null && quality.totalShotCount !== null;
  const explanation = "xGOT−xG는 슈팅이 주어진 기회보다 얼마나 좋은 코스로 향했는지를 나타냅니다. 양수면 기회 대비 더 잘 마무리한 것이고, 음수면 기회 대비 손해를 뜻합니다.";
  return <section data-shooting-quality-module data-shooting-quality-state={quality.state} aria-labelledby="shooting-quality-title" className="mt-3 rounded-md border border-cyan-200/20 bg-cyan-950/20 px-3 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="type-caption font-bold uppercase tracking-[.18em] text-cyan-100/75">골문 기준선 · 슈팅 품질</p>
      {quality.state === "partial" && <span data-shooting-quality-partial className="rounded border border-amber-300/55 bg-amber-300/10 px-2 py-0.5 type-caption font-bold text-amber-200">일부 표본 누락</span>}
      {unavailable && <span className="rounded border border-slate-400/40 bg-slate-400/10 px-2 py-0.5 type-caption font-bold text-slate-200">데이터 없음</span>}
    </div>
    <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
      <div>
        <h3 id="shooting-quality-title" className="text-sm font-bold text-zinc-50">슈팅 품질 (xGOT − xG)</h3>
        <p className="mt-1 type-caption leading-5 text-zinc-300">골문 확률 기준선은 5시즌 전체 관측값이며, 아래 값은 현재 선수·선택 컨텍스트의 서버 계산값입니다.</p>
      </div>
      <span tabIndex={0} role="img" aria-label={explanation} title={explanation} className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-cyan-100/45 text-base font-black text-cyan-100 focus-visible:ring-2 focus-visible:ring-lime-300">?</span>
    </div>
    {unavailable ? <p data-shooting-quality-unavailable className="mt-3 text-sm font-semibold text-slate-300">슈팅 품질 데이터를 사용할 수 없습니다{quality.reason ? `: ${quality.reason}` : "."}</p> : <>
      {value !== null && <p data-shooting-quality-value className={`mt-3 text-3xl font-black tabular-nums ${tone}`}>{value}</p>}
      {hasServerSample && <p data-shooting-quality-sample className="mt-1 text-base text-zinc-200">xG·xGOT 모두 관측된 표본 {quality.eligibleShotCount} / 전체 {quality.totalShotCount}슛</p>}
      {quality.state === "partial" && <p data-shooting-quality-reason className="mt-2 text-base text-amber-100">서버 표본 상태: {quality.reason}</p>}
      <p data-shooting-quality-provenance className="mt-2 type-caption text-zinc-400">서버 원천: {quality.source ?? "unavailable"} · 계산식: {quality.formulaVersion}</p>
    </>}
  </section>;
}

const PLACEMENT_COPY = {
  title: "배치 기준 기대 득점",
  expected: "기대 득점",
  actual: "실제 득점",
  delta: "차이",
  sample: "골문 안 슛",
  stretched: "골문은 가독성을 위해 실제 비율보다 세로로 늘려 표시합니다.",
} as const;

export function GoalMouthView({ data, config, baselineResource }: { data: RenderableData; config?: MessiApiConfig; baselineResource?: GoalMouthBaselineState }) {
  const { includePenalties, summaryShots } = usePitchPenalty();
  const [visibleStatus, setVisibleStatus] = useState<VisibleStatus>("all");
  const [zoom, setZoom] = useState<ZoomLevel>(1);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0 });
  const [activeOffFrameShotId, setActiveOffFrameShotId] = useState<string | null>(null);
  const [baselineVisible, setBaselineVisible] = useState(true);
  const [activeBaselineCellId, setActiveBaselineCellId] = useState<string | null>(null);
  const baselineId = useId().replace(/:/g, "");
  const internalBaseline = useGoalMouthBaseline(config, undefined, baselineResource === undefined);
  const baseline = baselineResource ? { state: baselineResource, retry: internalBaseline.retry } : internalBaseline;
  const pointerPan = useRef<{ pointerId: number; clientX: number; clientY: number; viewport: Viewport } | null>(null);
  const filteredShots = useMemo(() => excludePenaltyShots(data.shots, includePenalties), [data.shots, includePenalties]);
  // The xG scale is stable while the shared penalty toggle changes visibility.
  const medianXg = useMemo(() => medianObservedXg(data.shots), [data.shots]);
  const endpointShots = filteredShots.filter((shot) => shot.endpointAvailable && shot.goalMouthY !== null && shot.goalMouthZ !== null && shot.status !== "blocked");
  const unplotted = filteredShots.filter((shot) => !shot.endpointAvailable);
  // Never fit the viewport to provider endpoint coordinates: valid far-wide
  // misses must not shrink the measured goal opening at 1×.
  const baseViewBox = compactBaseViewBox;
  const visibleViewport = zoomViewport(baseViewBox, zoom);
  const safeViewport = clampViewport(viewport, baseViewBox, zoom);
  const viewBox = zoom === 1
    ? zoomedViewBox(baseViewBox, zoom)
    : `${baseViewBox.minX + safeViewport.x} ${baseViewBox.minY + safeViewport.y} ${visibleViewport.width} ${visibleViewport.height}`;
  const tooltipBounds: TooltipBounds = zoom === 1
    ? { minX: baseViewBox.minX, minY: baseViewBox.minY, maxX: baseViewBox.minX + baseViewBox.width, maxY: baseViewBox.minY + baseViewBox.height }
    : { minX: baseViewBox.minX + safeViewport.x, minY: baseViewBox.minY + safeViewport.y, maxX: baseViewBox.minX + safeViewport.x + visibleViewport.width, maxY: baseViewBox.minY + safeViewport.y + visibleViewport.height };
  const visibleShots = useMemo(() => visibleStatus === "all" ? endpointShots : endpointShots.filter((shot) => shot.status === visibleStatus), [endpointShots, visibleStatus]);
  const offFrameGroups = useMemo(() => {
    const groups = new Map<string, FinalThirdShot[]>();
    endpointShots.filter(isOffFrame).forEach((shot) => {
      const key = `${shot.goalMouthY}:${shot.goalMouthZ}`;
      groups.set(key, [...(groups.get(key) ?? []), shot]);
    });
    return groups;
  }, [endpointShots]);
  const counts = { all: filteredShots.length, goal: filteredShots.filter((shot) => shot.status === "goal").length, on_target: filteredShots.filter((shot) => shot.status === "on_target").length, off_target: filteredShots.filter((shot) => shot.status === "off_target").length };
  // The shared pitch snapshot is the canonical event total. Goal-Mouth's
  // endpoint subset intentionally omits unavailable endpoints, so it must not
  // become a conflicting second total for the same toggle state.
  const shotSummary = summaryShots
    ? summarizeShots(excludePenaltyShots(summaryShots, includePenalties))
    : summarizeShots(filteredShots);
  useEffect(() => { setViewport({ x: 0, y: 0 }); setZoom(1); setActiveOffFrameShotId(null); setActiveBaselineCellId(null); pointerPan.current = null; }, [data]);
  const setZoomLevel = (next: ZoomLevel) => { setViewport((current) => centeredViewport(current, baseViewBox, zoom, next)); setZoom(next); };
  const resetViewport = () => { pointerPan.current = null; setZoom(1); setViewport({ x: 0, y: 0 }); };
  const panBy = (x: number, y: number) => setViewport((current) => clampViewport({ x: current.x + x, y: current.y + y }, baseViewBox, zoom));
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (zoom === 1 || event.defaultPrevented) return;
    pointerPan.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewport: safeViewport };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = pointerPan.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    setViewport(clampViewport({
      x: start.viewport.x - (event.clientX - start.clientX) * visibleViewport.width / bounds.width,
      y: start.viewport.y - (event.clientY - start.clientY) * visibleViewport.height / bounds.height,
    }, baseViewBox, zoom));
  };
  const endPointerPan = (event: PointerEvent<SVGSVGElement>) => {
    if (pointerPan.current?.pointerId !== event.pointerId) return;
    pointerPan.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "Escape") { event.preventDefault(); resetViewport(); return; }
    if (zoom === 1) return;
    const step = Math.min(48, visibleViewport.width / 5);
    if (event.key === "ArrowLeft") { event.preventDefault(); panBy(-step, 0); }
    else if (event.key === "ArrowRight") { event.preventDefault(); panBy(step, 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); panBy(0, -step); }
    else if (event.key === "ArrowDown") { event.preventDefault(); panBy(0, step); }
  };
  const baselineLayer = baselineVisible && baseline.state.kind === "ready"
    ? <GoalMouthBaselineLayer baseline={baseline.state.data.data} activeCellId={activeBaselineCellId} onActivate={setActiveBaselineCellId} onDeactivate={(cellId) => setActiveBaselineCellId((current) => current === cellId ? null : current)} patternId={`goal-mouth-baseline-hatch-${baselineId}`}/>
    : undefined;
  const baselineData = baseline.state.kind === "ready" ? baseline.state.data.data : null;
  const baselineStatus = baseline.state.kind === "loading"
    ? GOAL_MOUTH_COPY.baselineLoading
    : baseline.state.kind === "error" ? GOAL_MOUTH_COPY.baselineError
      : baseline.state.kind === "unavailable" ? GOAL_MOUTH_COPY.baselineUnavailable : null;
  return <section data-goal-mouth-card aria-labelledby="goal-mouth-card-title" className="min-w-0 overflow-hidden rounded-[18px] border border-white/[.08] bg-[#06080b]">
    <header className="flex flex-col gap-2 border-b border-white/[.08] px-5 pb-3 pt-5 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h2 id="goal-mouth-card-title" className="type-title font-black text-white">{GOAL_MOUTH_COPY.title}</h2>
        <p className="mt-1 type-caption font-semibold text-zinc-500">{GOAL_MOUTH_COPY.playerCellGuide}</p>
      </div>
      {baselineData && <div data-goal-mouth-baseline-header className="max-w-[536px] text-left lg:text-right">
        <p className="text-[9.5px] font-semibold text-zinc-500">{GOAL_MOUTH_COPY.baseline} · {baselineData.provenance.sourceSeasons.length}개 시즌 ({baselineData.provenance.sourceSeasons[0]}~{baselineData.provenance.sourceSeasons.at(-1)}) · 유효 슈팅 {baselineData.provenance.totalShots?.toLocaleString() ?? "—"} · 득점 {baselineData.provenance.totalGoals?.toLocaleString() ?? "—"}</p>
        <p className="mt-1 type-caption text-zinc-600">{GOAL_MOUTH_COPY.cellGuide}</p>
      </div>}
      {baselineStatus && <p data-goal-mouth-baseline-status role="status" className="type-caption text-zinc-400">{baselineStatus}</p>}
    </header>
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 p-3">
      <div role="group" aria-label="Goal-Mouth shot visibility" className="flex flex-wrap items-center gap-2">{(["all", ...statuses] as const).map((status) => <button key={status} type="button" aria-pressed={visibleStatus === status} onClick={() => setVisibleStatus(status)} className="min-h-10 rounded border border-white/20 px-3 text-base font-bold aria-pressed:border-lime-300 aria-pressed:bg-lime-300 aria-pressed:text-zinc-950 focus-visible:ring-2 focus-visible:ring-lime-300">{status === "all" ? "All" : statusStyle[status].label} {counts[status]}</button>)}</div>
      {baseline.state.kind === "ready" && <button type="button" aria-pressed={baselineVisible} onClick={() => setBaselineVisible((value) => !value)} className="min-h-10 rounded border border-white/20 px-3 text-base font-bold aria-pressed:border-rose-300 aria-pressed:bg-rose-300/15 focus-visible:ring-2 focus-visible:ring-lime-300">{GOAL_MOUTH_COPY.baselineToggle}</button>}
      <div role="group" aria-label="Goal-Mouth zoom controls" className="ml-auto flex items-center gap-1"><button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoomLevel((zoom - 1) as ZoomLevel)} className="min-h-10 min-w-10 rounded border border-white/20 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">−</button><button type="button" aria-label="Zoom in" disabled={zoom === 3} onClick={() => setZoomLevel((zoom + 1) as ZoomLevel)} className="min-h-10 min-w-10 rounded border border-white/20 px-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">+</button><button type="button" aria-label="Reset zoom and pan" disabled={zoom === 1 && safeViewport.x === 0 && safeViewport.y === 0} onClick={resetViewport} className="min-h-10 rounded border border-white/20 px-3 text-base font-bold disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-lime-300">Reset</button><span aria-live="polite" data-goal-mouth-zoom className="ml-1 min-w-20 text-right text-base text-zinc-400">Zoom {zoom}×</span></div>
      <span className="w-full text-base text-zinc-400 sm:w-auto sm:ml-2">Blocked {unplotted.length} · audit only</span>
    </div>
    <svg data-goal-mouth-viewbox={viewBox} viewBox={viewBox} className="block h-auto w-full touch-none cursor-grab active:cursor-grabbing" role="img" tabIndex={0} aria-label={`Three-dimensional goal-mouth plot with ${visibleShots.length} visible authoritative endpoints and ${unplotted.length} unplotted endpoints. Zoom ${zoom}x. Drag to pan when zoomed.`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointerPan} onPointerCancel={endPointerPan} onLostPointerCapture={() => { pointerPan.current = null; }} onKeyDown={onKeyDown}>
      <GoalNet baselineLayer={baselineLayer}/>{visibleShots.map((shot) => { const group = offFrameGroups.get(`${shot.goalMouthY}:${shot.goalMouthZ}`) ?? [shot]; const groupIndex = group.findIndex((candidate) => candidate.shotId === shot.shotId); return <Marker key={shot.shotId} shot={shot} medianXg={medianXg} endpointShots={endpointShots} fanOffset={group.length > 1 ? groupIndex - (group.length - 1) / 2 : 0} fanCount={group.length} active={activeOffFrameShotId === shot.shotId} onActivate={() => setActiveOffFrameShotId(shot.shotId)} onDeactivate={() => setActiveOffFrameShotId((current) => current === shot.shotId ? null : current)} tooltipBounds={tooltipBounds}/>; })}
    </svg>
    <div className="border-t border-white/10 px-5 py-4 type-caption text-zinc-300"><p>마커 크기는 xG에 비례합니다. 프레임 도달 슛은 흰 공, 빗나감은 비운 공으로 표시하며 xG 미상은 중앙값 크기입니다.</p><p data-goal-mouth-shot-summary className="mt-2">{penaltyStateLabel(includePenalties)} · 슛 {shotSummary.shots} · 득점 {shotSummary.goals} · xG {shotSummary.xg.toFixed(2)} · 전환율 {shotSummary.conversionRatePct?.toFixed(1) ?? "—"}%</p>{baseline.state.kind === "ready" && baseline.state.data.data.placementSummary && <section data-placement-summary className="mt-3 flex flex-col gap-3 rounded-[10px] border border-[#27272a] bg-[#0b1220] px-[18px] py-3 lg:flex-row lg:items-center lg:justify-between" aria-labelledby="placement-summary-title"><div><h3 id="placement-summary-title" className="type-label font-black text-zinc-50">{PLACEMENT_COPY.title}</h3><dl className="mt-2 grid grid-cols-2 gap-x-[26px] gap-y-2 sm:grid-cols-4"><div><dt className="type-caption font-semibold text-zinc-500">{PLACEMENT_COPY.sample}</dt><dd className="mt-[3px] type-body font-black tabular-nums text-white">{baseline.state.data.data.placementSummary.onFrameShots}</dd></div><div><dt className="type-caption font-semibold text-zinc-500">{PLACEMENT_COPY.expected}</dt><dd className="mt-[3px] type-body font-black tabular-nums text-sky-400">{baseline.state.data.data.placementSummary.placementExpectedGoals.toFixed(2)}골</dd></div><div><dt className="type-caption font-semibold text-zinc-500">{PLACEMENT_COPY.actual}</dt><dd className="mt-[3px] type-body font-black tabular-nums text-lime-300">{baseline.state.data.data.placementSummary.actualGoals}골</dd></div><div><dt className="type-caption font-semibold text-zinc-500">{PLACEMENT_COPY.delta}</dt><dd className={`mt-[3px] type-body font-black tabular-nums ${baseline.state.data.data.placementSummary.delta >= 0 ? "text-lime-300" : "text-rose-300"}`}>{baseline.state.data.data.placementSummary.delta >= 0 ? "+" : ""}{baseline.state.data.data.placementSummary.delta.toFixed(2)}</dd></div></dl></div><p className="max-w-[430px] type-caption leading-4 text-zinc-600">골문 도달 슛이 꽂힌 칸의 리그 득점 확률을 합산한 서버 값입니다. 블록된 슛은 골라인에 도달하지 않아 포함하지 않습니다.<br/>{PLACEMENT_COPY.stretched}</p></section>}<ShootingQualityModule data={data}/>{unplotted.length > 0 && <section aria-labelledby="unplotted-endpoints" className="mt-2"><h3 id="unplotted-endpoints" className="font-semibold">{unplotted.length} endpoint{unplotted.length === 1 ? "" : "s"} not plotted</h3><ul aria-label="Unplotted endpoint audit list" className="mt-1 max-h-32 space-y-1 overflow-y-auto pr-1">{unplotted.map((shot) => <li key={shot.shotId}><code>{shot.shotId}</code> — {shot.status}, {shot.endpointReason}</li>)}</ul></section>}</div>
  </section>;
}
