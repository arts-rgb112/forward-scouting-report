import { useId, useState, type ReactNode } from "react";
import type { DuelPressV2Category, DuelPressV2DetailMetrics, DuelPressV2Metric } from "../api/duelPressV2Contracts";
import { duelPressAxisLabels, duelPressV2GroupLabel, duelPressV2MetricLabel } from "../dashboard/duelPressAxisLabels";
import { formatAuthoritativePercentile } from "./DuelPressDetailReadoutBoard";

type MetricSlot = "total" | "per90" | "value";
type MetricValue = NonNullable<DuelPressV2Metric["total"]>;
type ReadoutRow = { metric: DuelPressV2Metric; slot: MetricSlot; value: MetricValue; label: string; bucket: number; order: number };

function scoreTone(score: number | null) {
  if (score === null) return { badge: "border-zinc-400/30 bg-zinc-400/10 text-zinc-400", fill: "bg-zinc-500" };
  if (score >= 90) return { badge: "border-violet-300/45 bg-violet-400/15 text-violet-100", fill: "bg-violet-300" };
  if (score >= 80) return { badge: "border-lime-300/45 bg-lime-300/15 text-lime-100", fill: "bg-lime-300" };
  if (score >= 70) return { badge: "border-cyan-300/45 bg-cyan-400/15 text-cyan-100", fill: "bg-cyan-300" };
  if (score >= 60) return { badge: "border-amber-300/45 bg-amber-400/15 text-amber-100", fill: "bg-amber-300" };
  if (score >= 50) return { badge: "border-slate-300/45 bg-slate-400/15 text-slate-100", fill: "bg-slate-300" };
  return { badge: "border-rose-300/45 bg-rose-400/15 text-rose-100", fill: "bg-rose-300" };
}

function formatRawValue(item: MetricValue) {
  if (item.value === null || item.state === "unavailable" || item.comparison.state !== "available") return "—";
  if (item.unit === "count") return Math.round(item.value).toLocaleString("ko-KR");
  if (item.unit === "percent") return `${item.value.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`;
  return item.value.toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}

function availabilityReason(item: MetricValue) {
  if (item.state === "unavailable") return "선택한 문맥의 원시값을 제공하지 않습니다.";
  if (item.comparison.state !== "available") return "동일 코호트 비교 기준을 제공하지 않습니다.";
  return null;
}

function Tooltip({ label, children, content }: { label: string; children: ReactNode; content: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = `duel-v2-${useId().replace(/:/g, "")}`;
  return <span className="relative inline-flex min-w-0" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
    <button type="button" aria-label={`${label} 상세 정보`} aria-describedby={open ? id : undefined} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-lime-300" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen((value) => !value)}>{children}</button>
    {open && <span id={id} role="tooltip" className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded border border-white/20 bg-[#101415] p-3 type-caption text-zinc-200 shadow-xl">{content}</span>}
  </span>;
}

function MetricTooltip({ metric, item, slot }: { metric: DuelPressV2Metric; item: MetricValue; slot: MetricSlot }) {
  const reason = availabilityReason(item);
  return <div className="space-y-1">
    <p>{slot === "total" ? "총량" : slot === "per90" ? "/90" : "원시값"}: {item.value === null ? "데이터 없음" : item.value}</p>
    {reason ? <p>{reason}</p> : <p>중앙값 {item.comparison.median ?? "데이터 없음"} · 순위 {item.comparison.rank ?? "데이터 없음"}/{item.comparison.population}</p>}
    {item.state === "server_derived" && <p>서버 산식: {item.formulaId ?? "제공됨"} · {item.formulaVersion ?? "버전 제공 없음"}</p>}
    {metric.pairReason && <p>Pair 상태: {metric.pairState === "partial" ? "일부 값 미제공" : metric.pairState === "unavailable" ? "값 미제공" : metric.pairReason}</p>}
  </div>;
}

function rowsForGroup(group: DuelPressV2Category["groups"][number]) {
  const rows: ReadoutRow[] = [];
  group.metrics.forEach((metric, order) => {
    const label = duelPressV2MetricLabel(metric.id, metric.label);
    if (metric.total) rows.push({ metric, slot: "total", value: metric.total, label, bucket: 0, order });
    if (metric.per90) rows.push({ metric, slot: "per90", value: metric.per90, label: `${label} /90`, bucket: 1, order });
    if (metric.value) rows.push({ metric, slot: "value", value: metric.value, label, bucket: metric.value.unit === "per90" ? 1 : metric.value.unit === "percent" ? 2 : 3, order });
  });
  return rows.sort((left, right) => left.bucket - right.bucket || left.order - right.order);
}

function MetricRow({ row }: { row: ReadoutRow }) {
  const score = formatAuthoritativePercentile(row.value.percentileScore);
  const displayScore = row.value.comparison.state === "available" ? score : null;
  const tone = scoreTone(displayScore);
  return <div data-metric-id={row.metric.id} data-metric-slot={row.slot} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 border-t border-white/10 py-1.5">
    <span className="min-w-0 break-words type-label font-normal text-zinc-400">{row.label}</span>
    <span className="min-w-11 text-right font-mono type-body tabular-nums text-zinc-100">{formatRawValue(row.value)}</span>
    <Tooltip label={row.label} content={<MetricTooltip metric={row.metric} item={row.value} slot={row.slot}/>}><b className={`inline-flex min-w-8 items-center justify-center rounded px-1.5 py-0.5 font-mono type-label font-semibold tabular-nums ${tone.badge}`}>{displayScore ?? "—"}</b></Tooltip>
  </div>;
}

function CategoryTooltip({ category }: { category: DuelPressV2Category }) {
  return <><p>서버 백분위 점수: {category.percentileScore}/99</p><p>중앙값 {category.comparison.median ?? "데이터 없음"} · 순위 {category.comparison.rank ?? "데이터 없음"}/{category.comparison.population}</p>{category.imputedComponents.length > 0 && <p className="text-amber-200">대체 구성요소: {category.imputedComponents.join(", ")}</p>}</>;
}

function CategoryCard({ category, summary = false }: { category: DuelPressV2Category; summary?: boolean }) {
  const score = formatAuthoritativePercentile(category.percentileScore);
  const tone = scoreTone(score);
  const title = duelPressAxisLabels[category.id];
  const hasMultipleGroups = category.groups.length > 1;
  return <article data-taxonomy="duel-press-v2" className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-3 shadow-sm">
    <div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate type-title font-black text-white">{title}</h3><p className="mt-1 type-caption text-zinc-500">원시값 · 동일 코호트 백분위</p></div><Tooltip label={title} content={<CategoryTooltip category={category}/>}><b className={`inline-flex min-w-11 items-center justify-center rounded border px-2 py-1 font-mono type-metric font-black ${tone.badge}`}>{score ?? "—"}</b></Tooltip></div>
    <div role="progressbar" aria-label={`${title} 백분위`} aria-valuemin={0} aria-valuemax={99} {...(score === null ? {} : { "aria-valuenow": score })} className="mt-3 h-1.5 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${tone.fill}`} style={{ width: `${score ?? 0}%` }} /></div>
    {!summary && category.groups.map((group) => <section key={group.id} className="mt-3 min-w-0" aria-label={duelPressV2GroupLabel(group.id, group.label)}>{hasMultipleGroups && <h4 className="border-b border-white/10 pb-1 type-label font-bold text-zinc-200">{duelPressV2GroupLabel(group.id, group.label)}</h4>}{rowsForGroup(group).map((row) => <MetricRow key={`${row.metric.id}-${row.slot}`} row={row}/>)}</section>)}
  </article>;
}

function IndicatorCard({ indicator }: { indicator: DuelPressV2DetailMetrics["contextIndicators"][number] }) {
  const value = indicator.metric.value;
  const score = formatAuthoritativePercentile(value?.percentileScore ?? null);
  const tone = scoreTone(value?.comparison.state === "available" ? score : null);
  const label = duelPressV2MetricLabel(indicator.id, indicator.label);
  return <article className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-3"><div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-black text-white">{label}</h3><p className="mt-1 text-base text-zinc-400">{value ? formatRawValue(value) : "—"} · 백분위 {score ?? "—"}</p></div><Tooltip label={label} content={value ? <MetricTooltip metric={indicator.metric} item={value} slot="value"/> : "데이터 없음"}><b className={`inline-flex min-w-12 items-center justify-center rounded border px-2 py-1 font-mono text-sm ${tone.badge}`}>{score ?? "—"}</b></Tooltip></div><div role="progressbar" aria-label={`${label} 백분위`} aria-valuemin={0} aria-valuemax={99} {...(score === null ? {} : { "aria-valuenow": score })} className="mt-3 h-1.5 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${tone.fill}`} style={{ width: `${score ?? 0}%` }} /></div></article>;
}

export function DuelPressV2DetailReadoutBoard({ data, layout = "page" }: { data: DuelPressV2DetailMetrics; layout?: "page" | "rail" }) {
  const fullGrid = layout === "rail" ? "grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" : "grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3";
  return <section aria-label="Duel press v2 detailed stats board" data-taxonomy="duel-press-v2" className="min-w-0"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="type-title font-black">상세 스탯 보드</h2><span className="type-caption tracking-[0.12em] text-zinc-400">서버 백분위</span></div><p className="mt-1 text-base text-zinc-400">기본 화면은 카테고리 점수만 보여주며, 전체 지표는 아래에서 펼칠 수 있습니다.</p><div data-detail-level="summary" className="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{data.categories.map((category) => <CategoryCard key={category.id} category={category} summary/>)}</div><details data-detail-level="expanded" className="mt-4 rounded-xl border border-white/10 bg-black/20"><summary className="min-h-12 cursor-pointer px-4 py-3 text-base font-black focus-visible:ring-2 focus-visible:ring-lime-300">총량·/90·비율 전체 지표 펼치기</summary><div className={`border-t border-white/10 p-3 ${fullGrid}`}>{data.categories.map((category) => <CategoryCard key={category.id} category={category}/>)}</div></details><section aria-label="원본 감사 정보" className="mt-4"><h3 className="type-label font-black">데이터 품질 · 원본 감사</h3><div className="mt-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{data.contextIndicators.map((indicator) => <IndicatorCard key={indicator.id} indicator={indicator}/>)}</div></section></section>;
}

export function DuelPressV2DetailReadoutUnavailable({ message, onRetry, loading }: { message?: string; onRetry?: () => void; loading?: boolean }) { return <section aria-label="Duel press v2 detailed stats board" aria-busy={loading || undefined} className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4"><h2 className="font-black">상세 스탯 보드 {loading ? "불러오는 중" : "사용 불가"}</h2><p role={loading ? "status" : "alert"} className="mt-2 text-sm text-zinc-300">{loading ? "선택한 문맥의 서버 산출 점수를 불러오는 중입니다." : message ?? "v2 상세 스탯을 제공할 수 없습니다."}</p>{onRetry && !loading && <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded border border-lime-300/40 px-4 text-sm text-lime-200">다시 시도</button>}</section>; }
