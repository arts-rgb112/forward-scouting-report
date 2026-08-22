import { useEffect, useRef, useState, type ReactNode } from "react";

import { fetchPlayerDataQuality, DataQualityIdentityError } from "../api/dataQualityApi";
import { parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { MessiApiError } from "../api/errors";
import { fetchLeaderboardOptions, fetchPlayerDetail, fetchTacticalQuadrant } from "../api/leaderboardsApi";
import { fetchDuelPressDetailReadouts } from "../api/duelPressDetailReadoutApi";
import type { DuelPressDetailReadoutEnvelope } from "../api/duelPressDetailReadoutContracts";
import type { DuelPressModeContext } from "../api/duelPressTypes";
import { fetchHistoryLeaderboardOptions, fetchPlayerSummary, type PlayerHistoryEntry } from "../api/playerHistoryApi";
import { datasetHref } from "../dashboard/datasetRoute";
import { metricIsImputed, qualityDisplay, type QualityDisplay } from "../dashboard/dataQualityViewModel";
import { getScoreBand, resolveTierPresentation } from "../dashboard/scoutingConfig";
import { TierBadge } from "../dashboard/components/TierBadge";
import type { DatasetRouteState, Player, PlayerAnalysis, TacticalQuadrant } from "../dashboard/types";
import { axisDetail, detailMetrics, metricProfile, seasonScoreRows, selectedScore, tacticalCopy, wholeScore } from "./playerDetailViewModel";
import { SpatialPitch } from "./SpatialPitch";
import { BenchmarkPanel, VolumeBenchmarkRadar as ServerVolumeBenchmarkRadar } from "./VolumeBenchmarkRadar";
import { useRatioBenchmark } from "./useRatioBenchmark";
import { tacticalSummaryEnabled, useTacticalSummary } from "./useTacticalSummary";
import { useVolumeBenchmark } from "./useVolumeBenchmark";
import { DuelPressDetailReadoutBoard, DuelPressDetailReadoutUnavailable } from "./DuelPressDetailReadoutBoard";
import { FinalThirdShootingMap } from "./FinalThirdShootingMap";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const contextLabel = (context: DatasetRouteState) => context.mode === "league" ? `League · ${context.scope} leagues` : `Europe · ${context.competition.toUpperCase()}`;
const validId = (id: number) => Number.isSafeInteger(id) && id > 0;
const dossierGradient = (code: string) => ({ diamond: "from-violet-300/25 via-violet-950/25 to-[#101415]", emerald: "from-emerald-300/25 via-emerald-950/25 to-[#101415]", platinum: "from-cyan-300/25 via-cyan-950/25 to-[#101415]", gold: "from-amber-300/25 via-amber-950/25 to-[#101415]", silver: "from-slate-200/20 via-slate-800/30 to-[#101415]", bronze: "from-orange-300/25 via-orange-950/25 to-[#101415]" }[code] ?? "from-zinc-300/15 via-zinc-900/30 to-[#101415]");
export type PlayerHistoryState = { loading: boolean; entries: PlayerHistoryEntry[]; failed: number; requestedSeasons: number };
export const HISTORY_SUMMARY_TIMEOUT_MS = 10_000;

async function fetchBoundedPlayerSummary(config: MessiApiConfig, id: number, context: DatasetRouteState, parentSignal: AbortSignal): Promise<PlayerHistoryEntry> {
  if (parentSignal.aborted) throw parentSignal.reason ?? new DOMException("Player history request aborted", "AbortError");
  const child = new AbortController();
  const abortChild = () => child.abort(parentSignal.reason);
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const rejectFromChild = () => rejectAbort(child.signal.reason ?? new DOMException("Player history request aborted", "AbortError"));
  child.signal.addEventListener("abort", rejectFromChild, { once: true });
  if (parentSignal.aborted) abortChild(); else parentSignal.addEventListener("abort", abortChild, { once: true });
  const timeout = window.setTimeout(() => child.abort(new DOMException("Player history request timed out", "TimeoutError")), HISTORY_SUMMARY_TIMEOUT_MS);
  try {
    return await Promise.race([fetchPlayerSummary(config, id, context, child.signal), aborted]);
  } finally {
    window.clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortChild);
    child.signal.removeEventListener("abort", rejectFromChild);
  }
}

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
      if (!contexts.length) { if (!controller.signal.aborted) setState({ loading: false, entries: [], failed: 0, requestedSeasons: 0 }); return; }
      const entries: PlayerHistoryEntry[] = []; let failed = 0;
      for (let start = 0; start < contexts.length; start += 4) {
        const batch = await Promise.allSettled(contexts.slice(start, start + 4).map((context) => fetchBoundedPlayerSummary(config, id, context, controller.signal)));
        if (controller.signal.aborted) return;
        entries.push(...batch.filter((result): result is PromiseFulfilledResult<PlayerHistoryEntry> => result.status === "fulfilled").map((result) => result.value));
        failed += batch.filter((result) => result.status === "rejected").length;
        setState({ loading: false, entries: [...entries], failed, requestedSeasons: seasons.length });
      }
    }).catch(() => { if (!controller.signal.aborted) setState({ loading: false, entries: [], failed: 1, requestedSeasons: 0 }); });
    return () => controller.abort();
  }, [config, enabled, id, selected.season]);
  return state;
}

export function PlayerTierCard({ player, analysis, quality, detailReadouts, renewedDetailRequested = false }: { player: Player; analysis?: PlayerAnalysis; quality: QualityDisplay; detailReadouts?: DuelPressDetailReadoutEnvelope; renewedDetailRequested?: boolean }) {
  const tier = resolveTierPresentation(player.tier); const score = wholeScore(player, analysis);
  return <section className={`${panel} dossier-card relative isolate overflow-hidden bg-gradient-to-br ${dossierGradient(player.tier.code)} ${tier.className}`} aria-labelledby="player-tier-heading">
    <svg aria-hidden="true" viewBox="0 0 100 150" className="pointer-events-none absolute right-0 -top-4 h-52 w-40 opacity-35 sm:-right-8"><path d="M50 4 91 28v55l-41 59L9 83V28Z" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="m50 18 28 16v43L50 119 22 77V34Z" fill="none" stroke="currentColor" strokeWidth=".7"/><circle cx="50" cy="74" r="31" fill="none" stroke="currentColor" strokeWidth=".7"/></svg>
    <h2 id="player-tier-heading" className="sr-only">Player dossier</h2><div className="relative flex items-start justify-between gap-3"><div><p className="text-[10px] font-black tracking-[0.24em] text-zinc-300">M.E.S.S.I. DOSSIER</p><p className="mt-2 text-6xl font-black leading-none tabular-nums">{score}</p><p className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-300">Selected score · floored</p></div><TierBadge tier={player.tier} /></div>
    <div className="relative mt-5 flex items-center gap-3"><div className="h-20 w-16 shrink-0 overflow-hidden rounded border border-white/25 bg-black/30 shadow-inner">{player.face ? <img src={player.face} alt={`${player.name} portrait`} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-2xl" aria-hidden="true">{player.name[0]}</span>}</div><div className="min-w-0"><p className="truncate text-xl font-black text-white">{player.name}</p><p className="truncate text-xs text-zinc-200">{player.club.name} · {player.position}</p><p className="mt-1 text-xs text-zinc-300">{player.age === null ? "Age unavailable" : `Age ${player.age}`} · {player.minutes} min</p>{player.nation?.icon && <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-200"><img src={player.nation.icon} alt="" className="h-3.5 w-5 object-contain"/>{player.nation.name}</p>}</div></div>
    {!renewedDetailRequested && <dl className="relative mt-5 grid grid-cols-6 gap-1 border-t border-white/15 pt-3">{detailReadouts ? detailReadouts.categories.map((category, index) => <div key={category.id} className="min-w-0 rounded border border-white/10 bg-black/25 p-1.5 text-center"><dt className="text-[9px] font-black tracking-wide" aria-label={category.id}>{String(index + 1).padStart(2, "0")}</dt><dd className={`mt-0.5 text-xs font-black ${category.score === null ? "text-zinc-500" : getScoreBand(category.score).dotClassName}`}>{category.score ?? "—"}</dd></div>) : detailMetrics.map(([id, short, label]) => <div key={id} className="min-w-0 rounded border border-white/10 bg-black/25 p-1.5 text-center"><dt className="text-[9px] font-black tracking-wide" aria-label={label}>{short}</dt><dd className={`mt-0.5 text-xs font-black ${getScoreBand(player.stats[id]).dotClassName}`}>{player.stats[id]}{metricIsImputed(quality, id) && <span title="Imputed server value" aria-label="imputed" className="ml-0.5 text-amber-200">*</span>}</dd></div>)}</dl>}
  </section>;
}

export function SeasonScorePanel({ player, analysis, selected, history }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerHistoryState }) {
  const rows = seasonScoreRows(player, analysis, selected, history.entries);
  const range = [selectedScore(player, analysis), ...history.entries.map((entry) => entry.player.score)];
  return <section className={`${panel} season-rail border-l-2 border-l-white/30`} aria-labelledby="season-score-heading"><h2 id="season-score-heading" className="text-sm font-black">Season score rail</h2><div className="mt-2 flex items-center gap-2"><span className="text-4xl font-black tabular-nums">{wholeScore(player, analysis)}</span><TierBadge tier={player.tier} /></div><p className="text-xs text-zinc-400">{contextLabel(selected)} · {selected.season}</p><p className="mt-4 border-y border-white/10 py-2 text-[11px] text-zinc-300">Retrieved-score range: {Math.min(...range).toFixed(1)}–{Math.max(...range).toFixed(1)}{history.entries.length ? "" : " (selected context only)"}</p><ol className="mt-3 space-y-1.5 text-xs">{history.loading ? Array.from({ length: 4 }, (_, index) => <li key={index} className="h-8 animate-pulse rounded bg-white/10 motion-reduce:animate-none" />) : rows.map((row, index) => <li key={`${row.context.season}-${row.context.mode}`} className="flex items-center justify-between gap-2 border-l-2 border-white/15 bg-black/20 px-2 py-1.5"><span className="min-w-0"><b className="block truncate">{index === 0 ? "Selected · " : ""}{row.context.season}</b><span className="text-[10px] text-zinc-400">{row.context.mode === "league" ? `League · ${row.context.scope}` : `Europe · ${row.context.competition.toUpperCase()}`}</span></span><b className="shrink-0 tabular-nums">{index === 0 ? wholeScore(player, analysis) : row.player.score.toFixed(1)}</b></li>)}</ol>{!history.loading && history.requestedSeasons > 0 && <p className="mt-3 text-[11px] text-zinc-400">One best server context per season; top {Math.min(4, Math.max(0, rows.length - 1))} of {history.requestedSeasons} historical seasons.</p>}{history.failed > 0 && <p aria-live="polite" className="mt-2 text-xs text-amber-200">Partial history: {history.failed} context{history.failed === 1 ? "" : "s"} unavailable; range reflects retrieved scores only.</p>}</section>;
}

export function TacticalSummary({ player, analysis, quadrant, quality, config, dataset }: { player: Player; analysis?: PlayerAnalysis; quadrant?: TacticalQuadrant; quality: QualityDisplay; config?: MessiApiConfig; dataset?: DatasetRouteState }) {
  const tactical = useTacticalSummary(config, player.id, dataset ?? { season: "2025/2026", mode: "league", scope: 8, competition: "all" });
  const enabled = tacticalSummaryEnabled();
  return <section className={panel} aria-labelledby="tactical-summary-heading"><h2 id="tactical-summary-heading" className="text-sm font-black">Tactical summary</h2>
    {!enabled && <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-300">{tacticalCopy(player, analysis, quadrant, quality).map((copy) => <li key={copy}>{copy}</li>)}</ul>}
    {enabled && tactical.state.kind === "loading" && <p aria-busy="true" className="mt-3 text-sm text-zinc-400">Loading authoritative tactical summary.</p>}
    {enabled && tactical.state.kind === "error" && <p role="alert" className="mt-3 text-sm text-amber-100">Tactical summary could not be loaded.<button type="button" onClick={tactical.retry} className="ml-2 min-h-11 rounded border px-3 focus-visible:ring-2 focus-visible:ring-lime-300">Retry</button></p>}
    {enabled && (tactical.state.kind === "unavailable" || tactical.state.kind === "disabled") && <p className="mt-3 text-sm text-zinc-400">Authoritative tactical summary is unavailable for this context.</p>}
    {enabled && tactical.state.kind === "ready" && <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-zinc-300">{tactical.state.data.lines.map((line) => <li key={line.id}>{line.text}{line.imputed && <span className="ml-1 text-amber-200" aria-label="source-imputed">(source-imputed)</span>}</li>)}</ul>}
  </section>;
}

export { SpatialPitch } from "./SpatialPitch";

export function PercentileProfile({ player, analysis, quality, layout = "page" }: { player: Player; analysis?: PlayerAnalysis; quality: QualityDisplay; layout?: "page" | "rail" }) {
  const profileGridClass = layout === "rail" ? "mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2" : "mt-3 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3";
  return <section className={`${panel} six-sector-board`} aria-label="Percentile profile"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-black">Six-sector board</h2><p className="text-[10px] uppercase tracking-[0.16em] text-zinc-400">Server score + volume / ratio readouts</p></div><div data-layout="legacy-percentile-grid" className={profileGridClass}>{metricProfile(player, analysis, quality).map((metric) => {
    const unavailable = !metric.volume && !metric.ratio;
    return <article key={metric.id} className="min-w-0 rounded border border-white/10 bg-black/20 p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="text-[10px] font-black tracking-[0.16em] text-zinc-400">{metric.short}</p><h3 className="truncate text-xs font-bold">{metric.label}</h3></div><b className={`shrink-0 text-lg tabular-nums ${metric.band.dotClassName}`}>{metric.score}</b></div><div role="progressbar" aria-label={`${metric.label} server score`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={metric.score} className="mt-3 h-1.5 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${metric.band.dotClassName}`} style={{ width: `${metric.score}%` }} /></div><dl className="mt-3 space-y-1 text-[11px] leading-4 text-zinc-400"><div><dt className="sr-only">Volume readout</dt><dd><span className="font-semibold text-zinc-300">{metric.volumeLabel}:</span> {axisDetail(metric.volume)}</dd></div><div><dt className="sr-only">Ratio readout</dt><dd><span className="font-semibold text-zinc-300">{metric.ratioLabel}:</span> {axisDetail(metric.ratio)}</dd></div><div><dt className="sr-only">Raw server values</dt><dd>Raw: volume {metric.volume?.rawValue ?? "unavailable"} · ratio {metric.ratio?.rawValue ?? "unavailable"}</dd></div></dl><p className={`mt-2 text-[10px] ${metric.imputed ? "text-amber-200" : "text-zinc-500"}`}>{metric.imputed ? <>Imputed server readout — <span>Conservative substitute</span></> : unavailable ? "Server readouts unavailable" : "Server readouts supplied"}</p></article>;
  })}</div></section>;
}

export function VolumeBenchmarkRadar({ player, config, dataset }: { player: Player; config?: MessiApiConfig; dataset: DatasetRouteState }) { const benchmark = useVolumeBenchmark(config, player.id, dataset); return <ServerVolumeBenchmarkRadar state={benchmark.state} playerName={player.name} onRetry={benchmark.retry} />; }

export function Benchmark({ player, config, dataset }: { player: Player; config?: MessiApiConfig; dataset: DatasetRouteState }) {
  const volume = useVolumeBenchmark(config, player.id, dataset); const ratio = useRatioBenchmark(config, player.id, dataset);
  return <BenchmarkPanel volume={volume.state} ratio={ratio.state} playerName={player.name} onVolumeRetry={volume.retry} onRatioRetry={ratio.retry}/>;
}

/** Presentation-only composition: all score, spatial and radar values remain server supplied. */
export function PlayerDetailDossierLayout({ player, analysis, quadrant, quality, history, config, dataset, afterPanels, detailReadoutBoard, detailReadouts, renewedDetailRequested = false }: { player: Player; analysis?: PlayerAnalysis; quadrant?: TacticalQuadrant; quality: QualityDisplay; history: PlayerHistoryState; config?: MessiApiConfig; dataset: DatasetRouteState; afterPanels?: ReactNode; detailReadoutBoard?: ReactNode; detailReadouts?: DuelPressDetailReadoutEnvelope; renewedDetailRequested?: boolean }) {
  const spatialContextIdentity = `${player.id}|${dataset.season}|${dataset.mode}|${dataset.scope}|${dataset.competition}`;
  const readoutSlot = detailReadoutBoard ?? <PercentileProfile player={player} analysis={analysis} quality={quality} layout="rail"/>;
  return <>
    <div data-layout="dossier-season-analysis">
    <div data-layout="detail-dossier-layout" className="mt-4 grid min-w-0 gap-4 xl:grid-cols-[minmax(528px,596px)_minmax(0,1fr)] xl:items-start">
      <div data-layout="detail-left-rail" className="min-w-0">
        <div data-layout="dossier-season" className="grid min-w-0 items-start gap-4 md:grid-cols-[minmax(0,300px)_minmax(240px,280px)]">
          <PlayerTierCard player={player} analysis={analysis} quality={quality} detailReadouts={detailReadouts} renewedDetailRequested={renewedDetailRequested}/>
          <SeasonScorePanel player={player} analysis={analysis} selected={dataset} history={history}/>
        </div>
        <div data-layout="detail-board-slot" className="mt-4 min-w-0">{readoutSlot}</div>
      </div>
      <section data-layout="tactical-spatial-workspace" className="min-w-0 rounded-xl border border-white/10 bg-[#0d1112] p-2 shadow-sm" aria-label="Tactical and spatial analysis">
        <TacticalSummary player={player} analysis={analysis} quadrant={quadrant} quality={quality} config={config} dataset={dataset}/>
        <div className="mt-2 min-w-0"><SpatialPitch analysis={analysis} contextIdentity={spatialContextIdentity}/></div>
        <FinalThirdShootingMap config={config} playerId={player.id} dataset={dataset}/>
      </section>
    </div>
    </div>
    {!analysis && <p className="mt-4 rounded border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">Server analysis is unavailable; no client-side analysis has been invented.</p>}
    <div data-layout="sectors-radar"><div data-layout="radar-benchmarks" className="mt-4 min-w-0"><Benchmark player={player} config={config} dataset={dataset}/></div></div>
    {afterPanels}
  </>;
}

export function PlayerDetailRoute({ id, dataset, config: providedConfig, afterPanels, duelPressDetailRequested = false }: { id: number; dataset: DatasetRouteState; config?: MessiApiConfig; afterPanels?: ReactNode; duelPressDetailRequested?: boolean }) {
  let parsedConfig = providedConfig; if (!parsedConfig) try { parsedConfig = parseMessiApiConfig(import.meta.env, import.meta.env.MODE); } catch { /* surfaced below */ }
  const config = parsedConfig; const scope8 = useScope8(config, dataset); const [detail, setDetail] = useState<{ player: Player; analysis?: PlayerAnalysis }>(); const [quadrant, setQuadrant] = useState<TacticalQuadrant>(); const [quality, setQuality] = useState<QualityDisplay>({ kind: "idle" }); const [error, setError] = useState<"config" | "network" | "not-found">(); const [retry, setRetry] = useState(0); const [readoutRetry, setReadoutRetry] = useState(0); const [readouts, setReadouts] = useState<DuelPressDetailReadoutEnvelope>(); const [readoutError, setReadoutError] = useState<string>(); const readoutGeneration = useRef(0); const titleRef = useRef<HTMLHeadingElement>(null);
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
  useEffect(() => {
    if (!duelPressDetailRequested) { setReadouts(undefined); setReadoutError(undefined); return; }
    if (!config || !validId(id)) { setReadouts(undefined); setReadoutError("상세 스탯 API 설정 또는 선수 식별자가 올바르지 않습니다."); return; }
    const context: DuelPressModeContext = dataset.mode === "league" ? { season: dataset.season, mode: "league", scope: dataset.scope, competition: "all" } : { season: dataset.season, mode: "europe", scope: null, competition: dataset.competition };
    const controller = new AbortController(); const generation = ++readoutGeneration.current; const live = () => generation === readoutGeneration.current && !controller.signal.aborted;
    setReadouts(undefined); setReadoutError(undefined);
    void fetchDuelPressDetailReadouts(config, id, context, controller.signal).then((value) => { if (live()) setReadouts(value); }).catch((cause: unknown) => { if (live()) setReadoutError(cause instanceof Error ? cause.message : "상세 스탯을 불러올 수 없습니다."); });
    return () => controller.abort();
  }, [config, dataset.competition, dataset.mode, dataset.scope, dataset.season, duelPressDetailRequested, id, readoutRetry]);
  useEffect(() => { if (detail) titleRef.current?.focus(); }, [detail]);
  const detailBoard = duelPressDetailRequested ? readouts ? <DuelPressDetailReadoutBoard data={readouts} layout="rail"/> : <DuelPressDetailReadoutUnavailable loading={!readoutError} message={readoutError} onRetry={() => setReadoutRetry((value) => value + 1)}/> : undefined;
  const back = datasetHref("/", dataset); if (scope8 === "unsupported") return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><h1 tabIndex={-1}>8-league dataset unavailable</h1><p role="alert">8개 리그 데이터 is unavailable for this context.</p><a href={back}>Back to leaderboard</a></main>;
  if (error) return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><h1 tabIndex={-1} ref={titleRef}>{error === "not-found" ? "Player not found" : "Player details unavailable"}</h1><p role="alert">{error === "config" ? "Dashboard API configuration is unavailable." : "This player could not be loaded in the selected context."}</p>{error !== "not-found" && <button className="mt-4 min-h-11 rounded border px-4" onClick={() => setRetry((value) => value + 1)}>Retry</button>}<p><a href={back}>Back to leaderboard</a></p></main>;
  if (!detail) return <main id="main-content" className="mx-auto max-w-[1580px] p-4 text-zinc-100"><a href={back}>← Back to leaderboard</a><h1 tabIndex={-1} ref={titleRef} className="mt-4 text-3xl font-black">Player profile</h1><div aria-busy="true" className="mt-4 grid min-w-0 gap-3 md:grid-cols-2 lg:grid-cols-[minmax(272px,300px)_minmax(240px,280px)_minmax(0,1fr)]"><div className="h-72 animate-pulse rounded bg-white/10 motion-reduce:animate-none"/><div className="h-72 animate-pulse rounded bg-white/10 motion-reduce:animate-none"/><div className="h-72 animate-pulse rounded bg-white/10 motion-reduce:animate-none"/></div></main>;
  return <main id="main-content" className="mx-auto max-w-[1580px] overflow-x-hidden p-3 text-zinc-100 sm:p-6"><a href={back} className="inline-flex min-h-11 items-center text-lime-300 focus-visible:ring-2">← Back to leaderboard</a><h1 ref={titleRef} tabIndex={-1} className="text-3xl font-black outline-none">{detail.player.name}</h1><p className="mt-1 text-xs text-zinc-400">{contextLabel(dataset)} · {dataset.season}</p><PlayerDetailDossierLayout player={detail.player} analysis={detail.analysis} quadrant={quadrant} quality={quality} history={history} config={config} dataset={dataset} afterPanels={afterPanels} detailReadoutBoard={detailBoard} detailReadouts={readouts} renewedDetailRequested={duelPressDetailRequested}/></main>;
}
