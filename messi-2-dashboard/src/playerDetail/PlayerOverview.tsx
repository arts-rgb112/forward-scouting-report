import { useId } from "react";
import type { DuelPressV2Category, DuelPressV2DetailMetrics } from "../api/duelPressV2Contracts";
import type { PlayerHistoryEntry } from "../api/playerHistoryApi";
import { dashboardQueryKeys, datasetHref, preserveExternalQuery } from "../dashboard/datasetRoute";
import { duelPressAxisLabels } from "../dashboard/duelPressAxisLabels";
import { resolveTierPresentation } from "../dashboard/scoutingConfig";
import type { DatasetRouteState, Player, PlayerAnalysis } from "../dashboard/types";
import { MAX_HISTORICAL_SEASON_ROWS, seasonScoreRows, wholeScore } from "./playerDetailViewModel";

export type PlayerOverviewHistory = {
  loading: boolean;
  entries: PlayerHistoryEntry[];
  failed: number;
  requestedSeasons: number;
};

type OverviewReadoutState = "loading" | "error" | "unavailable" | "ready";

const categoryColors = ["#ab8ffa", "#b5f052", "#45d6ed", "#f5b247", "#72c8ff", "#fa6e7a"] as const;

function tierColor(player: Player) {
  const presentation = resolveTierPresentation(player.tier);
  if (presentation.taxonomy !== "crystal-v2") return "#949f9f";
  return ({ diamond: "#ab8ffa", emerald: "#b5f052", platinum: "#45d6ed", gold: "#f5b247", silver: "#949f9f", bronze: "#fa6e7a" } as Record<string, string>)[player.tier.code] ?? "#949f9f";
}

function compactNumber(value: unknown, fractionDigits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("ko-KR", { maximumFractionDigits: fractionDigits })
    : "—";
}

function minuteDisplay(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return { text: "—", full: "—" };
  const rounded = Math.round(value);
  const full = `${rounded.toLocaleString("ko-KR")}분`;
  // Four compact mobile cells cannot reliably show a four-digit minute total
  // at a readable size. This formats the recorded server value only; the
  // exact value remains available to assistive technology and on hover.
  return { text: rounded >= 1000 ? `${(rounded / 1000).toFixed(1).replace(/\.0$/, "")}k분` : full, full };
}

function contextText(context: DatasetRouteState | PlayerHistoryEntry["context"]) {
  return context.mode === "league"
    ? `리그 · ${context.scope}개 리그`
    : `유럽대항전 · ${context.competition === "all" ? "전체" : context.competition.toUpperCase()}`;
}

type SeasonOverviewRow = ReturnType<typeof seasonScoreRows>[number];

function seasonHref(playerId: number, context: DatasetRouteState) {
  const url = datasetHref(`/players/${playerId}`, context);
  if (typeof window === "undefined") return url;
  const preserved = preserveExternalQuery(url, window.location.search, dashboardQueryKeys);
  const taxonomy = new URLSearchParams(window.location.search).get("taxonomy");
  // Taxonomy owns the detail readout request, independently of season/scope.
  // Keep only recognized versions; never activate a missing or invalid one.
  if (taxonomy !== "duel-press-v1" && taxonomy !== "duel-press-v2") return preserved;
  return `${preserved}${preserved.includes("?") ? "&" : "?"}taxonomy=${taxonomy}`;
}

function OverviewSeasonRow({ row, player, analysis }: { row: SeasonOverviewRow; player: Player; analysis?: PlayerAnalysis }) {
  const color = tierColor(row.player);
  const score = row.selected ? wholeScore(player, analysis) : row.score.toFixed(1);
  const content = <><div className="min-w-0"><div className="flex min-w-0 items-center gap-1.5"><b data-season-label className="whitespace-nowrap type-label text-zinc-100">{row.context.season}</b>{row.selected && <><span className="whitespace-nowrap rounded border border-white/20 px-1.5 py-0.5 type-caption text-zinc-300 xl:hidden">현재</span><span aria-label="현재 선택" className="hidden size-1.5 shrink-0 rounded-full bg-lime-300 xl:block" /></>}</div><div className="mt-1 flex min-w-0 items-center gap-2"><p className="min-w-0 truncate type-caption text-zinc-500">{contextText(row.context)}</p><span className="hidden h-px min-w-5 flex-1 overflow-hidden bg-white/10 xl:block" aria-hidden="true"><span className="block h-full" style={{ backgroundColor: color, width: `${Math.min(100, Math.max(0, row.score / 99 * 100))}%` }} /></span></div></div><b className="shrink-0 self-start pt-0.5 type-label tabular-nums text-zinc-100">{score}</b></>;
  const rowClass = `grid min-h-14 min-w-40 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 xl:min-w-0 xl:rounded-none xl:border-y-0 xl:border-r-0 xl:border-l-2 xl:px-3 ${row.selected ? "border-l-white/70 bg-white/[.07]" : "border-l-white/10 bg-transparent hover:border-l-white/40 hover:bg-white/[.035]"}`;
  return <li data-season={row.context.season} data-selected={row.selected ? "true" : "false"}>{row.selected ? <div className={rowClass}>{content}</div> : <a className={rowClass} href={seasonHref(player.id, row.context)} aria-label={`${row.context.season} ${contextText(row.context)} 선수 상세로 이동`}>{content}</a>}</li>;
}

export function OverviewSeasonRail({ player, analysis, selected, history, ariaLabel = "시즌 · 대회" }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerOverviewHistory; ariaLabel?: string }) {
  const headingId = `overview-season-heading-${useId().replace(/:/g, "")}`;
  const candidates = seasonScoreRows(player, analysis, selected, history.entries);
  const selectedRow = candidates.find((row) => row.selected) ?? candidates[0];
  const historicalRows = candidates.filter((row) => !row.selected)
    .sort((left, right) => right.context.season.localeCompare(left.context.season))
    .slice(0, MAX_HISTORICAL_SEASON_ROWS);
  const rows = selectedRow ? [selectedRow, ...historicalRows] : historicalRows;
  return <section aria-label={ariaLabel} className="min-w-0">
    <h2 id={headingId} className="type-caption font-black tracking-[.16em] text-zinc-500">시즌 스파인</h2>
    <ol className="mt-2 flex gap-2 overflow-x-auto pb-1 xl:grid xl:gap-1 xl:overflow-visible" aria-label="시즌별 M.E.S.S.I. 이력">
      {history.loading ? <>{selectedRow && <OverviewSeasonRow row={selectedRow} player={player} analysis={analysis}/>} {Array.from({ length: MAX_HISTORICAL_SEASON_ROWS }, (_, index) => <li key={index} aria-hidden="true" className="h-14 min-w-40 animate-pulse rounded-lg bg-white/[.05] motion-reduce:animate-none xl:min-w-0" />)}</> : rows.map((row) => <OverviewSeasonRow key={`${row.context.season}-${row.context.mode}`} row={row} player={player} analysis={analysis}/>) }
    </ol>
    {history.failed > 0 && <p role="status" className="mt-2 type-caption text-amber-200">시즌 이력 일부를 불러오지 못했습니다. 표시된 기록만 반영합니다.</p>}
  </section>;
}

function pointFor(index: number, value: number, total: number) {
  const angle = -Math.PI / 2 + index * (Math.PI * 2 / total);
  const radius = 49 * value / 100;
  return `${(60 + Math.cos(angle) * radius).toFixed(2)},${(60 + Math.sin(angle) * radius).toFixed(2)}`;
}

export function OverviewCategoryVector({ categories, state }: { categories?: DuelPressV2Category[]; state: OverviewReadoutState }) {
  const headingId = `overview-radar-heading-${useId().replace(/:/g, "")}`;
  const usable = state === "ready" && categories?.every((category) => category.scoreState !== "unavailable") ? categories : undefined;
  const ring = (ratio: number) => Array.from({ length: 6 }, (_, index) => pointFor(index, ratio * 100, 6)).join(" ");
  const polygon = usable?.map((category, index) => pointFor(index, category.percentileScore, usable.length)).join(" ");
  return <section data-layout="overview-radar-card" aria-labelledby={headingId} className="flex min-w-0 flex-col p-4 sm:p-5">
    <div className="flex items-baseline justify-between gap-2"><h2 id={headingId} className="type-caption font-black tracking-[.16em] text-zinc-500">M.E.S.S.I. 벡터</h2><span className="type-caption tabular-nums text-zinc-600">06</span></div>
    <div className="relative mx-auto mt-1 aspect-square w-full max-w-[236px]" role="img" aria-label={usable ? "서버 제공 M.E.S.S.I. 6개 카테고리 레이더" : "M.E.S.S.I. 카테고리 레이더 데이터 없음"}>
      <svg viewBox="0 0 120 120" className="h-full w-full overflow-visible" aria-hidden="true">
        {[.25, .5, .75, 1].map((ratio) => <polygon key={ratio} points={ring(ratio)} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth=".7" />)}
        {Array.from({ length: 6 }, (_, index) => <line key={index} x1="60" y1="60" x2={pointFor(index, 100, 6).split(",")[0]} y2={pointFor(index, 100, 6).split(",")[1]} stroke="rgba(255,255,255,.12)" strokeWidth=".7" />)}
        {polygon && <polygon points={polygon} fill="rgba(171,143,250,.25)" stroke="#b5f052" strokeWidth="1.6" />}
        {usable?.map((category, index) => { const [cx, cy] = pointFor(index, category.percentileScore, usable.length).split(","); return <circle key={category.id} cx={cx} cy={cy} r="1.8" fill={categoryColors[index]} />; })}
      </svg>
    </div>
    {state === "ready" && <ul data-layout="overview-category-vector" className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-white/10 pt-3">{categories?.map((category, index) => {
      const unavailable = category.scoreState === "unavailable";
      const value = unavailable ? null : category.percentileScore;
      return <li key={category.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2"><span className="flex min-w-0 items-center gap-1.5"><span className={`size-1.5 shrink-0 rounded-full ${category.scoreState === "imputed" ? "opacity-60" : ""}`} style={{ backgroundColor: categoryColors[index] }} /><span className="truncate type-caption text-zinc-400">{duelPressAxisLabels[category.id]}</span>{category.scoreState === "imputed" && <span className="rounded bg-amber-200/10 px-1 py-0.5 type-caption text-amber-100">보정</span>}</span><b className="type-label tabular-nums text-zinc-100">{value === null ? "—" : value.toFixed(0)}</b></li>;
    })}</ul>}
    {state !== "ready" && <p role={state === "error" ? "alert" : "status"} className={`mt-3 rounded-lg border border-white/10 bg-black/10 p-3 text-center type-caption ${state === "error" ? "text-amber-200" : "text-zinc-500"}`}>{state === "loading" ? "정본 카테고리 점수를 불러오는 중입니다." : state === "error" ? "정본 카테고리 점수 요청에 실패했습니다." : "선택된 데이터 버전에서는 카테고리 정본 점수를 제공하지 않습니다."}</p>}
    {state === "ready" && categories?.some((category) => category.scoreState === "imputed") && <p className="mt-2 type-caption text-amber-200">일부 카테고리에 서버 대체 구성요소가 포함되어 있습니다.</p>}
    <details className="mt-3 border-t border-white/10 pt-2"><summary className="cursor-pointer type-caption text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300">점수 표시 기준</summary><p className="mt-2 type-caption leading-5 text-zinc-500">레이더와 목록은 같은 정본 6개 카테고리 점수만 표시합니다. 데이터가 없거나 보정된 경우 서버 상태를 그대로 드러냅니다.</p></details>
  </section>;
}

export function PlayerIdentity({ player, analysis, selected }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState }) {
  const raw = analysis?.rawMetrics ?? {};
  const score = wholeScore(player, analysis);
  const color = tierColor(player);
  const tier = resolveTierPresentation(player.tier);
  const minutes = minuteDisplay(raw.minutesPlayed);
  const primaryStats = [
    { label: "득점", text: compactNumber(raw.goals, 0), full: undefined },
    { label: "xG", text: compactNumber(raw.xg), full: undefined },
    { label: "xGOT", text: compactNumber(raw.xgot), full: undefined },
    { label: "출전 시간", text: minutes.text, full: minutes.full },
  ];
  const positionRank = analysis?.score.rank ?? null;
  const positionPopulation = analysis?.score.population && analysis.score.population > 0 ? analysis.score.population : null;
  return <section aria-labelledby="overview-profile-heading" className="relative isolate min-w-0 overflow-hidden px-4 py-5 sm:px-6 xl:col-start-2 xl:row-start-1 xl:py-7">
    <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-20 size-80 rounded-full border border-white/[.07]" /><div aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 h-1 w-2/5" style={{ backgroundColor: color }} />
    <div className="relative min-w-0">
      <h2 id="overview-profile-heading" className="max-w-full break-words text-[clamp(2rem,7vw,3.25rem)] font-black leading-[.95] tracking-[-.055em] text-white">{player.name}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 type-body text-zinc-300"><span>{player.club.name}</span><span aria-hidden="true" className="text-zinc-600">/</span><span>{player.position}</span><span aria-hidden="true" className="text-zinc-600">/</span><span className="text-zinc-500">{selected.season}</span></div>
    </div>
    <div className="relative mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-4 xl:grid-cols-[10.5rem_minmax(0,1fr)_auto] xl:items-center xl:gap-6">
      <div className="row-span-2 hidden h-48 w-[10.5rem] overflow-hidden rounded-[1.3rem] bg-[#232628] ring-1 ring-white/10 xl:block">{player.face ? <img src={player.face} alt={`${player.name} 선수 사진`} className="h-full w-full object-cover object-top" /> : <span className="grid h-full place-items-center text-5xl font-black text-zinc-600" aria-hidden="true">{player.name[0]}</span>}</div>
      <div className="min-w-0 xl:col-start-2"><p className="type-caption font-bold tracking-[.13em] text-zinc-500">{contextText(selected)}</p><p className="mt-2 flex items-center gap-1.5 type-caption text-zinc-300">{player.nation?.icon && <img src={player.nation.icon} alt="" className="h-3.5 w-5 object-contain" />}{player.nation ? `${player.nation.name} · ` : ""}{player.age === null ? "현재 프로필 나이 정보 없음" : `현재 프로필 기준 · ${player.age}세`}</p></div>
      <div className="row-span-2 text-right xl:col-start-3"><b className="block text-5xl font-black leading-none tabular-nums sm:text-6xl" style={{ color }}>{score}</b><span className="mt-2 inline-flex rounded-full border px-2.5 py-1 type-caption font-bold" style={{ color, borderColor: color }}>{tier.glyph} {tier.label} · {player.tier.level}</span></div>
      <div className="flex min-w-0 items-center gap-3 xl:col-start-2"><div className="grid size-[4.75rem] shrink-0 overflow-hidden rounded-2xl bg-[#232628] ring-1 ring-white/10 xl:hidden">{player.face ? <img src={player.face} alt={`${player.name} 선수 사진`} className="h-full w-full object-cover object-top" /> : <span className="grid h-full place-items-center text-2xl font-black text-zinc-600" aria-hidden="true">{player.name[0]}</span>}</div><div className="min-w-0 type-caption text-zinc-400"><p>대회 전체 <b className="text-zinc-100">{player.rank}위</b></p><p className="mt-1">동포지션 <b className="text-zinc-100">{positionRank === null ? "—" : `${positionRank}위`}</b> / {positionPopulation === null ? "—" : `${positionPopulation}명`}</p></div></div>
    </div>
    <dl className="relative mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/10 pt-4 min-[360px]:grid-cols-4">{primaryStats.map(({ label, text, full }) => <div key={label} className="min-w-0"><dt className="type-caption tracking-[.08em] text-zinc-500">{label}</dt><dd aria-label={full} title={full ?? text} className="mt-1 truncate text-xl font-black tabular-nums text-zinc-100">{text}</dd></div>)}</dl>
  </section>;
}

/** Compact re-use of the dossier's authoritative score/tier presentation for
 * the arena HUD. It deliberately owns no fetch or derived analytics. */
export function ArenaProfileHud({ player, analysis, selected }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState }) {
  const color = tierColor(player);
  const tier = resolveTierPresentation(player.tier);
  const raw = analysis?.rawMetrics ?? {};
  const minutes = minuteDisplay(raw.minutesPlayed);
  const primaryStats = [
    { label: "득점", text: compactNumber(raw.goals, 0), full: undefined },
    { label: "xG", text: compactNumber(raw.xg), full: undefined },
    { label: "xGOT", text: compactNumber(raw.xgot), full: undefined },
    { label: "출전", text: minutes.text, full: minutes.full },
  ];
  const positionRank = analysis?.score.rank ?? null;
  const positionPopulation = analysis?.score.population && analysis.score.population > 0 ? analysis.score.population : null;
  const profileContext = () => <p data-arena-profile-context className="type-caption text-zinc-400">{player.age === null ? "현재 프로필 나이 정보 없음" : `현재 프로필 ${player.age}세`} · 대회 전체 {player.rank}위 · 동포지션 {positionRank === null ? "—" : `${positionRank}위`}{positionPopulation === null ? "" : `/${positionPopulation}명`}</p>;
  const statRow = () => <dl data-layout="arena-profile-stats" className="grid grid-cols-4 gap-2 border-t border-white/10 pt-2">{primaryStats.map(({ label, text, full }) => <div key={label} className="min-w-0"><dt className="type-caption text-zinc-500">{label}</dt><dd aria-label={full} title={full ?? text} className="truncate text-sm font-black tabular-nums text-zinc-100">{text}</dd></div>)}</dl>;
  return <section data-layout="arena-profile-hud" className="min-w-0 rounded-2xl border border-white/15 bg-[#232628]/95 p-3 text-zinc-100 shadow-[0_14px_34px_rgba(0,0,0,.28)] backdrop-blur-md">
    <div className="flex min-w-0 items-center gap-3"><div className="size-12 shrink-0 overflow-hidden rounded-xl bg-[#343839]">{player.face ? <img src={player.face} alt={`${player.name} 선수 사진`} className="h-full w-full object-cover object-top" /> : <span className="grid h-full place-items-center font-black text-zinc-500" aria-hidden="true">{player.name[0]}</span>}</div><div className="min-w-0 flex-1"><h2 className="truncate text-lg font-black tracking-tight">{player.name}</h2><p className="truncate type-caption text-zinc-400">{player.club.name} · {player.position}</p><p className="mt-1 type-caption text-zinc-500">{selected.season} · {contextText(selected)}</p></div><div className="shrink-0 text-right"><b className="block text-3xl font-black tabular-nums" style={{ color }}>{wholeScore(player, analysis)}</b><span className="type-caption" style={{ color }}>{tier.glyph} {tier.label}</span></div></div>
    <div className="mt-3 hidden lg:block">{statRow()}<div className="mt-2">{profileContext()}</div></div>
    <details className="mt-2 lg:hidden"><summary className="cursor-pointer type-caption font-bold text-zinc-300">기록 · 현재 프로필</summary><div className="mt-2">{statRow()}<div className="mt-2">{profileContext()}</div></div></details>
  </section>;
}

export function PlayerOverview({ player, analysis, selected, history, data, categoryState }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerOverviewHistory; data?: DuelPressV2DetailMetrics; categoryState?: OverviewReadoutState }) {
  // stat-pairs-v2 and the historical benchmark radars are diagnostics.  They
  // cannot be relabelled as the M.E.S.S.I. profile just because both have six
  // axes.  Only the unified-v3 envelope is an authoritative M.E.S.S.I.
  // category vector for this first-screen presentation.
  const authoritativeData = data?.ratingVersion === "messi-score-unified-v3" ? data : undefined;
  const state: OverviewReadoutState = authoritativeData ? "ready" : data ? "unavailable" : categoryState ?? "unavailable";
  return <section data-layout="player-overview" aria-label="선수 첫 화면 요약" className="grid min-w-0 overflow-hidden rounded-[1.75rem] border border-[#464a4c] bg-[#181a1b] shadow-[0_24px_60px_rgba(0,0,0,.24)] xl:grid-cols-[12rem_minmax(0,1fr)_22rem] xl:items-stretch">
    <PlayerIdentity player={player} analysis={analysis} selected={selected}/>
    <aside data-layout="overview-rail" className="min-w-0 border-t border-white/10 p-4 xl:col-start-1 xl:row-start-1 xl:border-r xl:border-t-0 xl:p-4"><OverviewSeasonRail player={player} analysis={analysis} selected={selected} history={history}/></aside>
    <div className="border-t border-white/10 xl:col-start-3 xl:row-start-1 xl:border-l xl:border-t-0"><OverviewCategoryVector categories={authoritativeData?.categories} state={state}/></div>
  </section>;
}
