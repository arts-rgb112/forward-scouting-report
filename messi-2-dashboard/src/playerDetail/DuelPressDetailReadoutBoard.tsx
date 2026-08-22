import { useId, useState, type ReactNode } from "react";
import { getScoreBand } from "../dashboard/scoutingConfig";
import type { DuelPressDetailReadout, DuelPressDetailReadoutEnvelope } from "../api/duelPressDetailReadoutContracts";

const categoryCopy: Record<DuelPressDetailReadoutEnvelope["categories"][number]["id"], { label: string }> = {
  outsideShot: { label: "박스 밖 슈팅" },
  boxThreat: { label: "박스 안 슈팅" },
  dangerZone: { label: "온볼 전개 영향력" },
  combinedDuel: { label: "통합 경합" },
  spaceControl: { label: "오프 더 볼" },
  forwardPress: { label: "전방 압박 효율" },
};

const directions = { higher_is_better: "높을수록 좋음", lower_is_better: "낮을수록 좋음", neutral: "중립 맥락" } as const;
const units = { count: "회", per90: "/90", goals: "골", percent: "%", score: "점" } as const;
const source = { player_season_total: "선수 시즌 원자료", league_per90_fallback: "리그 /90 대체 원자료", tactical_ratio_static: "전술 비율 정적 자료", server_derived: "서버 산출", unavailable: "제공 불가" } as const;
const state = { observed: "관측", server_derived: "서버 산출", imputed: "대체", unavailable: "제공 불가", legacy_partial: "부분 제공" } as const;
const ground = new Set(["groundDuelAttempts", "groundWonPer90", "groundLostPer90", "duelMarginPer90", "groundDuelWinRate"]);

function number(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); }

/** Presentation-only formatting of the backend's authoritative percentile. */
export function formatAuthoritativePercentile(percentile: number | null): number | null {
  if (percentile === null || !Number.isFinite(percentile)) return null;
  return Math.min(99, Math.max(0, Math.floor(percentile)));
}

function scoreTextToken(score: number) {
  return getScoreBand(score).className.split(" ").find((token) => token.startsWith("text-")) ?? getScoreBand(0).className.split(" ").find((token) => token.startsWith("text-"))!;
}

function comparisonDetails(comparison: DuelPressDetailReadout["comparison"]) {
  return <>
    {comparison.percentile !== null && <p>원본 백분위: {number(comparison.percentile)}</p>}
    {comparison.median !== null && <p>중앙값: {number(comparison.median)}</p>}
    {comparison.rank !== null && <p>순위/모집단: {comparison.rank}/{comparison.population}</p>}
    {comparison.rank === null && comparison.population > 0 && <p>비교 모집단: {comparison.population}</p>}
    {comparison.state !== "available" && <p>비교 상태: {comparison.state === "unavailable" ? "제공 불가" : "비적용"}</p>}
  </>;
}

function DetailsTooltip({ label, displayValue, children, trigger }: { label: string; displayValue: string; children: ReactNode; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tooltipId = `detail-tooltip-${useId().replace(/:/g, "")}`;
  return <span className="relative inline-flex min-w-0" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}>
    <button
      type="button"
      aria-label={`${label} ${displayValue} 상세 정보`}
      aria-describedby={open ? tooltipId : undefined}
      className="min-w-0 rounded text-inherit outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.currentTarget.blur(); setOpen(false); } }}
    >{trigger}</button>
    {open && <span id={tooltipId} role="tooltip" className="absolute right-0 top-full z-20 mt-2 w-64 rounded border border-white/20 bg-[#101415] p-3 text-left text-[11px] leading-4 text-zinc-200 shadow-lg">{children}</span>}
  </span>;
}

function ReadoutDetails({ item }: { item: DuelPressDetailReadout }) {
  return <>
    <p>원본 값: {item.value === null ? "제공 불가" : `${number(item.value)} ${units[item.unit]}`}</p>
    {comparisonDetails(item.comparison)}
    <p>상태: {state[item.state]}</p>
    <p>출처: {source[item.source]}</p>
    <p>방향: {directions[item.direction]}</p>
    {item.formulaId !== null && item.formulaVersion !== null && <p>계산식: {item.formulaId} (v{item.formulaVersion})</p>}
    {item.missingComponents?.length ? <p>누락 구성요소: {item.missingComponents.join(", ")}</p> : null}
  </>;
}

function CategoryDetails({ category }: { category: DuelPressDetailReadoutEnvelope["categories"][number] }) {
  return <>
    {category.score !== null && <p>서버 점수: {number(category.score)}</p>}
    {comparisonDetails(category.comparison)}
    <p>점수 상태: {state[category.scoreState === "observed" ? "observed" : category.scoreState]}</p>
    {category.imputedComponents.length > 0 && <p>대체 구성요소: {category.imputedComponents.join(", ")}</p>}
  </>;
}

function PercentileBar({ label, percentile }: { label: string; percentile: number | null }) {
  const display = formatAuthoritativePercentile(percentile);
  if (display === null) return <p className="mt-2 text-[10px] text-zinc-500">비교 제공 불가</p>;
  const band = getScoreBand(display);
  return <div role="progressbar" aria-label={`${label} 비교 백분위`} aria-valuemin={0} aria-valuemax={99} aria-valuenow={display} className="mt-2 h-1 overflow-hidden rounded bg-white/10"><span className={`block h-full rounded ${band.dotClassName}`} style={{ width: `${display}%` }} /></div>;
}

function ReadoutRows({ items }: { items: readonly DuelPressDetailReadout[] }) {
  return <dl className="mt-3 divide-y divide-white/10 border-t border-white/10 text-[11px] leading-4">
    <dt className="sr-only">서버 측정값</dt>
    {items.map((item) => {
      const percentile = formatAuthoritativePercentile(item.comparison.percentile);
      const displayValue = percentile === null ? "제공 불가" : String(percentile);
      return <div key={item.id} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 py-2">
        <dt className="min-w-0 break-words font-medium text-zinc-300">{item.label}</dt>
        <dd className="text-right font-mono font-bold tabular-nums">
          <DetailsTooltip label={item.label} displayValue={displayValue} trigger={<span className={percentile === null ? "text-zinc-500" : scoreTextToken(percentile)}>{displayValue}</span>}><ReadoutDetails item={item}/></DetailsTooltip>
        </dd>
      </div>;
    })}
  </dl>;
}

function CategoryCard({ category }: { category: DuelPressDetailReadoutEnvelope["categories"][number] }) {
  const copy = categoryCopy[category.id];
  const percentile = formatAuthoritativePercentile(category.comparison.percentile);
  const displayValue = percentile === null ? "제공 불가" : String(percentile);
  const groups = category.id === "combinedDuel"
    ? [["지상 경합", category.readouts.filter((item) => ground.has(item.id))], ["공중 경합", category.readouts.filter((item) => !ground.has(item.id))]] as const
    : [[undefined, category.readouts]] as const;
  return <article data-card="category" className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-3 shadow-sm">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <h3 className="min-w-0 text-sm font-black text-white">{copy.label}</h3>
      <DetailsTooltip label={`${copy.label} 카테고리`} displayValue={displayValue} trigger={<b className={`text-2xl font-black tabular-nums ${percentile === null ? "text-zinc-500" : scoreTextToken(percentile)}`}>{displayValue}</b>}><CategoryDetails category={category}/></DetailsTooltip>
    </div>
    <PercentileBar label={copy.label} percentile={category.comparison.percentile}/>
    {groups.map(([title, items]) => <section key={title ?? "all"} aria-label={title} className={title ? "mt-3 min-w-0" : "min-w-0"}>
      {title && <h4 className="border-b border-white/10 pb-1 text-xs font-bold text-zinc-200">{title}</h4>}
      <ReadoutRows items={items}/>
    </section>)}
  </article>;
}

function ContextCard({ readout, label }: { readout: DuelPressDetailReadout; label: string }) {
  const percentile = formatAuthoritativePercentile(readout.comparison.percentile);
  const displayValue = readout.value === null ? "제공 불가" : `${number(readout.value)} ${units[readout.unit]}`;
  return <article data-card="context" className="min-w-0 rounded-xl border border-white/10 bg-[#101415] p-3 shadow-sm">
    <div className="flex min-w-0 items-start justify-between gap-3">
      <h3 className="min-w-0 text-sm font-black text-white">{label}</h3>
      <DetailsTooltip label={label} displayValue={displayValue} trigger={<b className={`text-right text-lg font-black tabular-nums ${percentile === null ? "text-zinc-100" : scoreTextToken(percentile)}`}>{displayValue}</b>}><ReadoutDetails item={readout}/></DetailsTooltip>
    </div>
    <PercentileBar label={label} percentile={readout.comparison.percentile}/>
  </article>;
}

export function DuelPressDetailReadoutBoard({ data }: { data: DuelPressDetailReadoutEnvelope }) {
  return <section aria-label="Duel press detailed stats board" className="min-w-0">
    <h2 className="text-lg font-black">상세 스탯 보드</h2>
    <div data-layout="detail-readout-grid" className="mt-4 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{data.categories.map((category) => <CategoryCard key={category.id} category={category}/>)}</div>
    <section aria-label="컨텍스트 지표" className="mt-3 min-w-0">
      <div data-layout="auxiliary-measurements" className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
        <ContextCard readout={data.contextIndicators[0]} label="순수 전진 기여도"/>
        <ContextCard readout={data.contextIndicators[1]} label="득점 운·상대 선방"/>
      </div>
    </section>
  </section>;
}

export function DuelPressDetailReadoutUnavailable({ message, onRetry, loading }: { message?: string; onRetry?: () => void; loading?: boolean }) {
  return <section aria-label="Duel press detailed stats board" aria-busy={loading || undefined} className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4"><h2 className="font-black">상세 스탯 보드 {loading ? "불러오는 중" : "제공 불가"}</h2><p role={loading ? "status" : "alert"} className="mt-2 text-sm text-zinc-300">{loading ? "동일 컨텍스트의 서버 읽기값을 불러오는 중입니다." : message ?? "이 컨텍스트의 상세 스탯 읽기값을 제공할 수 없습니다."}</p>{onRetry && !loading && <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded border border-lime-300/40 px-4 text-sm text-lime-200">상세 스탯 다시 시도</button>}</section>;
}
