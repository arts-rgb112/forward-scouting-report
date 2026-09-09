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
  return typeof window === "undefined" ? url : preserveExternalQuery(url, window.location.search, dashboardQueryKeys);
}

function OverviewSeasonRow({ row, player, analysis }: { row: SeasonOverviewRow; player: Player; analysis?: PlayerAnalysis }) {
  const color = tierColor(row.player);
  const score = row.selected ? wholeScore(player, analysis) : row.score.toFixed(1);
  const content = <><div className="min-w-0"><div className="flex min-w-0 items-center gap-1.5"><b className="truncate type-label text-zinc-100">{row.context.season}</b>{row.selected && <span className="rounded border border-white/20 px-1.5 py-0.5 type-caption text-zinc-300">현재</span>}</div><p className="mt-1 truncate type-caption text-zinc-500">{contextText(row.context)}</p></div><div className="flex min-w-0 items-center gap-2"><div className="h-1.5 w-14 overflow-hidden rounded bg-white/10" aria-hidden="true"><span className="block h-full rounded" style={{ backgroundColor: color, width: `${Math.min(100, Math.max(0, row.score / 99 * 100))}%` }} /></div><b className="type-label tabular-nums text-zinc-100">{score}</b></div></>;
  const rowClass = `grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 rounded-lg border px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300 ${row.selected ? "border-white/20 bg-white/[.07]" : "border-white/[.06] bg-black/10 hover:border-white/20"}`;
  return <li data-season={row.context.season} data-selected={row.selected ? "true" : "false"}>{row.selected ? <div className={rowClass}>{content}</div> : <a className={rowClass} href={seasonHref(player.id, row.context)} aria-label={`${row.context.season} ${contextText(row.context)} 선수 상세로 이동`}>{content}</a>}</li>;
}

function OverviewSeasonRail({ player, analysis, selected, history }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerOverviewHistory }) {
  const candidates = seasonScoreRows(player, analysis, selected, history.entries);
  const selectedRow = candidates.find((row) => row.selected) ?? candidates[0];
  const historicalRows = candidates.filter((row) => !row.selected)
    .sort((left, right) => right.context.season.localeCompare(left.context.season))
    .slice(0, MAX_HISTORICAL_SEASON_ROWS);
  const rows = selectedRow ? [selectedRow, ...historicalRows] : historicalRows;
  return <section aria-labelledby="overview-season-heading" className="min-w-0">
    <div className="flex items-center justify-between gap-2"><h2 id="overview-season-heading" className="type-label font-black tracking-[.08em] text-zinc-100">시즌 · 대회</h2><span className="type-caption text-zinc-500">M.E.S.S.I.</span></div>
    <ol className="mt-3 grid gap-2" aria-label="시즌별 M.E.S.S.I. 이력">
      {history.loading ? <>{selectedRow && <OverviewSeasonRow row={selectedRow} player={player} analysis={analysis}/>} {Array.from({ length: MAX_HISTORICAL_SEASON_ROWS }, (_, index) => <li key={index} aria-hidden="true" className="h-12 animate-pulse rounded-lg bg-white/[.05] motion-reduce:animate-none" />)}</> : rows.map((row) => <OverviewSeasonRow key={`${row.context.season}-${row.context.mode}`} row={row} player={player} analysis={analysis}/>) }
    </ol>
    {history.failed > 0 && <p role="status" className="mt-2 type-caption text-amber-200">시즌 이력 일부를 불러오지 못했습니다. 표시된 기록만 반영합니다.</p>}
  </section>;
}

function CategoryList({ categories, state }: { categories?: DuelPressV2Category[]; state: OverviewReadoutState }) {
  return <section className="min-w-0 border-t border-white/10 pt-4" aria-labelledby="overview-category-heading">
    <div className="flex items-center justify-between gap-2"><h2 id="overview-category-heading" className="type-label font-black tracking-[.08em] text-zinc-100">카테고리 스탯</h2><span className="type-caption text-zinc-500">정본 점수</span></div>
    {state === "loading" && <div aria-busy="true" className="mt-3 grid gap-2">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-7 animate-pulse rounded bg-white/[.05] motion-reduce:animate-none" />)}</div>}
    {state === "unavailable" && <p role="status" className="mt-3 rounded border border-white/10 bg-black/10 p-3 type-caption text-zinc-500">선택된 데이터 버전에서는 카테고리 정본 점수를 제공하지 않습니다.</p>}
    {state === "error" && <p role="alert" className="mt-3 rounded border border-amber-300/30 bg-amber-300/10 p-3 type-caption text-amber-100">카테고리 정본 점수를 불러오지 못했습니다.</p>}
    {state === "ready" && <ul className="mt-3 grid gap-2">{categories?.map((category, index) => {
      const unavailable = category.scoreState === "unavailable";
      const value = unavailable ? null : category.percentileScore;
      return <li key={category.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3"><span className="truncate type-caption text-zinc-400">{duelPressAxisLabels[category.id]}</span><span className="flex items-center gap-2"><span className="h-1.5 w-16 overflow-hidden rounded bg-white/10" aria-hidden="true"><span className={`block h-full rounded ${category.scoreState === "imputed" ? "opacity-60" : ""}`} style={{ backgroundColor: categoryColors[index], width: `${value ?? 0}%` }} /></span><b className="w-9 text-right type-label tabular-nums text-zinc-100">{value === null ? "—" : value.toFixed(0)}</b></span>{category.scoreState === "imputed" && <span className="sr-only">일부 서버 대체값 포함</span>}</li>;
    })}</ul>}
  </section>;
}

function pointFor(index: number, value: number, total: number) {
  const angle = -Math.PI / 2 + index * (Math.PI * 2 / total);
  const radius = 49 * value / 100;
  return `${(60 + Math.cos(angle) * radius).toFixed(2)},${(60 + Math.sin(angle) * radius).toFixed(2)}`;
}

function Radar({ categories, state }: { categories?: DuelPressV2Category[]; state: OverviewReadoutState }) {
  const usable = state === "ready" && categories?.every((category) => category.scoreState !== "unavailable") ? categories : undefined;
  const ring = (ratio: number) => Array.from({ length: 6 }, (_, index) => pointFor(index, ratio * 100, 6)).join(" ");
  const polygon = usable?.map((category, index) => pointFor(index, category.percentileScore, usable.length)).join(" ");
  return <section aria-labelledby="overview-radar-heading" className="flex min-w-0 flex-col rounded-xl border border-white/10 bg-[#101516] p-4 shadow-sm">
    <div className="flex items-baseline justify-between gap-2"><h2 id="overview-radar-heading" className="type-label font-black tracking-[.08em] text-zinc-100">M.E.S.S.I. 프로필</h2><span className="type-caption text-zinc-500">6 카테고리</span></div>
    <div className="relative mx-auto mt-3 aspect-square w-full max-w-[240px]" role="img" aria-label={usable ? "서버 제공 M.E.S.S.I. 6개 카테고리 레이더" : "M.E.S.S.I. 카테고리 레이더 데이터 없음"}>
      <svg viewBox="0 0 120 120" className="h-full w-full overflow-visible" aria-hidden="true">
        {[.25, .5, .75, 1].map((ratio) => <polygon key={ratio} points={ring(ratio)} fill="none" stroke="rgba(255,255,255,.14)" strokeWidth=".7" />)}
        {Array.from({ length: 6 }, (_, index) => <line key={index} x1="60" y1="60" x2={pointFor(index, 100, 6).split(",")[0]} y2={pointFor(index, 100, 6).split(",")[1]} stroke="rgba(255,255,255,.12)" strokeWidth=".7" />)}
        {polygon && <polygon points={polygon} fill="rgba(171,143,250,.25)" stroke="#b5f052" strokeWidth="1.6" />}
        {usable?.map((category, index) => { const [cx, cy] = pointFor(index, category.percentileScore, usable.length).split(","); return <circle key={category.id} cx={cx} cy={cy} r="1.8" fill={categoryColors[index]} />; })}
      </svg>
    </div>
    {usable ? <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">{usable.map((category, index) => <li key={category.id} className="flex min-w-0 items-center gap-1.5"><span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: categoryColors[index] }} /><span className="truncate type-caption text-zinc-400">{duelPressAxisLabels[category.id]}</span></li>)}</ul> : <p role={state === "error" ? "alert" : "status"} className={`mt-3 text-center type-caption ${state === "error" ? "text-amber-200" : "text-zinc-500"}`}>{state === "loading" ? "정본 카테고리 점수를 불러오는 중입니다." : state === "error" ? "정본 카테고리 점수 요청에 실패했습니다." : "선택된 문맥의 정본 카테고리 점수가 없습니다."}</p>}
    {state === "ready" && categories?.some((category) => category.scoreState === "imputed") && <p className="mt-3 type-caption text-amber-200">일부 카테고리에 서버 대체 구성요소가 포함되어 있습니다.</p>}
  </section>;
}

function PlayerIdentity({ player, analysis, selected }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState }) {
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
  return <section aria-labelledby="overview-profile-heading" className="relative isolate min-w-0 overflow-hidden rounded-xl border border-white/10 bg-gradient-to-br from-[#18243a] via-[#111a29] to-[#101516] p-5 shadow-sm xl:col-start-2 xl:row-start-1">
    <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-16 size-52 rounded-full border border-white/10" />
    <div className="relative flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"><div className="flex min-w-0 items-center gap-4"><div className="h-24 w-[76px] shrink-0 overflow-hidden rounded-lg border border-white/15 bg-black/20 shadow-lg">{player.face ? <img src={player.face} alt={`${player.name} 선수 사진`} className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-3xl font-black text-zinc-500" aria-hidden="true">{player.name[0]}</span>}</div><div className="min-w-0"><h2 id="overview-profile-heading" className="truncate text-2xl font-black tracking-tight text-white sm:text-3xl">{player.name}</h2><p className="mt-1 truncate type-body text-zinc-300">{player.club.name} · {player.position}</p><p className="mt-1 type-caption text-zinc-500">{contextText(selected)} · {selected.season}</p><p className="mt-2 flex items-center gap-1.5 type-caption text-zinc-300 sm:mt-3">{player.nation?.icon && <img src={player.nation.icon} alt="" className="h-3.5 w-5 object-contain" />}{player.nation ? `${player.nation.name} · ` : ""}{player.age === null ? "현재 프로필 나이 정보 없음" : `현재 프로필 기준 · ${player.age}세`}</p></div></div><div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-white/10 pt-3 sm:block sm:w-auto sm:border-0 sm:pt-0 sm:text-right"><div className="flex items-center gap-2 sm:block"><b className="block text-4xl font-black leading-none tabular-nums sm:text-5xl" style={{ color }}>{score}</b><span className="inline-flex rounded border px-2 py-1 type-caption font-bold sm:mt-2" style={{ color, borderColor: color }}>{tier.glyph} {tier.label} Lv.{player.tier.level}</span></div><p className="basis-full type-caption text-zinc-400 sm:mt-3">대회 전체 {player.rank}위 · 동포지션 {positionRank === null ? "—" : `${positionRank}위`}/{positionPopulation === null ? "—" : `${positionPopulation}명`}</p></div></div>
    <dl className="relative mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 min-[360px]:grid-cols-4 sm:mt-5">{primaryStats.map(({ label, text, full }) => <div key={label} className="min-w-0 bg-[#101827]/80 px-3 py-2.5 min-[360px]:px-2 min-[360px]:py-2 sm:px-3 sm:py-3"><dt className="type-caption text-zinc-500">{label}</dt><dd aria-label={full} title={full ?? text} className="mt-1 truncate text-lg font-black tabular-nums text-zinc-100">{text}</dd></div>)}</dl>
    <p className="relative mt-2 type-caption text-zinc-500 sm:mt-3">표시값은 선택한 시즌·대회 문맥의 서버 제공 기록입니다.</p>
  </section>;
}

export function PlayerOverview({ player, analysis, selected, history, data, categoryState }: { player: Player; analysis?: PlayerAnalysis; selected: DatasetRouteState; history: PlayerOverviewHistory; data?: DuelPressV2DetailMetrics; categoryState?: OverviewReadoutState }) {
  // stat-pairs-v2 and the historical benchmark radars are diagnostics.  They
  // cannot be relabelled as the M.E.S.S.I. profile just because both have six
  // axes.  Only the unified-v3 envelope is an authoritative M.E.S.S.I.
  // category vector for this first-screen presentation.
  const authoritativeData = data?.ratingVersion === "messi-score-unified-v3" ? data : undefined;
  const state: OverviewReadoutState = authoritativeData ? "ready" : data ? "unavailable" : categoryState ?? "unavailable";
  return <section data-layout="player-overview" aria-label="선수 첫 화면 요약" className="grid min-w-0 gap-4 xl:grid-cols-[minmax(250px,.78fr)_minmax(0,1.6fr)_minmax(250px,.82fr)] xl:items-start">
    <PlayerIdentity player={player} analysis={analysis} selected={selected}/>
    <aside data-layout="overview-rail" className="min-w-0 rounded-xl border border-white/10 bg-[#101516] p-4 shadow-sm xl:col-start-1 xl:row-start-1"><OverviewSeasonRail player={player} analysis={analysis} selected={selected} history={history}/><CategoryList categories={authoritativeData?.categories} state={state}/></aside>
    <div className="xl:col-start-3 xl:row-start-1"><Radar categories={authoritativeData?.categories} state={state}/></div>
  </section>;
}
