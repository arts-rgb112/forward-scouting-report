import { useEffect, useRef, useState, type ReactNode } from "react";

import { fetchPlayerDataQuality, DataQualityIdentityError } from "../api/dataQualityApi";
import { parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError } from "../api/errors";
import { fetchLeaderboardOptions, fetchPlayerDetail, fetchTacticalQuadrant } from "../api/leaderboardsApi";
import { fetchHistoryLeaderboardOptions, fetchPlayerSummary, type PlayerHistoryEntry } from "../api/playerHistoryApi";
import { datasetHref } from "../dashboard/datasetRoute";
import { metricIsImputed, qualityDisplay, type QualityDisplay } from "../dashboard/dataQualityViewModel";
import { getScoreBand, resolveTierPresentation } from "../dashboard/scoutingConfig";
import { TierBadge } from "../dashboard/components/TierBadge";
import type { DatasetRouteState, Player, PlayerAnalysis, TacticalQuadrant } from "../dashboard/types";
import { axisDetail, detailMetrics, metricProfile, seasonScoreRows, selectedScore, tacticalCopy, wholeScore } from "./playerDetailViewModel";
import { VolumeBenchmarkRadar as ServerVolumeBenchmarkRadar } from "./VolumeBenchmarkRadar";
import { useVolumeBenchmark } from "./useVolumeBenchmark";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const contextLabel = (context: DatasetRouteState) => context.mode === "league" ? `League · ${context.scope} leagues` : `Europe · ${context.competition.toUpperCase()}`;
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;
const dossierGradient = (code: string) => ({ diamond: "from-violet-300/25 via-violet-950/25 to-[#101415]", emerald: "from-emerald-300/25 via-emerald-950/25 to-[#101415]", platinum: "from-cyan-300/25 via-cyan-950/25 to-[#101415]", gold: "from-amber-300/25 via-amber-950/25 to-[#101415]", silver: "from-slate-200/20 via-slate-800/30 to-[#101415]", bronze: "from-orange-300/25 via-orange-950/25 to-[#101415]" }[code] ?? "from-zinc-300/15 via-zinc-900/30 to-[#101415]");
export type PlayerHistoryState = { loading: boolean; entries: PlayerHistoryEntry[]; failed: number; requestedSeasons: number };

function useScope8(config: MessiApiConfig | undefined, dataset: DatasetRouteState) {
  const [state, setState] = useState<"checking" | "supported" | "unsupported">(dataset.mode === "league" && dataset.scope === 8 ? "checking" : "supported");
  useEffect(() => {
    if (dataset.mode !== "league" || dataset.scope !== 8 || !config) { setState("supported"); return; }
    const controller = new AbortController(); let current = true; const live = () => current && !controller.signal.aborted; setState("checking");
    const timeout = window.setTimeout(() => { if (live()) setState("unsupported"); controller.abort(); }, 8_000);
    void fetchLeaderboardOptions(config, controller.signal).then((options) => { if (live()) setState(options.scopes.some((scope) => scope.value === 8) ? "supported" : "unsupported"); }).catch(() => { if (live()) setState("unsupported"); }).finally(() => window.clearTimeout(timeout));
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [config, dataset.mode, dataset.scope]);
  return state;
}

function useHistory(config: MessiApiConfig | undefined, id: number, selected: DatasetRouteState, enabled: boolean) {
  const [state, setState] = useState<PlayerHistoryState>({ loading: false, entries: [], failed: 0, requestedSeasons: 0 });
  useEffect(() => {
    if (!config || !enabled || !validId(id)) { setState({ loading: false, entries: [], failed: 0, requestedSeasons: 0 }); return; }
    const controller = new AbortController(); setState({ loading: true, entries: [], failed: 0, requestedSeasons: 0 });
    void fetchHistoryLeaderboardOptions(config, controller.signal).then(async (options) => {
      const seasons = options.seasons.filter((season) => season !== selected.season);
      const contexts: DatasetRouteState[] = seasons.flatMap((season) => [
        { season, mode: "league" as const, scope: 8 as const, competition: "all" as const }, { season, mode: "europe" as const, scope: 8 as const, competition: "all" as const },
      ]);
      const results: PromiseSettledResult<PlayerHistoryEntry>[] = [];
      for (let start = 0; start < contexts.length; start += 4) results.push(...await Promise.allSettled(contexts.slice(start, start + 4).map((context) => fetchPlayerSummary(config, id, context, controller.signal))));
      if (controller.signal.aborted) return;
      const entries = results.filter((result): result is PromiseFulfilledResult<PlayerHistoryEntry> => result.status === "fulfilled").map((result) => result.value);
      setState({ loading: false, entries, failed: results.length - entries.length, requestedSeasons: seasons.length });
    }).catch(() => { if (!controller.signal.aborted) setState({ loading: false, entries: [], failed: 1, requestedSeasons: 0 }); });
    return () => controller.abort();
  }, [config, enabled, id, selected.season]);
  return state;
}

export function PlayerTierCard({ player, analysis, quality }: { player: Player; analysis?: PlayerAnalysis; quality: QualityDisplay }) {
  const tier = resolveTierPresentation(player.tier); const score = wholeScore(player, analysis);
  return <section className={`${panel} dossier-card relative isolate overflow-hidden bg-gradient-to-br ${dossierGradient(player.tier.code)} ${tier.className}`} aria-labelledby="player-tier-heading">
    <svg aria-hidden="true" viewBox="0 0 100 150" className="pointer-events-none absolute -right-8 -top-4 h-52 w-40 opacity-35"><path d="M50 4 91 28v55l-41 59L9 83V28Z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="m50 18 28 16v43L50 119 22 77V34Z" fill="none" stroke="currentColor" strokeWidth=".7"/><circle cx="50" cy="74" r="31" fill="none" stroke="currentColor" strokeWidth=".7"/></svg>
    <h2 id="player-tier-heading" className="sr-only">Player dossier</h2><div className="relative flex items-start justify-between gap-3"><div><p className="text-[10px] font-black tracking-[0.24em] text-zinc-300">M.E.S.S.I. DOSSIER</p><p className="mt-2 text-6xl font-black leading-none tabular-nums">{score}</p><p className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-300">Selected score · floored</p></div><TierBadge tier={player.tier} /></div>
    <div className="relative mt-5 flex items-center gap-3"><div className="h-20 w-16 shrink-0 overflow-hidden rounded border border-white/25 bg-black/30 shadow-inner">{player.face ? <img src={player.face} alt={`${player.name} portrait`} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-2xl" aria-hidden="true">{player.name[0]}</span>}</div><div className="min-w-0"><p className="truncate text-xl font-black text-white">{player.name}</p><p className="truncate text-xs text-zinc-200">{player.club.name} · {player.position}</p><p className="mt-1 text-xs text-zinc-300">{player.age === null ? "Age unavailable" : `Age ${player.age}`} · {player.minutes} min</p>{player.nation?.icon && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-200"><img src={player.nation.icon} alt="" className="h-3.5 w-5 object-contain"/>{player.nation.name}</p>}</div></div>
    <dl className="relative mt-5 grid grid-cols-6 gap-1 border-t border-white/15 pt-3">{detailMetrics.map(([id, short, label]) => <div key={id} className="min-w-0 rounded border border-white/10 bg-black/25 p-1.5 text-center"><dt className="text-[9px] font-black tracking-wide" aria-label={label}>{short}</dt><dd className={`mt-0.5 text-xs font-black ${getScoreBand(player.stats[id]).dotClassName}`}>{player.stats[id]}{metricIsImputed(quality, id) && <span title="Imputed server value" aria-label="imputed" className="ml-0.5 text-amber-200">*</span>}</dd></div>)}</dl>
  </section>;
}

export function SeasonScorePanel({ player, analysis, selected, history }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerHistoryState }) {
  const rows = seasonScoreRows(player, analysis, selected, history.entries);
  const range = [selectedScore(player, analysis), ...history.entries.map((entry) => entry.player.score)];
  return <section className={`${panel} season-rail border-l-2 border-l-white/30`} aria-labelledby="season-score-heading"><h2 id="season-score-heading" className="text-sm font-black">Season score rail</h2><div className="mt-2 flex items-center gap-2"><span className="text-4xl font-black tabular-nums">{wholeScore(player, analysis)}</span><TierBadge tier={player.tier} /></div><p className="text-xs text-zinc-400">{contextLabel(selected)} · {selected.season}</p><p className="mt-4 border-y border-white/10 py-2 text-[11px] text-zinc-300">Retrieved-score range: {Math.min(...range).toFixed(1)}–{Math.max(...range).toFixed(1)}{history.entries.length ? "" : " (selected context only)"}</p><ol className="mt-3 space-y-1.5 text-xs">{history.loading ? Array.from({ length: 4 }, (_, index) => <li key={index} className="h-8 animate-pulse rounded bg-white/10 motion-reduce:animate-none" />) : rows.map((row, index) => <li key={`${row.context.season}-${row.context.mode}`} className="flex items-center justify-between gap-2 border-l-2 border-white/15 bg-black/20 px-2 py-1.5"><span className="min-w-0"><b className="block truncate">{index === 0 ? "Selected · " : ""}{row.context.season}</b><span className="text-[10px] text-zinc-400">{row.context.mode === "league" ? `League · ${row.context.scope}` : `Europe · ${row.context.competition.toUpperCase()}`}</span></span><b className="shrink-0 tabular-nums">{index === 0 ? wholeScore(player, analysis) : row.player.score.toFixed(1)}</b></li>)}</ol>{!history.loading && history.requestedSeasons > 0 && <p className="mt-3 text-[11px] text-zinc-400">One best server context per season; top {Math.min(4, Math.max(0, rows.length - 1))} of {history.requestedSeasons} historical seasons.</p>}{history.failed > 0 && <p aria-live="polite" className="mt-2 text-xs text-amber-200">Partial history: {history.failed} context{history.failed === 1 ? "" : "s"} unavailable; range reflects retrieved scores only.</p>}</section>;
}

export function TacticalSummary({ player, analysis, quadrant, quality }: { player: Player; analysis?: PlayerAnalysis; quadrant?: TacticalQuadrant; quality: QualityDisplay }) { return <section className={panel} aria-labelledby="tactical-summary-heading"><h2 id="tactical-summary-heading" className="text-sm font-black">Tactical summary</h2><ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-300">{tacticalCopy(player, analysis, quadrant, quality).map((copy) => <li key={copy}>{copy}</li>)}</ul></section>; }

function shotMarker(point: PlayerAnalysis["spatial"]["shotmapPoints"][number], index: number) { const x = 3 + point.x * 1.35; const y = 3 + point.y * .94; if (point.outcome === "goal") return <path key={index} d={`M${x} ${y - 2}L${x + 2} ${y}L${x} ${y + 2}L${x - 2} ${y}Z`} className="fill-lime-300 stroke-white" />; if (point.outcome === "on_target") return <circle key={index} cx={x} cy={y} r="1.7" className="fill-cyan-300 stroke-zinc-950" />; if (point.outcome === "off_target") return <path key={index} d={`M${x - 1.6} ${y - 1.6}L${x + 1.6} ${y + 1.6}M${x + 1.6} ${y - 1.6}L${x - 1.6} ${y + 1.6}`} className="stroke-orange-300" strokeWidth=".8" />; return <rect key={index} x={x - 1.5} y={y - 1.5} width="3" height="3" className="fill-amber-300 stroke-zinc-300" />; }
export function SpatialPitch({ analysis }: { analysis?: PlayerAnalysis }) {
  const spatial = analysis?.spatial; const heatState = !spatial?.available ? "Activity heatmap unavailable" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points"; const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const counts = { goal: 0, on_target: 0, off_target: 0, blocked: 0 }; spatial?.shotmapPoints.forEach((shot) => counts[shot.outcome]++);
  return <section className={panel} aria-labelledby="spatial-pitch-heading"><h2 id="spatial-pitch-heading" className="text-sm font-black">Spatial pitch</h2><figure className="mt-3"><svg viewBox="0 0 141 100" className="w-full rounded bg-[#063525]" role="img" aria-label={`Horizontal pitch. ${heatState}. ${shotState}.`}><defs><filter id="heat-blur"><feGaussianBlur stdDeviation="3" /></filter></defs><rect x="3" y="3" width="135" height="94" fill="none" stroke="#b5d2bf" strokeWidth=".7"/><line x1="70.5" x2="70.5" y1="3" y2="97" stroke="#b5d2bf" strokeWidth=".7"/><circle cx="70.5" cy="50" r="10" fill="none" stroke="#b5d2bf" strokeWidth=".7"/><rect x="3" y="25" width="17" height="50" fill="none" stroke="#b5d2bf" strokeWidth=".7"/><rect x="121" y="25" width="17" height="50" fill="none" stroke="#b5d2bf" strokeWidth=".7"/>{spatial?.available && spatial.heatmapPoints.map((point, index) => <circle key={index} cx={3 + point.x * 1.35} cy={3 + point.y * .94} r="5" className="fill-cyan-300/25" filter="url(#heat-blur)"/>)}{spatial?.shotmapSnapshotAvailable && spatial.shotmapPoints.map(shotMarker)}</svg><figcaption className="mt-2 text-xs text-zinc-400">{heatState}. {shotState}. Goal ◇ · on target ● · off target × · blocked ■.</figcaption></figure><ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-400"><li>Goals {counts.goal}</li><li>On target {counts.on_target}</li><li>Off target {counts.off_target}</li><li>Blocked {counts.blocked}</li></ul></section>;
}

export function PercentileProfile({ player, analysis, quality }: { player: Player; analysis?: PlayerAnalysis; quality: QualityDisplay }) {
  return <section className={`${panel} six-sector-board`} aria-label="Percentile profile"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-black">Six-sector board</h2><p className="text-[10px] uppercase tracking-[0.16em] text-zinc-400">Server score + volume / ratio readouts</p></div><div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3">{metricProfile(player, analysis, quality).map((metric) => {
    const unavailable = !metric.volume && !metric.ratio;
    return <article key={metric.id} className="min-w-0 rounded border border-white/10 bg-black/20 p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[10px] font-black tracking-[0.16em] text-zinc-400">{metric.short}</p><h3 className="truncate text-xs font-bold">{metric.label}</h3></div><b className={`shrink-0 text-lg tabular-nums ${metric.band.dotClassName}`}>{metric.score}</b></div><div role="progressbar" aria-label={`${metric.label} server score`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.score} className="mt-3 h-1.5 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${metric.band.dotClassName}`} style={{ width: `${metric.score}%` }} /></div><dl className="mt-3 space-y-1 text-[11px] leading-4 text-zinc-400"><div><dt className="sr-only">Volume readout</dt><dd><span className="font-semibold text-zinc-300">{metric.volumeLabel}:</span> {axisDetail(metric.volume)}</dd></div><div><dt className="sr-only">Ratio readout</dt><dd><span className="font-semibold text-zinc-300">{metric.ratioLabel}:</span> {axisDetail(metric.ratio)}</dd></div><div><dt className="sr-only">Raw server values</dt><dd>Raw: volume {metric.volume?.rawValue ?? "unavailable"} · ratio {metric.ratio?.rawValue ?? "unavailable"}</dd></div></dl><p className={`mt-2 text-[10px] ${metric.imputed ? "text-amber-200" : "text-zinc-500"}`}>{metric.imputed ? <>Imputed server readout — <span>Conservative substitute</span></> : unavailable ? "Server readouts unavailable" : "Server readouts supplied"}</p></article>;
  })}</div></section>;
}

export function VolumeBenchmarkRadar({ player, config, dataset }: { player: Player; config?: MessiApiConfig; dataset: DatasetRouteState }) { const benchmark = useVolumeBenchmark(config, player.id, dataset); return <ServerVolumeBenchmarkRadar state={benchmark.state} playerName={player.name} onRetry={benchmark.retry} />; }

/** Presentation-only composition: all score, spatial and radar values remain server supplied. */
export function PlayerDetailDossierLayout({ player, analysis, quadrant, quality, history, config, dataset, afterPanels }: { player: Player; analysis?: PlayerAnalysis; quadrant?: TacticalQuadrant; quality: QualityDisplay; history: PlayerHistoryState; config?: MessiApiConfig; dataset: DatasetRouteState; afterPanels?: ReactNode }) {
  return <><div data-layout="dossier-season-analysis" className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 lg:grid-cols-[minmax(272px,300px)_minmax(240px,280px)_minmax(0,1fr)]"><PlayerTierCard player={player} analysis={analysis} quality={quality}/><SeasonScorePanel player={player} analysis={analysis} selected={dataset} history={history}/><section className="min-w-0 md:col-span-2 lg:col-span-1 rounded-xl border border-white/10 bg-[#0d1112] p-2 shadow-sm" aria-label="Tactical and spatial analysis"><TacticalSummary player={player} analysis={analysis} quadrant={quadrant} quality={quality}/><div className="mt-2"><SpatialPitch analysis={analysis}/></div></section></div>{!analysis && <p className="mt-4 rounded border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Server analysis is unavailable; no client-side analysis has been invented.</p>}<div data-layout="sectors-radar" className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[5fr_7fr]"><PercentileProfile player={player} analysis={analysis} quality={quality}/><VolumeBenchmarkRadar player={player} config={config} dataset={dataset}/></div>{afterPanels}</>;
}

export function PlayerDetailRoute({ id, dataset, config: providedConfig, afterPanels }: { id: number; dataset: DatasetRouteState; config?: MessiApiConfig; afterPanels?: ReactNode }) {
  let parsedConfig = providedConfig; if (!parsedConfig) try { parsedConfig = parseMessiApiConfig(import.meta.env, import.meta.env.MODE); } catch { /* surfaced below */ }
  const config = parsedConfig; const scope8 = useScope8(config, dataset); const [detail, setDetail] = useState<{ player: Player; analysis?: PlayerAnalysis }>(); const [quadrant, setQuadrant] = useState<TacticalQuadrant>(); const [quality, setQuality] = useState<QualityDisplay>({ kind: "idle" }); const [error, setError] = useState<"config" | "network" | "not-found">(); const [retry, setRetry] = useState(0); const titleRef = useRef<HTMLHeadingElement>(null);
  const history = useHistory(config, id, dataset, scope8 === "supported" && Boolean(detail));
  useEffect(() => {
    if (!config || scope8 !== "supported" || !validId(id)) { if (!validId(id)) setError("not-found"); else if (!config) setError("config"); return; }
    const controller = new AbortController(); let current = true;
    const live = () => current && !controller.signal.aborted;
    setDetail(undefined); setQuadrant(undefined); setQuality({ kind: "pending" }); setError(undefined);
    void fetchPlayerDetail(config, id, dataset, controller.signal).then((value) => { if (live()) setDetail(value); }).catch((cause) => { if (live()) setError(cause instanceof MessiApiError && cause.status === 404 ? "not-found" : "network"); });
    void fetchTacticalQuadrant(config, id, dataset, controller.signal).then((value) => { if (live()) setQuadrant(value); }).catch(() => undefined);
    void fetchPlayerDataQuality(config, id, dataset, controller.signal).then((value) => { if (live()) setQuality(qualityDisplay(value.dataQuality)); }).catch((cause) => { if (live()) setQuality({ kind: "unknown", cause: cause instanceof DataQualityIdentityError ? "identity" : "network" }); });
    return () => { current = false; controller.abort(); };
  }, [config, dataset.competition, dataset.mode, dataset.scope, dataset.season, id, retry, scope8]);
  useEffect(() => { if (detail) titleRef.current?.focus(); }, [detail]);
  const back = datasetHref("/", dataset); if (scope8 === "unsupported") return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><h1 tabIndex={-1}>8-league dataset unavailable</h1><p role="alert">8개 리그 데이터 is unavailable for this context.</p><a href={back}>Back to leaderboard</a></main>;
  if (error) return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><h1 tabIndex={-1} ref={titleRef}>{error === "not-found" ? "Player not found" : "Player details unavailable"}</h1><p role="alert">{error === "config" ? "Dashboard API configuration is unavailable." : "This player could not be loaded in the selected context."}</p>{error !== "not-found" && <button className="mt-4 min-h-11 rounded border px-4" onClick={() => setRetry((value) => value + 1)}>Retry</button>}<p><a href={back}>Back to leaderboard</a></p></main>;
  if (!detail) return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><a href={back}>← Back to leaderboard</a><h1 tabIndex={-1} ref={titleRef} className="mt-4 text-3xl font-black">Player profile</h1><div aria-busy="true" className="mt-4 grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-[minmax(272px,300px)_minmax(240px,280px)_minmax(0,1fr)]"><div className="h-72 animate-pulse rounded bg-white/10 motion-reduce:animate-none"/><div className="h-72 animate-pulse rounded bg-white/10 motion-reduce:animate-none"/><div className="h-72 animate-pulse rounded bg-white/10 motion-reduce:animate-none"/></div></main>;
  return <main id="main-content" className="mx-auto max-w-[1580px] overflow-x-hidden p-3 text-zinc-100 sm:p-6"><a href={back} className="inline-flex min-h-11 items-center text-lime-300 focus-visible:ring-2">← Back to leaderboard</a><h1 ref={titleRef} tabIndex={-1} className="text-3xl font-black outline-none">{detail.player.name}</h1><p className="mt-1 text-xs text-zinc-400">{contextLabel(dataset)} · {dataset.season}</p><PlayerDetailDossierLayout player={detail.player} analysis={detail.analysis} quadrant={quadrant} quality={quality} history={history} config={config} dataset={dataset} afterPanels={afterPanels}/></main>;
}
