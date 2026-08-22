import { useEffect, useMemo, useRef, useState } from "react";

import { DataQualityIdentityError, fetchPlayerDataQuality } from "../api/dataQualityApi";
import { parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError } from "../api/errors";
import { fetchComparison, fetchLeaderboardOptions, fetchPlayerDetail, fetchTacticalQuadrant } from "../api/leaderboardsApi";
import { fetchDuelPressDetail, DuelPressApiError } from "../api/duelPressApi";
import { leaderboardTaxonomyMode } from "../api/duelPressFeatureGate";
import { duelPressV2Enabled } from "../api/duelPressV2FeatureGate";
import type { DuelPressPlayerCore } from "../api/duelPressTypes";
import { DuelPressDetailMetrics } from "../dashboard/components/DuelPressDetailMetrics";
import { DataQualityBadge } from "../dashboard/components/DataQualityBadge";
import { metricIsImputed, qualityDisplay, type QualityDisplay } from "../dashboard/dataQualityViewModel";
import { datasetFromSearch, datasetHref } from "../dashboard/datasetRoute";
import { metricConfig, metricKeys } from "../dashboard/scoutingConfig";
import type { DatasetRouteState, MetricKey, PlayerAnalysis, PlayerComparison, PlayerDetail, RadarAxis, TacticalQuadrant } from "../dashboard/types";
import { PlayerDetailRoute as NativePlayerDetailRoute } from "../playerDetail/PlayerDetailRoute";
import { useContextualCompare, type ContextualComparePanelState } from "../api/useContextualCompare";
import type { ContextualCompareResponse } from "../api/contextualCompareContracts";
import { duelPressCompareHref, parseDuelPressCompare, type CompareSide } from "../dashboard/duelPressCompareUrl";

function currentDataset(config?: MessiApiConfig): DatasetRouteState { return datasetFromSearch(window.location.search, { season: config?.season ?? "2025/2026", mode: "league", scope: config?.scope ?? 8, competition: "all" }); }
function ContextBadge({ dataset }: { dataset: DatasetRouteState }) { return <span className="inline-flex rounded border border-lime-300/30 bg-lime-300/10 px-2 py-1 text-[10px] font-bold text-lime-200">{dataset.mode === "europe" ? `Europe · ${dataset.competition.toUpperCase()}` : `League · ${dataset.scope} leagues`} · {dataset.season}</span>; }
function BackLink({ dataset }: { dataset: DatasetRouteState }) { return <a href={datasetHref("/", dataset)} className="text-lime-300 hover:underline">← Leaderboard</a>; }
function Page({ children }: { children: React.ReactNode }) { return <main id="main-content" className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><article className="w-full max-w-3xl rounded-xl border border-white/10 bg-[#101415] p-7">{children}</article></main>; }
function FocusTitle({ children }: { children: React.ReactNode }) { const ref = useRef<HTMLHeadingElement>(null); useEffect(() => { ref.current?.focus(); }, []); return <h1 ref={ref} tabIndex={-1} className="mt-5 text-3xl font-black outline-none">{children}</h1>; }
function axisIsImputed(axis: RadarAxis, quality: QualityDisplay | undefined) {
  return quality !== undefined && (axis.imputed || (metricKeys as readonly string[]).includes(axis.id) && metricIsImputed(quality, axis.id as MetricKey));
}
function axisQualityCopy(quality: QualityDisplay) {
  return quality.kind === "incomplete"
    ? `이 축에는 대체값이 포함됩니다. 관측 데이터 비중: ${quality.dataQuality.observedWeightPct}%. 누락 구성요소에는 ${quality.dataQuality.fallbackComponentScore} 하한이 적용되었습니다.`
    : "서버가 이 축에 대체값이 포함되었다고 표시했습니다.";
}

function LegacyAnalysisSummary({ analysis, quality }: { analysis?: PlayerAnalysis; quality?: QualityDisplay }) {
  if (!analysis) return <section className="mt-6 rounded border border-white/10 bg-black/20 p-4" aria-label="Server analysis"><h2 className="font-bold">Server analysis</h2><p className="mt-2 text-sm text-zinc-400">The current API returned no analysis for this player. No client-side analysis has been invented.</p></section>;
  const metrics = Object.entries(analysis.rawMetrics).filter(([, value]) => value !== null).slice(0, 8);
  return <section className="mt-6 rounded border border-white/10 bg-black/20 p-4" aria-label="Server analysis"><h2 className="font-bold">Server analysis</h2><p className="mt-2 flex items-center text-sm text-zinc-300">Score {analysis.score.value} · cohort {analysis.score.population}<DataQualityBadge quality={quality} /></p><div className="mt-4 grid gap-4 md:grid-cols-2"><MetricTable title="Volume profile" axes={analysis.volumeRadar.axes} quality={quality} /><MetricTable title="Ratio profile" axes={analysis.ratioRadar.axes} quality={quality} /></div><p className="mt-4 text-xs text-zinc-400">Spatial data: {analysis.spatial.available ? `${analysis.spatial.heatmapPointCount} server-provided points` : "unavailable for this context"}.</p>{metrics.length > 0 && <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">{metrics.map(([key, value]) => <div key={key} className="rounded bg-white/[.03] p-2"><dt className="truncate text-zinc-500">{key}</dt><dd className="font-bold text-zinc-200">{String(value)}</dd></div>)}</dl>}</section>;
}
// `dangerZone` is the M.E.S.S.I. composite sector.  Its server display label
// has changed over time, but the consumer-facing name must remain consistent.
// Do not apply this transformation to raw drill-down metrics with another id.
export function displayRadarAxisLabel(axis: { id: string; label: string }): string { return axis.id === "dangerZone" ? "온볼 전개 영향력" : axis.label; }
function MetricTable({ title, axes, quality }: { title: string; axes: PlayerAnalysis["volumeRadar"]["axes"]; quality?: QualityDisplay }) { return <div><h3 className="text-sm font-bold text-zinc-200">{title}</h3><table className="mt-2 w-full text-left text-xs"><thead className="text-zinc-500"><tr><th>Metric</th><th className="text-right">Score</th><th className="text-right">Percentile</th></tr></thead><tbody>{axes.map((axis) => { const imputed = axisIsImputed(axis, quality); return <tr key={axis.id} className="border-t border-white/10"><th className="py-1 font-medium text-zinc-300">{displayRadarAxisLabel(axis)}</th><td className="py-1 text-right text-lime-300">{axis.score}{imputed && <span title={axisQualityCopy(quality!)} className="ml-1 text-[9px] text-amber-100">대체값</span>}</td><td className="py-1 text-right text-zinc-400">{axis.percentile ?? "—"}</td></tr>; })}</tbody></table></div>; }

function displayPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function displayAxisRank(axis: RadarAxis) {
  return axis.rank === null ? "—" : `#${axis.rank}`;
}

function DetailMetricTable({ title, axes, quality }: { title: string; axes: PlayerAnalysis["volumeRadar"]["axes"]; quality?: QualityDisplay }) {
  return <div>
    <h3 className="text-sm font-bold text-zinc-200">{title}</h3>
    <table className="mt-2 w-full text-left text-xs">
      <thead className="text-zinc-500"><tr><th>Metric</th><th className="text-right">Score</th><th className="text-right">Percentile</th><th className="text-right">Rank</th><th className="text-right">Cohort</th></tr></thead>
      <tbody>{axes.map((axis) => {
        const imputed = axisIsImputed(axis, quality);
        return <tr key={axis.id} className="border-t border-white/10"><th className="py-1 font-medium text-zinc-300">{displayRadarAxisLabel(axis)}</th><td className="py-1 text-right text-lime-300">{axis.score}{imputed && <span title={axisQualityCopy(quality!)} className="ml-1 text-[9px] text-amber-100">대체값</span>}</td><td className="py-1 text-right text-zinc-400">{displayPercent(axis.percentile)}</td><td className="py-1 text-right text-zinc-400">{displayAxisRank(axis)}</td><td className="py-1 text-right text-zinc-400">{axis.population || "—"}</td></tr>;
      })}</tbody>
    </table>
  </div>;
}

function PositionalGrid({ analysis }: { analysis: PlayerAnalysis }) {
  const { spatial } = analysis;
  if (!spatial.available || spatial.positionalGrid.length === 0) return null;
  const occupancyByCell = new Map(spatial.positionalGrid.map((cell) => [`${cell.depth}-${cell.lane}`, cell.occupancyPct]));
  const coreZoneIds = new Set(spatial.trueCore?.available ? spatial.trueCore.zoneIds : []);
  return <section aria-label="Positional grid" className="mt-4 rounded-lg border border-white/10 bg-zinc-950/60 p-3">
    <div className="flex items-baseline justify-between gap-3"><h3 className="text-sm font-bold text-zinc-200">Positional occupancy</h3><span className="text-xs text-zinc-500">six-depth by five-lane grid</span></div>
    <div className="mt-2 overflow-x-auto"><table className="w-full text-right text-xs"><caption className="sr-only">Six-depth by five-lane positional occupancy grid. True Core cells are highlighted in cyan.</caption><thead className="text-zinc-500"><tr><th className="text-left">Depth</th>{[1, 2, 3, 4, 5].map((lane) => <th key={lane}>Lane {lane}</th>)}<th>Depth total</th></tr></thead><tbody>{[1, 2, 3, 4, 5, 6].map((depth) => <tr key={depth} className="border-t border-white/10"><th className="py-1 text-left font-medium text-zinc-300">Depth {depth}</th>{[1, 2, 3, 4, 5].map((lane) => { const occupancy = occupancyByCell.get(`${depth}-${lane}`) ?? 0; const zoneId = `depth${depth}_lane${lane}`; const isTrueCore = coreZoneIds.has(zoneId); return <td key={lane} title={`${zoneId}: ${displayPercent(occupancy)}${isTrueCore ? " · True Core zone" : ""}`} className={`py-1 ${isTrueCore ? "bg-cyan-400/20 font-bold text-cyan-100 ring-1 ring-inset ring-cyan-300/50" : "text-zinc-400"}`}>{displayPercent(occupancy)}</td>; })}<td className="py-1 font-medium text-lime-300">{displayPercent(spatial.depthRatios[depth - 1])}</td></tr>)}</tbody></table></div>
    {spatial.trueCore?.available && <dl role="group" aria-label="True Core summary" className="mt-3 grid gap-x-4 gap-y-1 border-t border-cyan-300/20 pt-3 text-xs sm:grid-cols-2"><div><dt className="text-zinc-500">True Core zones</dt><dd className="font-bold text-cyan-100">{spatial.trueCore.zoneCount} cells · {spatial.trueCore.zoneIds.join(", ")}</dd></div><div><dt className="text-zinc-500">Cumulative density</dt><dd className="font-bold text-cyan-100">{displayPercent(spatial.trueCore.achievedDensityPct)} / target {spatial.trueCore.targetDensityPct}%</dd></div><div><dt className="text-zinc-500">Actual area</dt><dd className="font-bold text-cyan-100">{displayPercent(spatial.trueCore.coreAreaPct)}</dd></div><div><dt className="text-zinc-500">Definition</dt><dd className="text-zinc-400">{spatial.trueCore.definitionVersion}</dd></div></dl>}
  </section>;
}

function ShotmapPitchOverlay({ analysis }: { analysis: PlayerAnalysis }) {
  const { spatial } = analysis;
  const heatmap = spatial.heatmapPoints ?? [];
  const shots = spatial.shotmapPoints;
  const available = spatial.shotmapSnapshotAvailable;
  const shotState = !available ? "원천 슈팅 이력 없음" : shots.length === 0 ? "슈팅 0회" : `슈팅 ${shots.length}회`;
  const marker = (point: NonNullable<PlayerAnalysis["spatial"]["shotmapPoints"]>[number], index: number) => {
    const label = `${point.outcome}, x ${point.x.toFixed(1)}, y ${point.y.toFixed(1)}`;
    const key = `${point.outcome}-${index}`;
    const common = { tabIndex: 0, role: "img" as const, "aria-label": label };
    if (point.outcome === "goal") return <path key={key} {...common} d={`M ${point.x} ${point.y - 1.8} L ${point.x + 1.8} ${point.y} L ${point.x} ${point.y + 1.8} L ${point.x - 1.8} ${point.y} Z`} className="fill-lime-300 stroke-zinc-950" strokeWidth=".45"><title>{label}</title></path>;
    if (point.outcome === "off_target") return <path key={key} {...common} d={`M ${point.x - 1.5} ${point.y - 1.5} L ${point.x + 1.5} ${point.y + 1.5} M ${point.x + 1.5} ${point.y - 1.5} L ${point.x - 1.5} ${point.y + 1.5}`} className="fill-none stroke-rose-300" strokeWidth=".7"><title>{label}</title></path>;
    if (point.outcome === "blocked") return <rect key={key} {...common} x={point.x - 1.35} y={point.y - 1.35} width="2.7" height="2.7" className="fill-amber-300 stroke-zinc-950" strokeWidth=".45"><title>{label}</title></rect>;
    return <circle key={key} {...common} cx={point.x} cy={point.y} r="1.55" className="fill-sky-300 stroke-zinc-950" strokeWidth=".45"><title>{label}</title></circle>;
  };
  return <section aria-label="Shotmap and activity heatmap" className="mt-4 rounded-lg border border-white/10 bg-zinc-950/60 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><h3 className="text-sm font-bold text-zinc-200">Spatial shotmap</h3><span className="text-xs text-zinc-400">{shotState}</span></div>
    <figure className="mt-2" aria-describedby="shotmap-caption">
      <svg viewBox="0 0 100 100" className="w-full rounded border border-white/10 bg-emerald-950/40" role="img" aria-label="Pitch with server-provided activity heatmap and shot outcome markers">
        <rect x="2" y="2" width="96" height="96" fill="none" stroke="currentColor" className="text-zinc-400" strokeWidth=".7" /><line x1="2" x2="98" y1="50" y2="50" className="stroke-zinc-500" strokeWidth=".55" /><circle cx="50" cy="50" r="10" fill="none" className="stroke-zinc-500" strokeWidth=".55" /><rect x="28" y="2" width="44" height="16" fill="none" className="stroke-zinc-500" strokeWidth=".55" /><rect x="28" y="82" width="44" height="16" fill="none" className="stroke-zinc-500" strokeWidth=".55" />
        {heatmap.map((point, index) => <circle key={`heat-${index}`} cx={point.x} cy={point.y} r="3.2" className="fill-cyan-300/20" />)}
        {available && shots.map(marker)}
      </svg>
      <figcaption id="shotmap-caption" className="mt-2 text-xs text-zinc-500">활동 히트맵은 슈팅 데이터가 아닙니다. <span className="text-lime-200">◆ 골</span> · <span className="text-sky-200">● 유효슈팅</span> · <span className="text-rose-200">× 빗나감</span> · <span className="text-amber-200">■ 블록</span></figcaption>
    </figure>
  </section>;
}

function TacticalQuadrantChart({ quadrant }: { quadrant?: TacticalQuadrant }) {
  if (!quadrant || !quadrant.available || !quadrant.selectedPoint || quadrant.xMedian === null || quadrant.yMedian === null) return null;
  const xValues = quadrant.points.map((point) => point.netProgressionPer90);
  const yValues = quadrant.points.map((point) => point.inBoxXgotMinusXg);
  const xMin = Math.min(...xValues, quadrant.xMedian); const xMax = Math.max(...xValues, quadrant.xMedian);
  const yMin = Math.min(...yValues, quadrant.yMedian); const yMax = Math.max(...yValues, quadrant.yMedian);
  const xRange = xMax - xMin || 1; const yRange = yMax - yMin || 1;
  const left = 38; const right = 12; const top = 14; const bottom = 28; const width = 360; const height = 230;
  const x = (value: number) => left + ((value - xMin) / xRange) * (width - left - right);
  const y = (value: number) => height - bottom - ((value - yMin) / yRange) * (height - top - bottom);
  const selected = quadrant.selectedPoint;
  return <section aria-label="Tactical quadrant" className="mt-4 rounded-lg border border-white/10 bg-zinc-950/60 p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><h3 className="text-sm font-bold text-zinc-200">Tactical quadrant</h3><span className="text-xs text-zinc-500">{quadrant.cohortPopulation} players · median split</span></div>
    <svg className="mt-2 w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${selected.playerName} tactical quadrant: net progression per 90 against in-box xGOT minus xG`}>
      <rect x={left} y={top} width={x(quadrant.xMedian) - left} height={y(quadrant.yMedian) - top} className="fill-sky-400/10" />
      <rect x={x(quadrant.xMedian)} y={top} width={width - right - x(quadrant.xMedian)} height={y(quadrant.yMedian) - top} className="fill-lime-400/10" />
      <rect x={left} y={y(quadrant.yMedian)} width={x(quadrant.xMedian) - left} height={height - bottom - y(quadrant.yMedian)} className="fill-rose-400/10" />
      <rect x={x(quadrant.xMedian)} y={y(quadrant.yMedian)} width={width - right - x(quadrant.xMedian)} height={height - bottom - y(quadrant.yMedian)} className="fill-violet-400/10" />
      <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} stroke="currentColor" className="text-zinc-600" />
      <line x1={left} x2={left} y1={top} y2={height - bottom} stroke="currentColor" className="text-zinc-600" />
      <line x1={x(quadrant.xMedian)} x2={x(quadrant.xMedian)} y1={top} y2={height - bottom} stroke="currentColor" className="text-zinc-500" strokeDasharray="3 3" />
      <line x1={left} x2={width - right} y1={y(quadrant.yMedian)} y2={y(quadrant.yMedian)} stroke="currentColor" className="text-zinc-500" strokeDasharray="3 3" />
      <text x={left + 5} y={top + 23} className="fill-sky-200 text-[10px]">포처</text><text x={width - right - 5} y={top + 23} textAnchor="end" className="fill-lime-200 text-[10px]">컴플리트 포워드</text><text x={left + 5} y={height - bottom - 10} className="fill-rose-200 text-[10px]">컴플리트 낙제점</text><text x={width - right - 5} y={height - bottom - 10} textAnchor="end" className="fill-violet-200 text-[10px]">펄스 나인</text>
      {quadrant.points.filter((point) => !point.selected).map((point) => <circle key={point.playerId} cx={x(point.netProgressionPer90)} cy={y(point.inBoxXgotMinusXg)} r="2.5" className="fill-zinc-500"><title>{`${point.playerName} · ${point.teamName}`}</title></circle>)}
      <circle cx={x(selected.netProgressionPer90)} cy={y(selected.inBoxXgotMinusXg)} r="5" className="fill-lime-300 stroke-white" strokeWidth="1.5"><title>{`${selected.playerName} · selected player`}</title></circle>
      <text x={left} y={height - 7} className="fill-zinc-500 text-[9px]">Lower progression</text><text x={width - right} y={height - 7} textAnchor="end" className="fill-zinc-500 text-[9px]">Higher progression</text><text x={left + 3} y={top + 9} className="fill-zinc-500 text-[9px]">Higher in-box finish</text><text x={left + 3} y={height - bottom - 5} className="fill-zinc-500 text-[9px]">Lower in-box finish</text>
    </svg>
    <p className="mt-1 text-xs text-zinc-400"><span className="font-medium text-lime-300">{selected.playerName}</span>: {selected.netProgressionPer90.toFixed(2)} net progression/90 · {selected.inBoxXgotMinusXg.toFixed(2)} in-box xGOT − xG</p><p className="sr-only">Quadrants: upper left poacher, upper right complete forward, lower left complete failing point, lower right false nine.</p>
  </section>;
}

function AnalysisSummary({ analysis, quality, quadrant }: { analysis?: PlayerAnalysis; quality?: QualityDisplay; quadrant?: TacticalQuadrant }) {
  if (!analysis) return <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-zinc-400">No server-side analysis is available for this player.</div>;
  const scoreRank = analysis.score.rank === null ? "—" : `#${analysis.score.rank}`;
  return <section className="rounded-xl border border-white/10 bg-white/5 p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-black tracking-tight text-white">Server analysis</h2><p className="text-xs text-zinc-400">Score {analysis.score.value} · rank {scoreRank} / cohort {analysis.score.population}<DataQualityBadge quality={quality} /></p></div><span className="rounded bg-lime-300/10 px-2 py-1 text-xs font-bold text-lime-200">{analysis.score.archetype}</span></div><div className="mt-4 grid gap-4 md:grid-cols-2"><DetailMetricTable title="Volume radar" axes={analysis.volumeRadar.axes} quality={quality} /><DetailMetricTable title="Ratio radar" axes={analysis.ratioRadar.axes} quality={quality} /></div><p className="mt-4 text-xs text-zinc-500">Spatial data: {analysis.spatial.available ? `${analysis.spatial.heatmapPointCount} server-provided points` : "not available"}</p><PositionalGrid analysis={analysis} /><ShotmapPitchOverlay analysis={analysis} /><TacticalQuadrantChart quadrant={quadrant} /><div className="mt-3 grid grid-cols-2 gap-2 text-xs text-zinc-400">{Object.entries(analysis.rawMetrics).map(([key, value]) => <div key={key} className="flex justify-between gap-2 border-b border-white/5 py-1"><span>{key}</span><span className="text-zinc-200">{value ?? "—"}</span></div>)}</div></section>;
}

type Scope8Capability = "checking" | "supported" | "unsupported";

/** Direct routes must independently enforce the authoritative scope-8 options gate. */
function useScope8Capability(config: MessiApiConfig | undefined, dataset: DatasetRouteState): Scope8Capability {
  const needsProbe = Boolean(config && dataset.mode === "league" && dataset.scope === 8);
  const [capability, setCapability] = useState<Scope8Capability>(needsProbe ? "checking" : "supported");
  useEffect(() => {
    if (!needsProbe || !config) { setCapability("supported"); return; }
    const controller = new AbortController();
    let current = true;
    const settle = (next: Scope8Capability) => { if (current && !controller.signal.aborted) setCapability(next); };
    setCapability("checking");
    const timeout = window.setTimeout(() => { settle("unsupported"); controller.abort(); }, 8_000);
    void fetchLeaderboardOptions(config, controller.signal)
      .then((options) => settle(options.scopes.some((scope) => scope.value === 8) ? "supported" : "unsupported"))
      .catch(() => settle("unsupported"))
      .finally(() => window.clearTimeout(timeout));
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [config, needsProbe]);
  return needsProbe ? capability : "supported";
}

function Scope8Unavailable({ dataset }: { dataset: DatasetRouteState }) {
  return <Page><ContextBadge dataset={dataset} /><FocusTitle>8개 리그 데이터 사용 불가</FocusTitle><p role="alert" className="mt-3 text-zinc-400">현재 선택한 8개 리그 데이터는 이 서버에서 지원되지 않거나 확인할 수 없습니다. URL과 선택한 컨텍스트는 변경되지 않았습니다.</p><div className="mt-6"><BackLink dataset={dataset} /></div></Page>;
}

export function StaticRoute() {
  const path = window.location.pathname; let config: MessiApiConfig | undefined;
  try { config = parseMessiApiConfig(import.meta.env, import.meta.env.MODE); } catch { /* individual pages explain config failure */ }
  const dataset = currentDataset(config);
  if (path === "/about/messi") return <Page><FocusTitle>M.E.S.S.I. methodology</FocusTitle><div className="mt-3 space-y-3 text-sm text-zinc-300"><p>Crystal-v2 preserves legacy continuity. Scores, ranks and cohorts are server-authoritative; the browser does not calculate analytics.</p><p>Duel-press-v1 orders outside shot, box threat, danger zone, combined duel, space control and forward press. Combined duel retains ground and aerial evidence; its two contextual indicators are net progression per 90 and shooting luck or goalkeeper impact.</p><p>Source and provenance remain visible. Zero is observed, null is unavailable, and explicit imputed or fallback values are not silently substituted.</p><p>Spatial Pitch is server-provided: 2D/perspective density, the 30-zone model, zoom/pan and source-only shot trajectories. No trajectory is inferred.</p></div><a href="/" className="mt-6 inline-flex min-h-11 items-center text-lime-300 hover:underline">Browse leaderboard</a></Page>;
  if (path === "/compare") return <ContextualCompareRoute config={config} />;
  const playerId = Number(path.split("/")[2]);
  const taxonomy = new URLSearchParams(window.location.search).get("taxonomy");
  const duelPressRequested = taxonomy === "duel-press-v1";
  const duelPressEnabled = leaderboardTaxonomyMode(import.meta.env, import.meta.env.MODE) === "duel-press-v1";
  const duelPressV2Requested = duelPressV2Enabled(import.meta.env) && (taxonomy === "duel-press-v2" || taxonomy === "duel-press-v1");
  return <NativePlayerDetailRoute id={playerId} dataset={dataset} config={config} duelPressDetailRequested={duelPressRequested && duelPressEnabled && !duelPressV2Requested} duelPressV2Requested={duelPressV2Requested} />;
}

/** A strict taxonomy companion. It never owns or replaces the native player detail route. */
export function DuelPressCompanionPanel({ id, dataset, config }: { id: number; dataset: DatasetRouteState; config?: MessiApiConfig }) {
  const [player, setPlayer] = useState<DuelPressPlayerCore>(); const [error, setError] = useState<string>(); const [retry, setRetry] = useState(0); const generation = useRef(0);
  useEffect(() => { if (!Number.isSafeInteger(id) || id <= 0) { setError("Player not found."); return; } if (!config) { setError("API configuration is unavailable."); return; } const controller = new AbortController(); const current = ++generation.current; const live = () => generation.current === current && !controller.signal.aborted; setPlayer(undefined); setError(undefined); void fetchDuelPressDetail(config, id, dataset, controller.signal).then((value) => { if (live()) setPlayer(value); }).catch((cause: unknown) => { if (live()) setError(cause instanceof DuelPressApiError && cause.kind === "not-found" ? "Player not found in this saved context." : "Duel-press detail could not be loaded."); }); return () => controller.abort(); }, [config, dataset.competition, dataset.mode, dataset.scope, dataset.season, id, retry]);
  if (error) return <section aria-label="Duel and pressing companion" className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-4"><h2 className="text-sm font-black">Duel / Press companion unavailable</h2><p role="alert" className="mt-2 text-sm text-zinc-300">{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-4 min-h-11 rounded border border-lime-300/40 px-4 text-lime-300">Retry duel / press companion</button></section>;
  if (!player) return <section aria-label="Duel and pressing companion" aria-busy="true" className="mt-4 rounded-xl border border-white/10 bg-[#101415] p-4"><h2 className="text-sm font-black">Duel / Press companion</h2><div className="mt-3 h-20 animate-pulse rounded bg-white/10" /></section>;
  return <section aria-label="Duel and pressing companion" className="mt-4 rounded-xl border border-white/10 bg-[#101415] p-4"><h2 className="text-sm font-black">Duel / Press companion</h2><p className="mt-1 text-xs text-zinc-400">Server-provided duel and pressing taxonomy for this exact context.</p><div className="mt-4"><DuelPressDetailMetrics player={player}/></div></section>;
}

function LegacyPlayerDetailRoute({ id, dataset, config }: { id: number; dataset: DatasetRouteState; config?: MessiApiConfig }) {
  const [detail, setDetail] = useState<PlayerDetail>(); const [quadrant, setQuadrant] = useState<TacticalQuadrant>(); const [error, setError] = useState<"network" | "not-found" | "config">(); const [retry, setRetry] = useState(0); const [quality, setQuality] = useState<QualityDisplay>({ kind: "idle" });
  const scope8Capability = useScope8Capability(config, dataset);
  useEffect(() => {
    if (scope8Capability !== "supported") { setDetail(undefined); setQuadrant(undefined); setError(undefined); setQuality({ kind: "idle" }); return; }
    if (!Number.isInteger(id) || id <= 0) { setError("not-found"); return; } if (!config) { setError("config"); return; }
    const controller = new AbortController(); setDetail(undefined); setQuadrant(undefined); setError(undefined); setQuality({ kind: "pending" });
    // No Promise.all: the primary detail is valid independently of companion quality.
    void fetchPlayerDetail(config, id, dataset, controller.signal).then(setDetail).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof MessiApiError && cause.status === 404 ? "not-found" : "network"); });
    // The tactical chart is a companion API; its absence cannot hide the player report.
    void fetchTacticalQuadrant(config, id, dataset, controller.signal).then(setQuadrant).catch(() => { /* unavailable quadrant remains absent */ });
    void fetchPlayerDataQuality(config, id, dataset, controller.signal).then((data) => { if (!controller.signal.aborted) setQuality(qualityDisplay(data.dataQuality)); }).catch((cause: unknown) => { if (!controller.signal.aborted) setQuality({ kind: "unknown", cause: cause instanceof DataQualityIdentityError ? "identity" : cause instanceof MessiApiError && cause.kind === "http" ? "http" : cause instanceof MessiApiError && cause.kind === "network" ? "network" : "schema" }); });
    return () => controller.abort();
  }, [config, dataset, id, retry, scope8Capability]);
  const player = detail?.player; const analysis = detail?.analysis;
  if (scope8Capability === "unsupported") return <Scope8Unavailable dataset={dataset} />;
  return <Page><ContextBadge dataset={dataset} />{!player && !error && <><FocusTitle>Player profile</FocusTitle><div aria-busy="true" className="mt-5 space-y-3"><div className="h-7 w-48 animate-pulse rounded bg-white/10" /><div className="h-24 animate-pulse rounded bg-white/10" /></div></>}{error && <><FocusTitle>{error === "not-found" ? "Player not found" : "Player details unavailable"}</FocusTitle><p role="alert" className="mt-3 text-zinc-400">{error === "not-found" ? "This player is not available in the selected dataset." : error === "config" ? "Dashboard API configuration is unavailable." : "We could not load this player profile. Check your connection and try again."}</p>{error !== "not-found" && <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-5 min-h-11 rounded border border-lime-300/40 px-4 text-lime-300">Retry</button>}</>}{player && <><FocusTitle>{player.name}</FocusTitle><p className="mt-2 text-zinc-400">{player.club.name} · {player.league.name} · {player.position}</p><div className="mt-5 grid grid-cols-2 gap-3 text-sm">{metricKeys.map((key) => <div key={key} className="rounded bg-black/20 p-3"><span className="text-zinc-500">{metricConfig[key].label}</span><b className="float-right text-lime-300">{player.stats[key]}{metricIsImputed(quality, key) && <span className="ml-1 text-[9px] text-amber-100">대체값</span>}</b></div>)}</div><AnalysisSummary analysis={analysis} quality={quality} quadrant={quadrant} /></>}<div className="mt-6"><BackLink dataset={dataset} /></div></Page>;
}

function CompareRoute({ config }: { config?: MessiApiConfig }) {
  const parsed = parseDuelPressCompare(window.location.search); const [leftId, setLeftId] = useState(parsed?.left.playerId ?? 0); const [rightId, setRightId] = useState(parsed?.right.playerId ?? 0);
  const base = { season: config?.season ?? "2025/2026", mode: "league" as const, scope: config?.scope ?? 8, competition: "all" as const };
  const left = parsed?.left ?? { playerId: leftId, taxonomy: "duel-press-v1" as const, context: base }; const right = parsed?.right ?? { playerId: rightId, taxonomy: "duel-press-v1" as const, context: base };
  const request = useMemo(() => left.playerId > 0 && right.playerId > 0 ? { comparisonVersion: "contextual-compare-v1" as const, left: { player: { idNamespace: "fotmob" as const, playerId: left.playerId }, taxonomy: left.taxonomy, context: left.context }, right: { player: { idNamespace: "fotmob" as const, playerId: right.playerId }, taxonomy: right.taxonomy, context: right.context } } : null, [left.playerId, left.taxonomy, left.context, right.playerId, right.taxonomy, right.context]);
  const comparison = useContextualCompare(config, request);
  const dataset = currentDataset(config); const error = comparison.state === "error"; const setRetry = (_update: (value: number) => number) => comparison.retry();
  if (!config || error) return <Page><ContextBadge dataset={dataset} /><FocusTitle>Player comparison unavailable</FocusTitle><p role="alert" className="mt-3 text-zinc-400">{!config ? "Dashboard API configuration is unavailable." : "The server comparison could not be loaded."}</p>{config && <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-5 min-h-11 rounded border border-lime-300/40 px-4 text-lime-300">Retry</button>}<div className="mt-6"><BackLink dataset={dataset} /></div></Page>;
  return <Page><ContextBadge dataset={dataset} /><FocusTitle>Player comparison</FocusTitle>{!comparison ? <div aria-busy="true" className="mt-5 h-28 animate-pulse rounded bg-white/10" /> : <div className="mt-5 grid gap-3 sm:grid-cols-2">{comparison.players.map(({ player, analysis }) => <section key={player.id} className="rounded border border-white/10 bg-black/20 p-4"><h2 className="font-bold">{player.name}</h2><p className="text-xs text-zinc-500">{player.club.name} · {player.position}</p><p className="mt-2 text-sm text-lime-300">M.E.S.S.I. {player.score}</p><AnalysisSummary analysis={analysis} /></section>)}</div>}<div className="mt-6"><BackLink dataset={dataset} /></div></Page>;
}

type ManualSide = CompareSide;
function manualSide(playerId = 0, config?: MessiApiConfig): ManualSide { return { playerId, taxonomy: "duel-press-v1", context: { season: config?.season ?? "2025/2026", mode: "league", scope: config?.scope ?? 8, competition: "all" } }; }
function ManualSideFields({ label, side, onChange }: { label: string; side: ManualSide; onChange(next: ManualSide): void }) {
  const context = side.context;
  const patch = (partial: Partial<ManualSide>) => onChange({ ...side, ...partial });
  return <fieldset className="rounded-lg border border-white/10 bg-black/20 p-4"><legend className="px-1 font-black">{label}</legend><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs">FotMob player ID<input aria-label={`${label} FotMob player ID`} inputMode="numeric" value={side.playerId || ""} onChange={(event) => patch({ playerId: Number(event.target.value) })} className="mt-1 min-h-11 w-full rounded border border-white/10 bg-[#080b0c] px-2" /></label><label className="text-xs">Taxonomy<select aria-label={`${label} taxonomy`} value={side.taxonomy} onChange={(event) => patch({ taxonomy: event.target.value as ManualSide["taxonomy"] })} className="mt-1 min-h-11 w-full rounded border border-white/10 bg-[#080b0c] px-2"><option value="duel-press-v1">Duel / Press v1</option><option value="legacy-v1">Legacy v1</option></select></label><label className="text-xs">Season<input aria-label={`${label} season`} value={context.season} onChange={(event) => patch({ context: { ...context, season: event.target.value } as ManualSide["context"] })} className="mt-1 min-h-11 w-full rounded border border-white/10 bg-[#080b0c] px-2" /></label><label className="text-xs">Mode<select aria-label={`${label} mode`} value={context.mode} onChange={(event) => patch({ context: event.target.value === "europe" ? { season: context.season, mode: "europe", scope: null, competition: "all" } : { season: context.season, mode: "league", scope: 8, competition: "all" } })} className="mt-1 min-h-11 w-full rounded border border-white/10 bg-[#080b0c] px-2"><option value="league">League</option><option value="europe">Europe</option></select></label>{context.mode === "league" ? <label className="text-xs">League scope<select aria-label={`${label} league scope`} value={context.scope} onChange={(event) => patch({ context: { ...context, scope: Number(event.target.value) as 3 | 5 | 7 | 8 } })} className="mt-1 min-h-11 w-full rounded border border-white/10 bg-[#080b0c] px-2">{[3, 5, 7, 8].map((scope) => <option key={scope} value={scope}>{scope} leagues</option>)}</select></label> : <label className="text-xs">Europe competition<select aria-label={`${label} Europe competition`} value={context.competition} onChange={(event) => patch({ context: { ...context, competition: event.target.value as "all" | "ucl" | "uel" | "uecl" } })} className="mt-1 min-h-11 w-full rounded border border-white/10 bg-[#080b0c] px-2">{["all", "ucl", "uel", "uecl"].map((competition) => <option key={competition} value={competition}>{competition.toUpperCase()}</option>)}</select></label>}</div></fieldset>;
}
type ContextualReadout = NonNullable<ContextualCompareResponse["left"]["duelPressDetailReadout"]>;
type ContextualReadoutItem = ContextualReadout["categories"][number]["readouts"][number];

function ReadoutValue({ item }: { item: ContextualReadoutItem }) {
  const comparison = item.comparison;
  const value = item.value === null ? "Unavailable" : `${item.value}${item.unit === "percent" ? "%" : item.unit === "per90" ? " per 90" : ""}`;
  const comparisonText = comparison.state === "available"
    ? `Median ${comparison.median ?? "—"}; rank ${comparison.rank ?? "—"}/${comparison.population}; percentile ${comparison.percentile ?? "—"}`
    : "Comparison unavailable for this exact context";
  return <div className="rounded bg-white/[.03] p-2"><dt className="text-zinc-400">{item.label}</dt><dd className="mt-1 font-bold text-zinc-100">{value} <span className="text-[10px] font-normal text-zinc-400">({item.state.replaceAll("_", " ")})</span></dd><p className="mt-1 text-[10px] text-zinc-500">{comparisonText}. Source: {item.source.replaceAll("_", " ")}.</p></div>;
}

function DuelPressReadouts({ readout }: { readout: ContextualReadout }) {
  return <section className="mt-3 rounded border border-white/10 p-3" aria-label="Duel and press readouts"><h3 className="text-sm font-bold">Duel / press readouts</h3><p className="mt-1 text-xs text-zinc-400">Server-authoritative values for this exact player and context.</p><div className="mt-3 space-y-3">{readout.categories.map((category) => <section key={category.id} className="rounded border border-white/10 p-3"><h4 className="font-semibold">{category.id === "combinedDuel" ? "Combined duel (ground + aerial)" : category.label} {category.score === null ? "— unavailable" : `— score ${category.score}`} <span className="text-[10px] font-normal text-zinc-400">({category.scoreState})</span></h4>{category.imputedComponents?.length ? <p className="mt-1 text-xs text-amber-200">Imputed components: {category.imputedComponents.join(", ")}</p> : null}<dl className="mt-2 grid gap-2 sm:grid-cols-2">{category.readouts.map((item) => <ReadoutValue key={item.id} item={item} />)}</dl></section>)}</div><section className="mt-3 rounded border border-white/10 p-3"><h4 className="font-semibold">Context indicators</h4><p className="mt-1 text-xs text-zinc-400">Two server-provided neutral indicators; neither changes the category score.</p><dl className="mt-2 grid gap-2 sm:grid-cols-2">{readout.contextIndicators.map((item) => <ReadoutValue key={item.id} item={item} />)}</dl></section></section>;
}

function AuthoritativeDetail({ side }: { side: ContextualCompareResponse["left"] }) {
  if (side.componentAvailability.detail !== "available" || side.detail === null || side.detail.analysis === undefined) return <section className="mt-3 rounded border border-white/10 p-3"><h3 className="text-sm font-bold">Authoritative detail</h3><p className="mt-2 text-xs text-zinc-400">Unavailable for this exact context; no substitute is displayed.</p></section>;
  const metrics = Object.entries(side.detail.analysis.rawMetrics).filter(([, value]) => value !== null).slice(0, 6);
  return <section className="mt-3 rounded border border-white/10 p-3"><h3 className="text-sm font-bold">Authoritative detail</h3><p className="mt-1 text-xs text-zinc-400">Server score {side.detail.analysis.score.value}; cohort {side.detail.analysis.score.population}.</p>{metrics.length > 0 && <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">{metrics.map(([name, value]) => <div key={name} className="rounded bg-white/[.03] p-2"><dt className="text-zinc-500">{name}</dt><dd className="font-bold">{value}</dd></div>)}</dl>}</section>;
}

function ContextualResolvedSide({ side }: { side: ContextualCompareResponse["left"] }) {
  const unavailable = (name: string) => <section className="mt-3 rounded border border-white/10 p-3"><h3 className="text-sm font-bold">{name}</h3><p className="mt-2 text-xs text-zinc-400">Unavailable for this exact context; no domestic or inferred substitute is displayed.</p></section>;
  return <section className="rounded border border-white/10 bg-black/20 p-4"><h2 className="font-bold">{side.summary!.name}</h2><p className="text-xs text-zinc-400">{side.context.season} / {side.context.mode} / {side.summary!.club.name}</p><p className="mt-2 text-lime-300">M.E.S.S.I. {side.summary!.score}</p>{side.taxonomy === "duel-press-v1" && side.duelPressPlayer && <section className="mt-3 rounded border border-white/10 p-3"><h3 className="text-sm font-bold">Duel / press category scores</h3><dl className="mt-2 grid grid-cols-2 gap-2 text-xs">{Object.entries(side.duelPressPlayer.stats).map(([name, value]) => <div key={name} className="rounded bg-white/[.03] p-2"><dt className="text-zinc-500">{name}</dt><dd className="font-bold">{value}</dd></div>)}</dl></section>}{side.taxonomy === "duel-press-v1" && side.duelPressDetailReadout ? <DuelPressReadouts readout={side.duelPressDetailReadout} /> : null}<AuthoritativeDetail side={side} />{side.componentAvailability.dataQuality === "available" && side.dataQuality ? <section className="mt-3 rounded border border-white/10 p-3"><h3 className="text-sm font-bold">Data quality</h3><p className="mt-1 text-xs">Observed weight {side.dataQuality.observedWeightPct}% / {side.dataQuality.imputedMetrics.length ? `imputed: ${side.dataQuality.imputedMetrics.join(", ")}` : "fully observed"}</p></section> : unavailable("Data quality")}{side.componentAvailability.tacticalQuadrant === "available" ? <section className="mt-3 rounded border border-white/10 p-3"><h3 className="text-sm font-bold">Tactical quadrant</h3><p className="mt-1 text-xs text-zinc-400">Server-provided for this exact context.</p></section> : unavailable("Tactical quadrant")}</section>;
}

function AuthoritativeSide({ side, loading }: { side: ContextualCompareResponse["left"] | undefined; loading: boolean }) {
  if (loading) return <section aria-busy="true" className="rounded border border-white/10 p-4">Loading this exact context…</section>;
  if (!side) return <section className="rounded border border-white/10 p-4">Waiting for a complete two-side request.</section>;
  if (side.status !== "resolved") return <section className="rounded border border-amber-300/30 bg-amber-300/10 p-4"><h2 className="font-bold">{side.status === "invalid_context" ? "Exact context is invalid" : "Exact context unavailable"}</h2><p className="mt-2 text-sm">No server-authoritative data is available. Nothing is derived from a domestic context.</p></section>;
  if (side.status === "resolved") return <ContextualResolvedSide side={side} />;
}
function ContextualComparePanel({ label, panel, onRetry }: { label: string; panel: ContextualComparePanelState; onRetry(): void }) {
  if (panel.state === "loading") return <section aria-busy="true" className="rounded border border-white/10 p-4"><h2 className="font-bold">{label}</h2><p className="mt-2 text-sm text-zinc-400">Loading this exact context.</p></section>;
  if (panel.state === "error") return <section className="rounded border border-rose-300/30 bg-rose-300/10 p-4"><h2 className="font-bold">{label} unavailable</h2><p role="alert" className="mt-2 text-sm">{panel.error}</p><button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded border border-lime-300/40 px-3 text-lime-300">Retry {label.toLowerCase()} comparison</button></section>;
  if (panel.state === "idle") return <section className="rounded border border-white/10 p-4"><h2 className="font-bold">{label}</h2><p className="mt-2 text-sm text-zinc-400">Enter both exact contexts to request this comparison.</p></section>;
  if ("side" in panel) return <AuthoritativeSide side={panel.side} loading={false} />;
  return <section className="rounded border border-white/10 p-4"><h2 className="font-bold">{label}</h2><p className="mt-2 text-sm text-zinc-400">Waiting for this exact context.</p></section>;
}
function ContextualCompareRoute({ config }: { config?: MessiApiConfig }) {
  const canonical = parseDuelPressCompare(window.location.search); const legacyPlayers = new URLSearchParams(window.location.search).has("players");
  const [left, setLeft] = useState<ManualSide>(() => canonical?.left ?? manualSide(0, config)); const [right, setRight] = useState<ManualSide>(() => canonical?.right ?? manualSide(0, config));
  const request = useMemo(() => left.playerId > 0 && right.playerId > 0 ? { comparisonVersion: "contextual-compare-v1" as const, left: { player: { idNamespace: "fotmob" as const, playerId: left.playerId }, taxonomy: left.taxonomy, context: left.context }, right: { player: { idNamespace: "fotmob" as const, playerId: right.playerId }, taxonomy: right.taxonomy, context: right.context } } : null, [left, right]);
  const resource = useContextualCompare(config, request); const href = request ? duelPressCompareHref(left, right) : undefined;
  const panels = resource.panels;
  return <Page><FocusTitle>Player comparison</FocusTitle><p className="mt-2 text-sm text-zinc-400">Select each player and context independently. Requests use only the server contextual comparison contract.</p>{legacyPlayers && !canonical && <p role="alert" className="mt-3 text-sm text-amber-200">This legacy comparison link does not include each player’s full context. Choose both exact contexts before requesting a comparison.</p>}<div className="mt-5 grid gap-3 lg:grid-cols-2"><ManualSideFields label="Left player" side={left} onChange={setLeft} /><ManualSideFields label="Right player" side={right} onChange={setRight} /></div>{href ? <a href={href} className="mt-4 inline-flex min-h-11 items-center rounded bg-lime-300 px-4 text-sm font-black text-black">Open exact comparison URL</a> : <p role="alert" className="mt-4 text-sm text-amber-200">Enter two valid FotMob player IDs to request an exact comparison.</p>}<div className="mt-5 grid gap-3 lg:grid-cols-2"><ContextualComparePanel label="Left player" panel={panels.left} onRetry={resource.retry} /><ContextualComparePanel label="Right player" panel={panels.right} onRetry={resource.retry} /></div><div className="mt-6"><a href="/" className="text-lime-300 hover:underline">Leaderboard</a></div></Page>;
}
