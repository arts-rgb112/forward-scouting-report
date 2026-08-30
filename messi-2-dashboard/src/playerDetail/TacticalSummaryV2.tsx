import type { TacticalSummaryV2Readout } from "../api/tacticalSummaryV2Contracts";
import type { TacticalSummaryV2State } from "./useTacticalSummaryV2";

const COPY = {
  title: "전술 요약", comparison: "비교 기준", server: "서버 산출", positioning: "볼 받는 구역", movement: "침투 레인",
  activity: "활동 범위", average: "평균", noTrack: "비교 트랙 없음", retry: "다시 시도",
  loadError: "전술 요약을 불러오지 못했습니다.", unavailableRole: "역할 판독 불가",
} as const;
const LABELS: Record<string, string> = {
  inBoxActivity: "박스 안 활동", lane1: "오른쪽 와이드 레인", lane2: "오른쪽 하프스페이스", lane3: "중앙 레인",
  lane4: "왼쪽 하프스페이스", lane5: "왼쪽 와이드 레인", frontBackActivityRange: "전후 활동폭", leftRightActivityRange: "좌우 활동폭",
};
const panel = "min-w-0 w-full overflow-hidden rounded-2xl border border-[#252d2e] bg-[#101516] p-5";
const scopeLabel = (scope: number | null, mode: "league" | "europe") => mode === "europe" ? "유럽대항전" : `${scope}대리그`;
const metricLabel = (item: TacticalSummaryV2Readout) => LABELS[item.id] ?? item.label;
const isSpatialRatio = (item: TacticalSummaryV2Readout) => item.provenance.measure === "spatial_ratio";
const number = (value: number | null) => value === null ? "—" : value.toFixed(1);
const metricValue = (item: TacticalSummaryV2Readout) => item.value === null ? "—" : `${number(item.value)}${isSpatialRatio(item) ? "%" : ""}`;
const signedDelta = (item: TacticalSummaryV2Readout) => item.delta === null ? "—" : `${item.delta >= 0 ? "+" : ""}${item.delta.toFixed(1)}${isSpatialRatio(item) ? "%p" : ""}`;
const baseline = (item: TacticalSummaryV2Readout) => item.baselineMedian === null ? "—" : `${item.baselineMedian.toFixed(1)}${isSpatialRatio(item) ? "%" : ""}`;

function tailLabel(item: TacticalSummaryV2Readout) {
  if (item.percentileScore === null || item.relativeDirection === "unavailable") return "—";
  if (item.relativeDirection === "at_median") return "중앙값";
  return `${item.relativeDirection === "below_median" ? "하위" : "상위"} ${item.percentileScore.toFixed(0)}%`;
}
function reasonLabel(item: TacticalSummaryV2Readout) {
  if (item.reason === "position_label_not_player_role") return "비교 기준 없음 · 선수 역할 정보 없음";
  if (item.reason === "tactical_range_source_unavailable") return "비교 기준 없음 · 활동 범위 원본이 없습니다";
  return "비교 기준을 만들 수 없습니다";
}
function TailTrack({ item }: { item: TacticalSummaryV2Readout }) {
  if (item.cohortState === "unavailable" || item.percentileScore === null) return <p className="type-caption text-[#949f9f]">{COPY.noTrack}</p>;
  const below = item.relativeDirection === "below_median";
  const percentile = item.relativeDirection === "at_median" ? 50 : below ? item.percentileScore : 100 - item.percentileScore;
  const width = Math.max(0.4, Math.abs(percentile - 50));
  return <div className="relative h-[30px] w-full" data-track-direction={below ? "below" : "above"} role="progressbar" aria-label={`${metricLabel(item)} 서버 제공 백분위`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentile}>
    <span className="absolute left-0 top-[5px] h-1.5 w-full rounded-[3px] bg-[#252d2e]" aria-hidden="true"/>
    <span className={`absolute top-[5px] h-1.5 rounded-[3px] ${below ? "bg-[#fa6e7a]" : "bg-[#b5f052]"}`} style={below ? { right: "50%", width: `${width}%` } : { left: "50%", width: `${width}%` }} aria-hidden="true"/>
    <span className="absolute left-1/2 top-0 h-4 w-0.5 -translate-x-1/2 bg-[#949f9f]" aria-hidden="true"/>
    <span className="absolute left-1/2 top-[17px] -translate-x-1/2 type-caption leading-none text-[#949f9f]" aria-hidden="true">{COPY.average}</span>
  </div>;
}
function Notices({ item }: { item: TacticalSummaryV2Readout }) {
  const messages: string[] = [];
  if (item.reason === "position_population_below_minimum") messages.push(`저표본 비교군 · N=${item.population}`);
  if (item.reason === "subject_valid_coordinates_below_minimum") messages.push(`측정 표본 부족 · 좌표 N=${item.provenance.subjectValidCoordinateCount ?? "—"}`);
  return messages.length ? <div className="space-y-1 type-caption text-[#f5b247]" aria-live="polite">{messages.map((message) => <p key={message}>{message}</p>)}</div> : null;
}
function MetricCaption({ item, cohort }: { item: TacticalSummaryV2Readout; cohort: string }) {
  if (item.cohortState === "unavailable") return <p className="type-caption text-[#949f9f]">{reasonLabel(item)}</p>;
  return <p className="type-caption text-[#949f9f]">{cohort} 중앙값 {baseline(item)} · {signedDelta(item)}</p>;
}
function MainMetric({ sectionLabel, item, cohort, secondary }: { sectionLabel: string; item: TacticalSummaryV2Readout; cohort: string; secondary?: TacticalSummaryV2Readout }) {
  const below = item.relativeDirection === "below_median";
  return <article className="flex min-w-0 flex-col gap-2" aria-label={`${sectionLabel} 전술 지표`}>
    <div className="flex items-center justify-between"><h3 className="type-label font-semibold tracking-[0.6px] text-[#949f9f]">{sectionLabel}</h3><b className={`type-label ${below ? "text-[#fa6e7a]" : "text-[#b5f052]"}`}>{tailLabel(item)}</b></div>
    <div className="flex items-baseline gap-2.5 text-[#f5f8f7]"><span className="type-label">{metricLabel(item)}</span><strong className="type-metric tabular-nums">{metricValue(item)}</strong></div>
    <TailTrack item={item}/><MetricCaption item={item} cohort={cohort}/>
    {secondary && <p className="type-caption text-[#949f9f] opacity-75">다음 레인 · {metricLabel(secondary)} {metricValue(secondary)} · 중앙값 {baseline(secondary)} · {signedDelta(secondary)} · {tailLabel(secondary)}</p>}
    <Notices item={item}/>
    {secondary && <Notices item={secondary}/>}
  </article>;
}
function ActivityAxis({ item, cohort }: { item: TacticalSummaryV2Readout; cohort: string }) {
  const below = item.relativeDirection === "below_median";
  return <article className="flex min-w-0 flex-col gap-[7px]" aria-label={`${metricLabel(item)} 전술 지표`}>
    <div className="flex items-baseline justify-between gap-3"><div className="flex min-w-0 items-baseline gap-2.5 text-[#f5f8f7]"><span className="type-label">{metricLabel(item)}</span><strong className="type-metric tabular-nums">{metricValue(item)}</strong></div><b className={`shrink-0 type-label ${below ? "text-[#fa6e7a]" : "text-[#b5f052]"}`}>{tailLabel(item)}</b></div>
    <TailTrack item={item}/><MetricCaption item={item} cohort={cohort}/><Notices item={item}/>
  </article>;
}
function Skeleton() {
  return <section className={panel} aria-labelledby="tactical-summary-v2-heading" aria-busy="true"><h2 id="tactical-summary-v2-heading" className="type-title font-bold text-[#f5f8f7]">{COPY.title}</h2><div className="mt-4 space-y-4">{Array.from({ length: 3 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-lg bg-white/10 motion-reduce:animate-none"/>)}</div></section>;
}
export function TacticalSummaryV2Panel({ state, onRetry }: { state: TacticalSummaryV2State; onRetry(): void }) {
  if (state.kind === "disabled") return null;
  if (state.kind === "loading") return <Skeleton/>;
  if (state.kind === "error") return <section className={panel} aria-labelledby="tactical-summary-v2-heading"><h2 id="tactical-summary-v2-heading" className="type-title font-bold text-[#f5f8f7]">{COPY.title}</h2><div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-[#f5b247]/30 bg-[#f5b247]/10 p-3 type-body text-amber-100"><span>{COPY.loadError}</span><button type="button" onClick={onRetry} className="min-h-11 rounded border border-[#f5b247]/50 px-3 type-label font-bold focus-visible:ring-2 focus-visible:ring-[#f5b247]">{COPY.retry}</button></div></section>;
  const { data } = state;
  const [movement, nextMovement] = data.movement;
  const range = data.activityRange;
  const cohort = `${scopeLabel(data.cohortKey.scope, data.cohortKey.mode)} ${data.cohortKey.rawPosition}`;
  return <section className={`${panel} flex flex-col gap-4`} aria-labelledby="tactical-summary-v2-heading" data-layout="approved-tactical-summary">
    <header className="flex flex-col gap-1.5"><h2 id="tactical-summary-v2-heading" className="type-title font-bold text-[#f5f8f7]">{COPY.title}</h2><p className="type-caption text-[#949f9f]">{COPY.comparison} · {scopeLabel(data.cohortKey.scope, data.cohortKey.mode)} · {data.cohortKey.rawPosition} · N={data.cohortPopulation} · {COPY.server}</p></header>
    <div className="flex flex-col gap-4"><MainMetric sectionLabel={COPY.positioning} item={data.positioning} cohort={cohort}/>{movement && <MainMetric sectionLabel={COPY.movement} item={movement} cohort={cohort} secondary={nextMovement}/>}<section className="flex min-w-0 flex-col gap-3.5" aria-labelledby="activity-range-heading"><div className="flex items-center justify-between"><h3 id="activity-range-heading" className="type-label font-semibold tracking-[0.6px] text-[#949f9f]">{COPY.activity}</h3><b className="type-label text-[#45d6ed]">{range.roleLabel === "unavailable" ? COPY.unavailableRole : range.roleLabel}</b></div><ActivityAxis item={range.frontBackActivityRange} cohort={cohort}/><ActivityAxis item={range.leftRightActivityRange} cohort={cohort}/><p className="type-caption text-[#949f9f] opacity-70">{data.disclosure}</p></section></div>
  </section>;
}
