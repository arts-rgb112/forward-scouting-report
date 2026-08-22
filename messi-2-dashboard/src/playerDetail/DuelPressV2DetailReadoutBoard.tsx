import { useId, useState, type ReactNode } from "react";
import { getScoreBand } from "../dashboard/scoutingConfig";
import { formatAuthoritativePercentile } from "./DuelPressDetailReadoutBoard";
import type { DuelPressV2Category, DuelPressV2DetailMetrics, DuelPressV2Metric } from "../api/duelPressV2Contracts";

const labels: Record<string, string> = { outsideShot: "박스 밖 슈팅", boxThreat: "박스 안 슈팅", dangerZone: "온볼 전개 영향력", combinedDuel: "통합 경합", spaceControl: "오프 더 볼", forwardPress: "전방 압박 효율" };
const unitLabel = (unit: string) => unit === "per90" ? "/90" : unit === "count" ? "회" : unit === "goals" ? "골" : unit === "percent" ? "%" : "점";

function Tooltip({ label, children, content }: { label: string; children: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false); const id = `duel-v2-${useId().replace(/:/g, "")}`;
  return <span className="relative inline-flex min-w-0" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}><button type="button" aria-label={`${label} 상세 정보`} aria-describedby={open ? id : undefined} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-lime-300" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen((value) => !value)}>{children}</button>{open && <span id={id} role="tooltip" className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded border border-white/20 bg-[#101415] p-3 text-[11px] leading-4 text-zinc-200 shadow-xl">{content}</span>}</span>;
}

function MetricTooltip({ metric }: { metric: DuelPressV2Metric }) {
  const values = [metric.total, metric.per90, metric.value].filter(Boolean);
  const comparisonMetric = metric.pairState === "scalar" ? metric.value : metric.total;
  const comparison = comparisonMetric?.comparison;
  return <div className="space-y-1">{values.map((item, index) => <p key={`${item!.unit}-${index}`}>{index === 0 && metric.pairState !== "scalar" ? "총량" : metric.pairState === "scalar" ? "원천값" : "/90"}: {item!.value === null ? "데이터 없음" : `${item!.value} ${unitLabel(item!.unit)}`} · {item!.state} · {item!.source}</p>)}{metric.pairReason && <p>사유: {metric.pairReason}</p>}{comparison && comparison.state !== "unavailable" && <p>순위: {comparison.rank ?? "데이터 없음"}/{comparison.population} · 중앙값 {comparison.median ?? "데이터 없음"}</p>}</div>;
}

function ScoreRow({ metric, label, score, slot }: { metric: DuelPressV2Metric; label: string; score: number | null; slot: "value" | "total" | "per90" }) {
  const displayScore = formatAuthoritativePercentile(score);
  const band = displayScore === null ? null : getScoreBand(displayScore);
  return <div data-metric-slot={slot} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-white/10 py-2"><span className="min-w-0 break-words text-xs text-zinc-300">{label}</span><Tooltip label={label} content={<MetricTooltip metric={metric}/>}><b className={`inline-flex min-w-9 items-center justify-center rounded border px-2 py-1 font-mono text-xs ${band?.className ?? "border-zinc-400/30 bg-zinc-400/10 text-zinc-400"}`}>{displayScore ?? "—"}</b></Tooltip></div>;
}

function MetricRow({ metric }: { metric: DuelPressV2Metric }) {
  if (metric.pairState === "scalar") {
    return <ScoreRow metric={metric} label={metric.label} score={metric.value?.percentileScore ?? null} slot="value"/>;
  }
  return <>
    <ScoreRow metric={metric} label={`${metric.label} — Total`} score={metric.total?.percentileScore ?? null} slot="total"/>
    <ScoreRow metric={metric} label={`${metric.label} — /90`} score={metric.per90?.percentileScore ?? null} slot="per90"/>
  </>;
}

function CategoryCard({ category }: { category: DuelPressV2Category }) {
  const score = formatAuthoritativePercentile(category.percentileScore); const band = getScoreBand(score ?? 0);
  return <article data-taxonomy="duel-press-v2" className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-3 shadow-sm"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-zinc-500">{category.id}</p><h3 className="truncate text-sm font-black text-white">{labels[category.id] ?? category.label}</h3></div><Tooltip label={labels[category.id] ?? category.label} content={<><p>서버 백분위 점수: {category.percentileScore}/99</p><p>상태: {category.scoreState}</p><p>중앙값: {category.comparison.median ?? "데이터 없음"} · 순위: {category.comparison.rank ?? "데이터 없음"}/{category.comparison.population}</p>{category.imputedComponents.length > 0 && <p className="text-amber-200">대체 구성요소: {category.imputedComponents.join(", ")}</p>}</>}><b className={`inline-flex min-w-11 items-center justify-center rounded border px-2 py-1 font-mono text-lg font-black ${band.className}`}>{score}</b></Tooltip></div><div role="progressbar" aria-label={`${labels[category.id] ?? category.label} 백분위`} aria-valuemin={0} aria-valuemax={99} aria-valuenow={score ?? 0} className="mt-3 h-1.5 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${band.dotClassName}`} style={{ width: `${score}%` }} /></div>{category.groups.map((group) => <section key={group.id} className="mt-3 min-w-0" aria-label={group.label}><h4 className="border-b border-white/10 pb-1 text-xs font-bold text-zinc-200">{group.label}</h4>{group.metrics.map((metric) => <MetricRow key={metric.id} metric={metric} />)}</section>)}</article>;
}

function IndicatorCard({ indicator }: { indicator: DuelPressV2DetailMetrics["contextIndicators"][number] }) {
  const score = formatAuthoritativePercentile(indicator.metric.value?.percentileScore ?? null); const band = score === null ? null : getScoreBand(score);
  return <article className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-3"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-black text-white">{indicator.id === "netProgressionPer90" ? "순수 전진 기여도" : "득점 운·상대 선방"}</h3><Tooltip label={indicator.label} content={<MetricTooltip metric={indicator.metric}/>}><b className={`inline-flex min-w-12 items-center justify-center rounded border px-2 py-1 font-mono text-sm ${band?.className ?? "border-zinc-400/30 bg-zinc-400/10 text-zinc-400"}`}>{score ?? "—"}</b></Tooltip></div><div role="progressbar" aria-label={`${indicator.label} 백분위`} aria-valuemin={0} aria-valuemax={99} {...(score === null ? {} : { "aria-valuenow": score })} className="mt-3 h-1.5 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${band?.dotClassName ?? "bg-zinc-500"}`} style={{ width: `${score ?? 0}%` }} /></div></article>;
}

export function DuelPressV2DetailReadoutBoard({ data, layout = "page" }: { data: DuelPressV2DetailMetrics; layout?: "page" | "rail" }) {
  const grid = layout === "rail" ? "mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" : "mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";
  return <section aria-label="Duel press v2 detailed stats board" data-taxonomy="duel-press-v2" className="min-w-0"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-black">상세 스탯 보드</h2><span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Server percentile · stat-pairs-v2</span></div><div className={grid}>{data.categories.map((category) => <CategoryCard key={category.id} category={category}/>)}</div><div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{data.contextIndicators.map((indicator) => <IndicatorCard key={indicator.id} indicator={indicator}/>)}</div></section>;
}

export function DuelPressV2DetailReadoutUnavailable({ message, onRetry, loading }: { message?: string; onRetry?: () => void; loading?: boolean }) { return <section aria-label="Duel press v2 detailed stats board" aria-busy={loading || undefined} className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4"><h2 className="font-black">상세 스탯 보드 {loading ? "불러오는 중" : "사용 불가"}</h2><p role={loading ? "status" : "alert"} className="mt-2 text-sm text-zinc-300">{loading ? "선택한 문맥의 서버 산출 점수를 불러오는 중입니다." : message ?? "v2 상세 스탯을 제공할 수 없습니다."}</p>{onRetry && !loading && <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded border border-lime-300/40 px-4 text-sm text-lime-200">다시 시도</button>}</section>; }
