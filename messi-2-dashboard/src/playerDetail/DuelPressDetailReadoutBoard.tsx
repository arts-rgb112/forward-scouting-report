import { useId, useState, type ReactNode } from "react";
import { duelPressAxisLabels } from "../dashboard/duelPressAxisLabels";
import type { DuelPressDetailReadout, DuelPressDetailReadoutEnvelope } from "../api/duelPressDetailReadoutContracts";

const directions = { higher_is_better: "높을수록 좋음", lower_is_better: "낮을수록 좋음", neutral: "중립 맥락" } as const;
const units = { count: "회", per90: "/90", goals: "골", percent: "%", score: "점" } as const;
const source = { player_season_total: "선수 시즌 원자료", league_per90_fallback: "리그 /90 대체 원자료", tactical_ratio_static: "전술 비율 정적 자료", server_derived: "서버 산출", unavailable: "제공 불가" } as const;
const state = { observed: "관측", server_derived: "서버 산출", imputed: "대체", unavailable: "제공 불가", legacy_partial: "부분 제공" } as const;

type CategoryId = DuelPressDetailReadoutEnvelope["categories"][number]["id"];
type GroupKind = "volume" | "ratio" | "reference";
type RowSpec = { id: string; label: string; signed?: boolean };
type GroupSpec = { kind: GroupKind; label: string; rows: readonly RowSpec[] };

const CATEGORY_COLUMNS: readonly (readonly CategoryId[])[] = [
  ["outsideShot", "dangerZone"],
  ["boxThreat", "spaceControl"],
  ["combinedDuel", "forwardPress"],
];

const CATEGORY_GROUPS: Readonly<Record<CategoryId, readonly GroupSpec[]>> = {
  outsideShot: [
    { kind: "volume", label: "볼륨 50%", rows: [{ id: "outsideBoxShots", label: "박스 밖 슈팅" }] },
    { kind: "ratio", label: "비율 50%", rows: [{ id: "outsideBoxShotQualityGoals", label: "슈팅 질 (xGOT−xG)", signed: true }] },
    { kind: "reference", label: "참고", rows: [{ id: "outsideBoxXg", label: "박스 밖 xG" }, { id: "outsideBoxXgot", label: "박스 밖 xGOT" }] },
  ],
  boxThreat: [
    { kind: "volume", label: "볼륨 50%", rows: [{ id: "inBoxShots", label: "박스 안 슈팅" }] },
    { kind: "ratio", label: "비율 50%", rows: [{ id: "inBoxFinishingPer90", label: "순수 결정력 /90  70%", signed: true }, { id: "deepBoxZoneScore", label: "딥 박스 존 점유  30%" }] },
    { kind: "reference", label: "참고", rows: [{ id: "inBoxXg", label: "박스 안 xG" }, { id: "inBoxXgot", label: "박스 안 xGOT" }, { id: "inBoxFinishingGoals", label: "순수 결정력 (xGOT−xG)", signed: true }] },
  ],
  dangerZone: [
    { kind: "volume", label: "볼륨 50%", rows: [{ id: "dribbleAttempts", label: "드리블 시도" }] },
    { kind: "ratio", label: "비율 50%", rows: [{ id: "dribbleMarginPer90", label: "드리블 마진 /90  35%", signed: true }, { id: "dangerZoneDensity", label: "위험 지역 밀도  15%" }] },
    { kind: "reference", label: "참고", rows: [{ id: "successfulDribblesPer90", label: "성공 드리블 /90" }, { id: "failedDribblesPer90", label: "실패 드리블 /90" }, { id: "dribbleSuccessRate", label: "드리블 성공률" }] },
  ],
  combinedDuel: [
    { kind: "volume", label: "볼륨 50%", rows: [{ id: "groundDuelAttempts", label: "지상 경합 시도" }, { id: "aerialDuelAttempts", label: "공중 경합 시도" }] },
    { kind: "ratio", label: "비율 50%", rows: [{ id: "duelMarginPer90", label: "지상 마진 /90", signed: true }, { id: "aerialMarginPer90", label: "공중 마진 /90", signed: true }] },
    { kind: "reference", label: "참고", rows: [{ id: "groundWonPer90", label: "지상 승리 /90" }, { id: "groundLostPer90", label: "지상 패배 /90" }, { id: "groundDuelWinRate", label: "지상 승률" }, { id: "aerialWonPer90", label: "공중 승리 /90" }, { id: "aerialLostPer90", label: "공중 패배 /90" }, { id: "aerialDuelWinRate", label: "공중 승률" }] },
  ],
  spaceControl: [
    { kind: "volume", label: "볼륨 50%", rows: [{ id: "ccaAreaPct", label: "CCA 면적" }] },
    { kind: "ratio", label: "비율 50%", rows: [{ id: "dangerZoneDensity", label: "위험 지역 밀도" }] },
  ],
  forwardPress: [
    { kind: "volume", label: "볼륨 50%", rows: [{ id: "recoveriesPer90", label: "회수 /90" }] },
    { kind: "ratio", label: "비율 50%", rows: [{ id: "finalThirdPossessionsWonPer90", label: "파이널 서드 탈취 /90" }] },
    { kind: "reference", label: "참고", rows: [{ id: "recoveries", label: "회수" }, { id: "finalThirdPossessionsWon", label: "파이널 서드 탈취" }] },
  ],
};

const COLORS = {
  panel: "var(--messi-panel, #101516)", border: "var(--messi-border, #252d2e)", text: "var(--messi-text, #f5f8f7)", muted: "var(--messi-muted, #949f9f)", accent: "var(--messi-accent, #b5f052)", violet: "var(--messi-violet, #ab8ffa)", cyan: "var(--messi-cyan, #45d6ed)", amber: "var(--messi-amber, #f5b247)", rose: "var(--messi-rose, #fa6e7a)",
} as const;

function bandColor(score: number | null) {
  if (score === null) return COLORS.muted;
  if (score >= 90) return COLORS.violet;
  if (score >= 80) return COLORS.accent;
  if (score >= 70) return COLORS.cyan;
  if (score >= 60) return COLORS.amber;
  if (score >= 50) return COLORS.muted;
  return COLORS.rose;
}

function number(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""); }

/** Presentation-only formatting of the backend's authoritative percentile. */
export function formatAuthoritativePercentile(percentile: number | null): number | null {
  if (percentile === null || !Number.isFinite(percentile)) return null;
  return Math.min(99, Math.max(0, Math.floor(percentile)));
}

function displayRawValue(item: DuelPressDetailReadout, signed = false) {
  if (item.value === null || item.state === "unavailable") return "—";
  const formatted = item.unit === "percent" ? `${number(item.value)}%` : number(item.value);
  if (!signed || item.value === 0 || item.unit === "percent") return formatted;
  return item.value > 0 ? `+${formatted}` : formatted.replace("-", "−");
}

function comparisonDetails(comparison: DuelPressDetailReadout["comparison"]) {
  return <>{comparison.percentile !== null && <p>원본 백분위: {number(comparison.percentile)}</p>}{comparison.median !== null && <p>중앙값: {number(comparison.median)}</p>}{comparison.rank !== null && <p>순위/모집단: {comparison.rank}/{comparison.population}</p>}{comparison.rank === null && comparison.population > 0 && <p>비교 모집단: {comparison.population}</p>}{comparison.state !== "available" && <p>비교 상태: {comparison.state === "unavailable" ? "제공 불가" : "비적용"}</p>}</>;
}

function DetailsTooltip({ label, children, trigger }: { label: string; children: ReactNode; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const tooltipId = `detail-tooltip-${useId().replace(/:/g, "")}`;
  return <span className="relative inline-flex min-w-0" onPointerEnter={() => setOpen(true)} onPointerLeave={() => setOpen(false)}><button type="button" aria-label={`${label} 상세 정보`} aria-describedby={open ? tooltipId : undefined} className="min-w-0 rounded text-inherit outline-none focus-visible:ring-2 focus-visible:ring-lime-300" onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen((value) => !value)}>{trigger}</button>{open && <span id={tooltipId} role="tooltip" className="absolute right-0 top-full z-20 mt-2 w-64 rounded border border-white/20 bg-[#101415] p-3 text-left text-[11px] leading-4 text-zinc-200 shadow-lg">{children}</span>}</span>;
}

function ReadoutDetails({ item }: { item: DuelPressDetailReadout }) {
  return <><p>원본 값: {item.value === null ? "제공 불가" : `${number(item.value)} ${units[item.unit]}`}</p>{comparisonDetails(item.comparison)}<p>상태: {state[item.state]}</p><p>출처: {source[item.source]}</p><p>방향: {directions[item.direction]}</p>{item.formulaId !== null && item.formulaVersion !== null && <p>계산식: {item.formulaId} (v{item.formulaVersion})</p>}{item.missingComponents?.length ? <p>누락 구성요소: {item.missingComponents.join(", ")}</p> : null}</>;
}

function CategoryDetails({ category }: { category: DuelPressDetailReadoutEnvelope["categories"][number] }) {
  return <>{category.score !== null && <p>서버 점수: {number(category.score)}</p>}{comparisonDetails(category.comparison)}<p>점수 상태: {state[category.scoreState === "observed" ? "observed" : category.scoreState]}</p>{category.imputedComponents.length > 0 && <p>대체 구성요소: {category.imputedComponents.join(", ")}</p>}</>;
}

function MetricRow({ item, spec, reference }: { item: DuelPressDetailReadout; spec: RowSpec; reference: boolean }) {
  const percentile = item.comparison.state === "available" ? formatAuthoritativePercentile(item.comparison.percentile) : null;
  const raw = displayRawValue(item, spec.signed);
  return <div data-readout-id={item.id} className="flex min-w-0 items-baseline justify-between gap-2 text-[11px] leading-normal"><span className="min-w-0 break-words font-normal" style={{ color: COLORS.muted, opacity: reference ? .75 : 1 }}>{spec.label}</span><DetailsTooltip label={`${spec.label} ${raw} ${percentile ?? "—"}`} trigger={<span className="inline-flex items-baseline gap-[7px] whitespace-nowrap"><span className="font-normal tabular-nums" style={{ color: COLORS.text }}>{raw}</span><span className="font-semibold tabular-nums text-[10px]" style={{ color: bandColor(percentile) }}>{percentile ?? "—"}</span></span>}><ReadoutDetails item={item}/></DetailsTooltip></div>;
}

function CategoryCard({ category }: { category: DuelPressDetailReadoutEnvelope["categories"][number] }) {
  const score = formatAuthoritativePercentile(category.score);
  const readouts = new Map(category.readouts.map((item) => [item.id, item]));
  const title = duelPressAxisLabels[category.id];
  return <article data-card="category" data-category-id={category.id} className="flex min-w-0 flex-col gap-[7px]"><div className="flex min-w-0 items-baseline justify-between gap-2 font-bold leading-normal"><h3 className="text-[14px]" style={{ color: COLORS.text }}>{title}</h3><DetailsTooltip label={`${title} 카테고리 ${score ?? "—"}`} trigger={<strong className="text-[16px] font-bold tabular-nums" style={{ color: bandColor(score) }}>{score ?? "—"}</strong>}><CategoryDetails category={category}/></DetailsTooltip></div><div role="progressbar" aria-label={`${title} 점수`} aria-valuemin={0} aria-valuemax={99} {...(score === null ? {} : { "aria-valuenow": score })} className="h-1 w-full max-w-[288px] overflow-hidden rounded-[2px]" style={{ backgroundColor: COLORS.border }}><span className="block h-full rounded-[2px]" style={{ width: `${score ?? 0}%`, backgroundColor: bandColor(score) }}/></div>{CATEGORY_GROUPS[category.id].map((group) => <section key={group.label} aria-label={`${title} ${group.label}`} className="flex min-w-0 flex-col gap-[3px] pt-[6px]"><h4 className="text-[9px] font-semibold leading-normal tracking-[0.7px]" style={{ color: group.kind === "reference" ? COLORS.muted : COLORS.accent, opacity: group.kind === "reference" ? .6 : .9 }}>{group.label}</h4>{group.rows.map((spec) => <MetricRow key={spec.id} item={readouts.get(spec.id)!} spec={spec} reference={group.kind === "reference"}/>)}</section>)}</article>;
}

export type DetailReadoutBoardLayout = "page" | "rail";

export function DuelPressDetailReadoutBoard({ data, layout = "page" }: { data: DuelPressDetailReadoutEnvelope; layout?: DetailReadoutBoardLayout }) {
  const categories = new Map(data.categories.map((category) => [category.id, category]));
  return <section aria-label="Duel press detailed stats board" data-layout-density={layout} className="min-w-0 overflow-hidden rounded-[16px] border px-6 py-[22px] lg:min-h-[900px]" style={{ backgroundColor: COLORS.panel, borderColor: COLORS.border }}><header className="flex min-w-0 items-baseline justify-between gap-2 leading-normal"><h2 className="text-[15px] font-bold" style={{ color: COLORS.text }}>상세 스탯 보드</h2><p className="text-right text-[10px] font-normal" style={{ color: COLORS.muted }}>원시값 · 코호트 백분위 · 각 축 = 볼륨 50% + 비율 50%</p></header><div data-layout="detail-readout-grid" className="mt-4 grid min-w-0 grid-cols-1 items-start gap-[18px] md:grid-cols-3">{CATEGORY_COLUMNS.map((column, index) => <div key={index} data-column={index + 1} className="flex min-w-0 flex-col gap-5">{column.map((id) => <CategoryCard key={id} category={categories.get(id)!}/>)}</div>)}</div><p className="mt-4 text-[9px] font-normal leading-normal" style={{ color: COLORS.muted, opacity: .7 }}>왼쪽은 원시값, 오른쪽 색상 숫자는 동일 시즌·모드·스코프 코호트 백분위입니다. 「참고」 항목은 점수 산식에 직접 들어가지 않습니다.</p></section>;
}

export function DuelPressDetailReadoutUnavailable({ message, onRetry, loading }: { message?: string; onRetry?: () => void; loading?: boolean }) {
  return <section aria-label="Duel press detailed stats board" aria-busy={loading || undefined} className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-4"><h2 className="font-black">상세 스탯 보드 {loading ? "불러오는 중" : "제공 불가"}</h2><p role={loading ? "status" : "alert"} className="mt-2 text-sm text-zinc-300">{loading ? "동일 컨텍스트의 서버 읽기값을 불러오는 중입니다." : message ?? "이 컨텍스트의 상세 스탯 읽기값을 제공할 수 없습니다."}</p>{onRetry && !loading && <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded border border-lime-300/40 px-4 text-sm text-lime-200">상세 스탯 다시 시도</button>}</section>;
}
