import type { CompetitionCode, DatasetMeta, DatasetRouteState, LeaderboardOptions } from "../types";

type Props = {
  meta: DatasetMeta; visibleCount: number; refreshing: boolean; onRefresh(): void;
  state: DatasetRouteState; options?: LeaderboardOptions; onStateChange(next: DatasetRouteState): void;
};

export function DatasetHeader({ meta, visibleCount, refreshing, onRefresh, state, options, onStateChange }: Props) {
  const update = (patch: Partial<DatasetRouteState>) => onStateChange({ ...state, ...patch });
  const competitions = options ? Object.values(options.competitions) : [];
  return <header className="mb-5 border-b border-white/10 pb-5">
    <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div><div className="mb-2 flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg border border-lime-300/30 bg-lime-300/10 font-black text-lime-300">M</div><span className="text-[10px] font-bold uppercase tracking-[.28em] text-emerald-300">Forward Intelligence / 2.0</span><a href="/about/messi" className="text-xs text-zinc-400 hover:text-lime-300">Metric guide</a></div><h1 className="text-2xl font-black sm:text-3xl">M.E.S.S.I. <span className="text-zinc-500">SCOUT INDEX</span></h1><p className="mt-1 text-xs text-zinc-500">Six-sector forward evaluation · generated {new Date(meta.generatedAt).toLocaleString()}</p></div>
      <div className="flex items-stretch gap-2"><div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 text-center">{[["Visible", visibleCount], ["Returned", meta.returned], ["Population", meta.population], ["Season", meta.season]].map(([label, value]) => <div key={String(label)} className="bg-[#101415] px-3 py-2"><div className="text-[9px] uppercase text-zinc-500">{label}</div><div className="font-mono text-sm font-black text-lime-300">{String(value)}</div></div>)}</div><button onClick={onRefresh} disabled={refreshing} className="min-h-11 rounded-lg border border-white/10 px-3 text-xs disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    </div>
    <section aria-label="Leaderboard dataset controls" aria-busy={refreshing} className="mt-4 flex flex-wrap gap-2 rounded-lg border border-white/10 bg-[#101415] p-2">
      <label className="text-[10px] text-zinc-500">Ranking type<select value={state.mode} disabled={refreshing} onChange={(e) => update({ mode: e.target.value as DatasetRouteState["mode"] })} className="mt-1 block min-h-10 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100"><option value="league">League ranking</option><option value="europe">European ranking</option></select></label>
      <label className="text-[10px] text-zinc-500">Season<select value={state.season} disabled={refreshing || !options} onChange={(e) => update({ season: e.target.value })} className="mt-1 block min-h-10 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100">{(options?.seasons ?? [state.season]).map((season) => <option key={season}>{season}</option>)}</select></label>
      {state.mode === "league" ? <label className="text-[10px] text-zinc-500">League scope<select value={state.scope} disabled={refreshing || !options} onChange={(e) => update({ scope: Number(e.target.value) as DatasetRouteState["scope"] })} className="mt-1 block min-h-10 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100">{(options?.scopes ?? []).map((scope) => <option key={scope.value} value={scope.value}>{scope.label}</option>)}</select></label> : <label className="text-[10px] text-zinc-500">Competition<select value={state.competition} disabled={refreshing || !options} onChange={(e) => update({ competition: e.target.value as CompetitionCode })} className="mt-1 block min-h-10 rounded border border-white/10 bg-[#080b0c] px-2 text-xs text-zinc-100">{competitions.map((competition) => <option key={competition.code} value={competition.code} disabled={!competition.available}>{competition.label}{competition.available ? "" : " (unavailable)"}</option>)}</select>{state.competition !== "all" && options?.competitions[state.competition]?.reason && <span className="mt-1 block max-w-52 text-[10px] text-amber-300">{options.competitions[state.competition].reason}</span>}</label>}
    </section>
  </header>;
}
