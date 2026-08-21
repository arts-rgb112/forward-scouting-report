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
  const [state, setState] = useState<{ loading: boolean; entries: PlayerHistoryEntry[]; failed: number }>({ loading: false, entries: [], failed: 0 });
  useEffect(() => {
    if (!config || !enabled || !validId(id)) { setState({ loading: false, entries: [], failed: 0 }); return; }
    const controller = new AbortController(); setState({ loading: true, entries: [], failed: 0 });
    void fetchHistoryLeaderboardOptions(config, controller.signal).then(async (options) => {
      const seasons = options.seasons.filter((season) => season !== selected.season).slice(0, 4);
      const contexts: DatasetRouteState[] = seasons.flatMap((season) => [
        { season, mode: "league" as const, scope: 8 as const, competition: "all" as const }, { season, mode: "europe" as const, scope: 8 as const, competition: "all" as const },
      ]).slice(0, 8);
      const results: PromiseSettledResult<PlayerHistoryEntry>[] = [];
      for (let start = 0; start < contexts.length; start += 4) results.push(...await Promise.allSettled(contexts.slice(start, start + 4).map((context) => fetchPlayerSummary(config, id, context, controller.signal))));
      if (controller.signal.aborted) return;
      const entries = results.filter((result): result is PromiseFulfilledResult<PlayerHistoryEntry> => result.status === "fulfilled").map((result) => result.value);
      setState({ loading: false, entries, failed: results.length - entries.length });
    }).catch(() => { if (!controller.signal.aborted) setState({ loading: false, entries: [], failed: 1 }); });
    return () => controller.abort();
  }, [config, enabled, id, selected.season]);
  return state;
}

export function PlayerTierCard({ player, analysis, quality }: { player: Player; analysis?: PlayerAnalysis; quality: QualityDisplay }) {
  const tier = resolveTierPresentation(player.tier); const score = wholeScore(player, analysis);
  return <section className={`${panel} ${tier.className}`} aria-labelledby="player-tier-heading">
    <h2 id="player-tier-heading" className="sr-only">Player tier</h2><div className="text-5xl font-black tabular-nums">{score}</div>
    <div className="mt-3 flex items-center gap-3"><div className="h-14 w-14 overflow-hidden rounded-full bg-black/30">{player.face ? <img src={player.face} alt={`${player.name} portrait`} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-xl" aria-hidden="true">{player.name[0]}</span>}</div><div className="min-w-0"><p className="truncate text-lg font-black text-white">{player.name}</p><p className="truncate text-xs text-zinc-200">{player.club.name} · {player.position}</p><TierBadge tier={player.tier} /></div></div>
    <dl className="mt-4 grid grid-cols-6 gap-1">{detailMetrics.map(([id, short, label]) => <div key={id} className="min-w-0 rounded bg-black/20 p-1 text-center"><dt className="text-[9px] font-bold" aria-label={label}>{short}</dt><dd className={`text-xs font-black ${getScoreBand(player.stats[id]).dotClassName}`}>{player.stats[id]}{metricIsImputed(quality, id) && <span title="Imputed" aria-label="imputed" className="ml-0.5 text-amber-200">*</span>}</dd></div>)}</dl>
  </section>;
}

function SeasonScorePanel({ player, analysis, selected, history }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: ReturnType<typeof useHistory> }) {
  const rows = seasonScoreRows(player, analysis, selected, history.entries);
  const range = [selectedScore(player, analysis), ...history.entries.map((entry) => entry.player.score)];
  return <section className={panel} aria-labelledby="season-score-heading"><h2 id="season-score-heading" className="text-sm font-black">Season score</h2><div className="mt-2 flex items-center gap-2"><span className="text-3xl font-black tabular-nums">{selectedScore(player, analysis).toFixed(1)}</span><TierBadge tier={player.tier} /></div><p className="text-xs text-zinc-400">{contextLabel(selected)} · {selected.season}</p><p className="mt-3 text-xs text-zinc-400">Range: {Math.min(...range).toFixed(1)}–{Math.max(...range).toFixed(1)}{history.entries.length ? "" : " (selected context)"}</p><ol className="mt-3 space-y-1 text-xs">{history.loading ? Array.from({ length: 4 }, (_, index) => <li key={index} className="h-5 animate-pulse rounded bg-white/10" />) : rows.map((row, index) => <li key={`${row.context.season}-${row.context.mode}`} className="flex justify-between gap-2 border-t border-white/10 pt-1"><span>{index === 0 ? "Selected · " : ""}{row.context.season} · {row.context.mode === "league" ? "League" : "Europe"}</span><b>{row.player.score.toFixed(1)}</b></li>)}</ol>{history.failed > 0 && <p aria-live="polite" className="mt-2 text-xs text-amber-200">Partial history: {history.failed} context{history.failed === 1 ? "" : "s"} unavailable.</p>}</section>;
}

export function TacticalSummary({ player, analysis, quadrant, quality }: { player: Player; analysis?: PlayerAnalysis; quadrant?: TacticalQuadrant; quality: QualityDisplay }) { return <section className={panel} aria-labelledby="tactical-summary-heading"><h2 id="tactical-summary-heading" className="text-sm font-black">Tactical summary</h2><ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-300">{tacticalCopy(player, analysis, quadrant, quality).map((copy) => <li key={copy}>{copy}</li>)}</ul></section>; }

function shotMarker(point: PlayerAnalysis["spatial"]["shotmapPoints"][number], index: number) { const x = 3 + point.x * 1.35; const y = 3 + point.y * .94; if (point.outcome === "goal") return <path key={index} d={`M${x} ${y - 2}L${x + 2} ${y}L${x} ${y + 2}L${x - 2} ${y}Z`} className="fill-lime-300 stroke-white" />; if (point.outcome === "on_target") return <circle key={index} cx={x} cy={y} r="1.7" className="fill-cyan-300 stroke-zinc-950" />; if (point.outcome === "off_target") return <path key={index} d={`M${x - 1.6} ${y - 1.6}L${x + 1.6} ${y + 1.6}M${x + 1.6} ${y - 1.6}L${x - 1.6} ${y + 1.6}`} className="stroke-orange-300" strokeWidth=".8" />; return <rect key={index} x={x - 1.5} y={y - 1.5} width="3" height="3" className="fill-amber-300 stroke-zinc-300" />; }
export function SpatialPitch({ analysis }: { analysis?: PlayerAnalysis }) {
  const spatial = analysis?.spatial; const heatState = !spatial?.available ? "Activity heatmap unavailable" : spatial.heatmapPoints.length ? `${spatial.heatmapPoints.length} activity points` : "Verified zero activity points"; const shotState = !spatial?.shotmapSnapshotAvailable ? "Shot snapshot unavailable" : spatial.shotmapPoints.length ? `${spatial.shotmapPoints.length} shots` : "Verified zero shots";
  const counts = { goal: 0, on_target: 0, off_target: 0, blocked: 0 }; spatial?.shotmapPoints.forEach((shot) => counts[shot.outcome]++);
  return <section className={panel} aria-labelledby="spatial-pitch-heading"><h2 id="spatial-pitch-heading" className="text-sm font-black">Spatial pitch</h2><figure className="mt-3"><svg viewBox="0 0 141 100" className="w-full rounded bg-[#063525]" role="img" aria-label={`Horizontal pitch. ${heatState}. ${shotState}.`}><defs><filter id="heat-blur"><feGaussianBlur stdDeviation="3" /></filter></defs><rect x="3" y="3" width="135" height="94" fill="none" stroke="#b5d2bf" strokeWidth=".7"/><line x1="70.5" x2="70.5" y1="3" y2="97" stroke="#b5d2bf" strokeWidth=".7"/><circle cx="70.5" cy="50" r="10" fill="none" stroke="#b5d2bf" strokeWidth=".7"/><rect x="3" y="25" width="17" height="50" fill="none" stroke="#b5d2bf" strokeWidth=".7"/><rect x="121" y="25" width="17" height="50" fill="none" stroke="#b5d2bf" strokeWidth=".7"/>{spatial?.available && spatial.heatmapPoints.map((point, index) => <circle key={index} cx={3 + point.x * 1.35} cy={3 + point.y * .94} r="5" className="fill-cyan-300/25" filter="url(#heat-blur)"/>)}{spatial?.shotmapSnapshotAvailable && spatial.shotmapPoints.map(shotMarker)}</svg><figcaption className="mt-2 text-xs text-zinc-400">{heatState}. {shotState}. Goal ◇ · on target ● · off target × · blocked ■.</figcaption></figure><ul className="mt-2 flex flex-wrap gap-x-3 text-xs text-zinc-400"><li>Goals {counts.goal}</li><li>On target {counts.on_target}</li><li>Off target {counts.off_target}</li><li>Blocked {counts.blocked}</li></ul></section>;
}

export function PercentileProfile({ player, analysis, quality }: { player: Player; analysis?: PlayerAnalysis; quality: QualityDisplay }) { return <section className={panel} aria-labelledby="percentile-profile-heading"><h2 id="percentile-profile-heading" className="text-sm font-black">Percentile profile</h2><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{metricProfile(player, analysis, quality).map((metric) => <article key={metric.id} className="rounded border border-white/10 bg-black/20 p-3"><div className="flex justify-between gap-2"><h3 className="text-xs font-bold">{metric.label}</h3><b className={metric.band.dotClassName}>{metric.score}</b></div><p className="mt-2 text-[11px] text-zinc-400">{metric.volumeLabel}: {axisDetail(metric.volume)}</p><p className="text-[11px] text-zinc-400">{metric.ratioLabel}: {axisDetail(metric.ratio)}</p>{metric.imputed && <p className="mt-1 text-[10px] text-amber-200">Conservative substitute</p>}</article>)}</div></section>; }

export function VolumeBenchmarkRadar({ player, config, dataset }: { player: Player; config?: MessiApiConfig; dataset: DatasetRouteState }) { const benchmark = useVolumeBenchmark(config, player.id, dataset); return <ServerVolumeBenchmarkRadar state={benchmark.state} playerName={player.name} onRetry={benchmark.retry} />; }

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
  if (!detail) return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><a href={back}>← Back to leaderboard</a><h1 tabIndex={-1} ref={titleRef} className="mt-4 text-3xl font-black">Player profile</h1><div aria-busy="true" className="mt-4 grid gap-3 xl:grid-cols-3"><div className="h-64 animate-pulse rounded bg-white/10"/><div className="h-64 animate-pulse rounded bg-white/10"/><div className="h-64 animate-pulse rounded bg-white/10"/></div></main>;
  return <main id="main-content" className="mx-auto max-w-[1580px] overflow-x-hidden p-3 text-zinc-100 sm:p-6"><a href={back} className="inline-flex min-h-11 items-center text-lime-300 focus-visible:ring-2">← Back to leaderboard</a><h1 ref={titleRef} tabIndex={-1} className="text-3xl font-black outline-none">{detail.player.name}</h1><p className="mt-1 text-xs text-zinc-400">{contextLabel(dataset)} · {dataset.season}</p><div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-[300px_340px_minmax(0,1fr)]"><PlayerTierCard player={detail.player} analysis={detail.analysis} quality={quality}/><SeasonScorePanel player={detail.player} analysis={detail.analysis} selected={dataset} history={history}/><TacticalSummary player={detail.player} analysis={detail.analysis} quadrant={quadrant} quality={quality}/></div>{!detail.analysis && <p className="mt-4 rounded border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Server analysis is unavailable; no client-side analysis has been invented.</p>}<div className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[5fr_7fr]"><SpatialPitch analysis={detail.analysis}/><PercentileProfile player={detail.player} analysis={detail.analysis} quality={quality}/></div><div className="mt-4"><VolumeBenchmarkRadar player={detail.player} config={config} dataset={dataset}/></div>{afterPanels}</main>;
}
