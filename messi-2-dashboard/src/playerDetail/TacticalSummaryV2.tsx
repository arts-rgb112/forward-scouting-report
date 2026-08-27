import type { TacticalSummaryV2Readout } from "../api/tacticalSummaryV2Contracts";
import type { TacticalSummaryV2State } from "./useTacticalSummaryV2";

const panel = "min-w-0 rounded-xl border border-white/10 bg-[#101415] p-4 shadow-sm";
const koreanLabels: Record<string, string> = {
  inBoxActivity: "박스 안 활동",
  lane1: "오른쪽 와이드 레인",
  lane2: "오른쪽 하프스페이스",
  lane3: "중앙 레인",
  lane4: "왼쪽 하프스페이스",
  lane5: "왼쪽 와이드 레인",
  coreArea: "핵심 활동 면적",
  frontBackActivityRange: "전후 활동폭",
  leftRightActivityRange: "좌우 활동폭",
};
const scopeLabel = (scope: number | null, mode: "league" | "europe") => mode === "europe" ? "유럽대항전" : `${scope}대리그`;
const format = (value: number | null) => value === null ? "—" : value.toFixed(1);
const signed = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
const reasonLabel = (reason: TacticalSummaryV2Readout["reason"]) => {
  if (reason === "position_label_not_player_role") return "비교 기준 없음 · 선수 역할 정보 없음";
  if (reason === "tactical_range_source_unavailable") return "비교 기준 없음 · 활동 범위 원본이 없습니다";
  return "비교 기준을 만들 수 없습니다";
};

function TailTrack({ item }: { item: TacticalSummaryV2Readout }) {
  if (item.cohortState === "unavailable" || item.percentileScore === null) return <div className="mt-3 text-xs text-zinc-500">비교 트랙 없음</div>;
  const magnitude = Math.max(0, Math.min(50, 50 - item.percentileScore));
  const below = item.relativeDirection === "below_median";
  const absolutePercentile = below ? item.percentileScore : 100 - item.percentileScore;
  const directionClass = below ? "bg-rose-300" : "bg-lime-300";
  return <div className="mt-3" role="progressbar" aria-label={`${koreanLabels[item.id] ?? item.label} 서버 제공 백분위`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={absolutePercentile}>
    <div className="relative h-2 overflow-hidden rounded bg-white/10"><span className="absolute bottom-0 top-0 left-1/2 z-10 w-px bg-zinc-100/80" aria-hidden="true" />
      {below ? <span className={`absolute bottom-0 top-0 ${directionClass}`} style={{ right: "50%", width: `${magnitude}%` }} /> : <span className={`absolute bottom-0 top-0 ${directionClass}`} style={{ left: "50%", width: `${magnitude}%` }} />}
    </div><div className="mt-1 flex justify-between text-[10px] text-zinc-500"><span>0</span><span>평균 50</span><span>100</span></div>
  </div>;
}

function Notices({ item }: { item: TacticalSummaryV2Readout }) {
  const messages: string[] = [];
  if (item.reason === "position_population_below_minimum") messages.push(`비교 대상 N=${item.population}명 — 기준선 해석에 주의하세요`);
  if (item.reason === "subject_valid_coordinates_below_minimum") messages.push(`측정 표본 부족 (좌표 N=${item.provenance.subjectValidCoordinateCount ?? "—"}개) — 값 해석에 주의하세요`);
  return messages.length ? <div className="mt-2 space-y-1 text-[11px] text-amber-200" aria-live="polite">{messages.map((message) => <p key={message}>{message}</p>)}</div> : null;
}

function Readout({ item }: { item: TacticalSummaryV2Readout }) {
  const unavailable = item.cohortState === "unavailable";
  const below = item.relativeDirection === "below_median";
  const tail = item.percentileScore === null ? "—" : below ? `하위 ${item.percentileScore.toFixed(0)}%` : item.relativeDirection === "at_median" ? "중앙값" : `상위 ${item.percentileScore.toFixed(0)}%`;
  return <article className="min-w-0 rounded-lg border border-white/10 bg-black/20 p-3" aria-label={`${koreanLabels[item.id] ?? item.label} 전술 지표`}>
    <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="text-sm font-bold">{koreanLabels[item.id] ?? item.label}</h3><p className="mt-0.5 text-[11px] text-zinc-500">서버 산출 · {item.formulaVersion}</p></div><span className={`shrink-0 rounded border px-2 py-1 text-sm font-black tabular-nums ${unavailable ? "border-white/10 text-zinc-500" : below ? "border-rose-300/40 text-rose-200" : "border-lime-300/40 text-lime-100"}`}>{format(item.value)}</span></div>
    {unavailable ? <p className="mt-3 text-sm text-zinc-400">{reasonLabel(item.reason)}</p> : <><dl className="mt-3 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-zinc-500">기준선</dt><dd className="mt-1 font-semibold tabular-nums">{format(item.baselineMedian)}</dd></div><div><dt className="text-zinc-500">차이</dt><dd className={`mt-1 font-semibold tabular-nums ${below ? "text-rose-200" : "text-lime-100"}`}>{signed(item.delta)}</dd></div><div><dt className="text-zinc-500">백분위</dt><dd className={`mt-1 font-semibold ${below ? "text-rose-200" : "text-lime-100"}`}>{tail}</dd></div></dl><TailTrack item={item}/><Notices item={item}/></>}
    <p className="mt-2 text-[10px] text-zinc-500">기준선 기여 N={item.population} · 제외 {item.provenance.excludedPopulation}</p>
  </article>;
}

function Skeleton() { return <section className={panel} aria-labelledby="tactical-summary-v2-heading" aria-busy="true"><h2 id="tactical-summary-v2-heading" className="text-sm font-black">전술 요약</h2><div className="mt-3 grid gap-3 lg:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-40 animate-pulse rounded-lg bg-white/10 motion-reduce:animate-none" />)}</div></section>; }

export function TacticalSummaryV2Panel({ state, onRetry }: { state: TacticalSummaryV2State; onRetry(): void }) {
  if (state.kind === "disabled") return null;
  if (state.kind === "loading") return <Skeleton/>;
  if (state.kind === "error") return <section className={panel} aria-labelledby="tactical-summary-v2-heading"><h2 id="tactical-summary-v2-heading" className="text-sm font-black">전술 요약</h2><div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded border border-amber-200/30 bg-amber-200/10 p-3 text-sm text-amber-100"><span>전술 요약을 불러오지 못했습니다.</span><button type="button" onClick={onRetry} className="min-h-11 rounded border border-amber-200/50 px-3 text-sm font-bold focus-visible:ring-2 focus-visible:ring-amber-200">다시 시도</button></div></section>;
  const { data } = state;
  const range = data.activityRange;
  const readouts = [data.positioning, ...data.movement, data.activityCore];
  return <section className={panel} aria-labelledby="tactical-summary-v2-heading"><div className="flex flex-wrap items-start justify-between gap-2"><div><h2 id="tactical-summary-v2-heading" className="text-sm font-black">전술 요약</h2><p className="mt-1 text-[11px] text-zinc-400">비교 기준 · {scopeLabel(data.cohortKey.scope, data.cohortKey.mode)} · {data.cohortKey.rawPosition} · N={data.cohortPopulation} · 서버 산출</p></div><span className="rounded border border-white/10 px-2 py-1 text-xs font-bold text-zinc-200">{range.roleLabel === "unavailable" ? "역할 판독 불가" : range.roleLabel}</span></div>
    <div className="mt-3 grid gap-3 xl:grid-cols-3">{readouts.map((item) => <Readout key={item.id} item={item}/>)}</div>
    <section className="mt-3 rounded-lg border border-white/10 bg-[#0d1112] p-3" aria-labelledby="activity-range-heading"><div className="flex flex-wrap items-baseline justify-between gap-2"><div><h3 id="activity-range-heading" className="text-sm font-black">활동 범위</h3><p className="text-[11px] text-zinc-500">전후·좌우 축은 서로 비교하지 않고 각 기준선으로만 읽습니다.</p></div><b className="text-xs text-zinc-200">{range.roleLabel === "unavailable" ? "비교 기준 없음" : range.roleLabel}</b></div><div className="mt-3 grid gap-3 md:grid-cols-2"><Readout item={range.frontBackActivityRange}/><Readout item={range.leftRightActivityRange}/></div><p className="mt-3 border-t border-white/10 pt-3 text-xs text-zinc-400">{data.disclosure}</p></section>
  </section>;
}
