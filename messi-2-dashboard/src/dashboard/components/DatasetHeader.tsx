import type { CompetitionCode, CompetitionOption, DatasetDisplayMeta, DatasetRouteState, LeaderboardOptions } from "../types";
import { legacyAboutHref, resolveLegacyOrInternalHref } from "../../navigation/legacyHandoff";

type Props = {
  meta: DatasetDisplayMeta; visibleCount: number; refreshing: boolean; onRefresh(): void;
  state: DatasetRouteState; options?: LeaderboardOptions; onStateChange(next: DatasetRouteState): void;
  watchlistMode?: boolean;
};

function withCurrentValue<T extends string | number>(values: readonly T[], current: T) {
  return values.some((value) => value === current) ? values : [current, ...values];
}

export function DatasetHeader({ meta, visibleCount, refreshing, onRefresh, state, options, onStateChange, watchlistMode = false }: Props) {
  const metricGuideHref = resolveLegacyOrInternalHref(legacyAboutHref(), "/about/messi");
  const update = (patch: Partial<DatasetRouteState>) => onStateChange({ ...state, ...patch });
  const seasons = withCurrentValue(options?.seasons ?? [], state.season);
  const scopes = options?.scopes ?? [];
  const scopeValues = withCurrentValue(scopes.map((scope) => scope.value), state.scope);
  const optionCompetitions = options ? Object.values(options.competitions) : [];
  const competitions = optionCompetitions.some((competition) => competition.code === state.competition)
    ? optionCompetitions
    : [{ code: state.competition, label: state.competition === "all" ? "All competitions" : state.competition.toUpperCase(), available: true, reason: null }, ...optionCompetitions];
  const activeCompetition = options?.competitions[state.competition];
  const metrics = [["Visible", visibleCount], ["Returned", meta.returned], ["Population", meta.population], ["Season", meta.season]] as const;

  return <header className="mb-5 border-b border-white/10 pb-5">
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,620px)] xl:items-end xl:justify-between">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-lime-300/30 bg-lime-300/10 font-black text-lime-300">M</div>
          <span className="text-[10px] font-bold uppercase tracking-[.28em] text-emerald-300">Forward Intelligence / 2.0</span>
          <a href={metricGuideHref} className="text-xs text-zinc-400 hover:text-lime-300">Metric guide</a>
        </div>
        <h1 className="text-2xl font-black sm:text-3xl">M.E.S.S.I. <span className="text-zinc-500">SCOUT INDEX</span></h1>
        <p className="mt-1 text-xs text-zinc-500">Six-sector forward evaluation · generated {new Date(meta.generatedAt).toLocaleString()}</p>
      </div>

      <section aria-label="Leaderboard summary" className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 text-center sm:grid-cols-4">
          {metrics.map(([label, value]) => <div key={label} className="min-w-0 min-h-16 bg-[#101415] px-2 py-2 sm:px-3">
            <div className="truncate text-[9px] uppercase text-zinc-500">{label}</div>
            <div className="whitespace-nowrap font-mono text-sm font-black tabular-nums text-lime-300">{String(value)}</div>
          </div>)}
        </div>
        <button onClick={onRefresh} disabled={refreshing} className="min-h-11 min-w-28 shrink-0 whitespace-nowrap rounded-lg border border-white/10 px-4 text-xs disabled:cursor-wait disabled:opacity-50 md:w-auto">
          {refreshing ? (watchlistMode ? "Resolving…" : "Refreshing…") : (watchlistMode ? "Resolve saved contexts" : "Refresh")}
        </button>
      </section>
    </div>

    <section aria-label="Leaderboard dataset controls" aria-busy={refreshing} className="mt-4 rounded-lg border border-white/10 bg-[#101415] p-2">
      {refreshing && <p role="status" aria-live="polite" className="sr-only">{watchlistMode ? "Resolving saved contexts." : "Refreshing leaderboard data. Dataset filters remain available."}</p>}
      {watchlistMode && <p className="mb-2 px-1 text-[11px] text-zinc-500">Dataset controls are paused while viewing saved contexts; they do not change this local view.</p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="min-w-0 text-[10px] text-zinc-500">
          Ranking type
          <select disabled={watchlistMode} value={state.mode} onChange={(e) => update({ mode: e.target.value as DatasetRouteState["mode"] })} className="mt-1 block min-h-10 w-full min-w-0 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100 disabled:opacity-50">
            <option value="league">League ranking</option>
            <option value="europe">European ranking</option>
          </select>
        </label>
        <label className="min-w-0 text-[10px] text-zinc-500">
          Season
          <select disabled={watchlistMode} value={state.season} onChange={(e) => update({ season: e.target.value })} className="mt-1 block min-h-10 w-full min-w-0 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100 disabled:opacity-50">
            {seasons.map((season) => <option key={season} value={season}>{season}</option>)}
          </select>
        </label>
        {state.mode === "league" ? <label className="min-w-0 text-[10px] text-zinc-500">
          League scope
          <select disabled={watchlistMode} value={state.scope} onChange={(e) => update({ scope: Number(e.target.value) as DatasetRouteState["scope"] })} className="mt-1 block min-h-10 w-full min-w-0 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100 disabled:opacity-50">
            {scopeValues.map((scope) => <option key={scope} value={scope}>{scopes.find((candidate) => candidate.value === scope)?.label ?? `${scope} major leagues`}</option>)}
          </select>
        </label> : <label className="min-w-0 text-[10px] text-zinc-500">
          Competition
          <select disabled={watchlistMode} value={state.competition} onChange={(e) => update({ competition: e.target.value as CompetitionCode })} className="mt-1 block min-h-10 w-full min-w-0 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100 disabled:opacity-50">
            {competitions.map((competition: CompetitionOption) => <option key={competition.code} value={competition.code} disabled={!competition.available}>{competition.label}{competition.available ? "" : " (unavailable)"}</option>)}
          </select>
          {state.competition !== "all" && activeCompetition?.reason && <span className="mt-1 block text-[10px] text-amber-300">{activeCompetition.reason}</span>}
        </label>}
      </div>
    </section>
  </header>;
}
