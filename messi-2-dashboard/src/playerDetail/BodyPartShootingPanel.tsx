import { useState } from "react";
import { AnatomicalShotFigure, type AnatomicalShotPart } from "./AnatomicalShotFigure";
import type { NativeBodyPartStatsState } from "./useNativeBodyPartStats";

/**
 * Top-right anatomical shooting-quality panel (3D pitch dock).
 *
 * Owner design correction (2026-09-08): the anatomical figure IS the primary
 * interface, not a decorative icon beside a repeating number grid — "숫자
 * 나열은 잘 안 읽는다" ("people don't read number lists"). Head/rightFoot/
 * leftFoot counts anchor directly onto the body via `AnatomicalShotFigure`
 * (candidate authored separately per messi-specs/BODY_UI_VISUAL_GATE_20260908.md,
 * reviewed and integrated here — presentation only, no data logic of its own).
 * other/unknown cannot be placed on a body without guessing a location, so
 * they stay compact, explicit, and visually separate from the figure.
 *
 * Counts (and, since 2026-09-08 revision2, each part's own xGOT−xG
 * `quality`) come from the server-owned `native-body-part-stats-v2`
 * AGGREGATE across the whole selected context. That aggregate cannot be
 * joined to any individual FotMob shot event — `ShotmapPoint` still has no
 * `bodyPart` field, and there is no shared key between the two sources.
 * Selecting a body region on the figure is an AGGREGATE selection unless
 * `selectedBodyPart` is provided by the same native-pitch-events bundle. A
 * FotMob marker never supplies that prop: the panel then says explicitly
 * that no cross-provider event attribution exists.
 *
 * Front-view: screen-left is the anatomical RIGHT foot (AnatomicalShotFigure
 * keeps this itself). Loading / fetch-error / genuinely-source-unavailable
 * are three different situations and must read as three different messages.
 */
export type BodyPartRegionId = "head" | "rightFoot" | "leftFoot" | "other" | "unknown";

const FIGURE_LABELS: Record<AnatomicalShotPart, string> = { head: "헤더", rightFoot: "오른발", leftFoot: "왼발" };
const NATIVE_SELECTED_LABEL: Record<BodyPartRegionId, string> = { ...FIGURE_LABELS, other: "기타", unknown: "부위 미상" };
const OFF_BODY_REGIONS: { id: "other" | "unknown"; label: string }[] = [
  { id: "other", label: "기타" },
  { id: "unknown", label: "부위 미상" },
];

export function BodyPartShootingPanel({ hasSelectedShot, selectedBodyPart, state }: { hasSelectedShot: boolean; selectedBodyPart?: BodyPartRegionId; state?: NativeBodyPartStatsState }) {
  const [selectedPart, setSelectedPart] = useState<AnatomicalShotPart | null>(null);
  // A ready hook state only proves the HTTP round-trip succeeded — a real
  // 200 envelope can still be `completeness: "unavailable"` with every
  // total/part null (a known player with no observed native-body-part
  // source). That is a genuinely different situation from "still loading"
  // or "the request itself failed" and must say so distinctly — printing
  // literal null values, or collapsing all three into one generic message,
  // are both dishonest here.
  const envelope = state?.kind === "ready" ? state.data : undefined;
  const ready = envelope && envelope.totals.shots !== null ? envelope : undefined;
  const panelState = ready ? "ready" : "unavailable";
  const unavailableReason: "loading" | "error" | "source-unavailable" = ready ? "error" :
    state?.kind === "loading" ? "loading" : envelope ? "source-unavailable" : "error";

  const unobservedPart = { shots: null, goals: null, quality: undefined };
  const selectedAnatomicalPart: AnatomicalShotPart | null = selectedBodyPart === "head" || selectedBodyPart === "rightFoot" || selectedBodyPart === "leftFoot" ? selectedBodyPart : null;
  // A selected native unknown/other shot must clear the
  // previous aggregate-body highlight, not inherit it through ?? fallback.
  const effectiveSelectedPart = hasSelectedShot && selectedBodyPart !== undefined ? selectedAnatomicalPart : selectedPart;
  const figureCounts: Record<AnatomicalShotPart, { shots: number | null; goals: number | null; quality?: { delta: number | null; state: "complete" | "partial" | "unavailable" } }> = {
    head: ready?.parts.head ?? unobservedPart,
    rightFoot: ready?.parts.rightFoot ?? unobservedPart,
    leftFoot: ready?.parts.leftFoot ?? unobservedPart,
  };
  const offBodyTotal = ready ? (ready.parts.other.shots ?? 0) + (ready.parts.unknown.shots ?? 0) : 0;

  return (
    <section aria-label="신체 부위 슈팅 분석" data-bodypart-panel data-bodypart-state={panelState}
      className="rounded border border-white/20 bg-[#1d2637]/95 p-2.5 text-zinc-100">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-white/85">신체 부위 슈팅</h3>
        {ready && (
          <span className="rounded-full border border-white/20 px-1.5 py-0.5 text-[10px] text-white/55">
            {ready.includePenalties ? "PK 포함" : "PK 제외"}
          </span>
        )}
      </div>

      {/* Read order the visual gate asks for: body → its own key numbers →
          detail on demand. The attribution note stays visible up front since
          it is exactly the one thing this panel must never get wrong. */}
      <p data-bodypart-attribution-note className="mt-1 text-[10px] leading-relaxed text-white/50">
        {hasSelectedShot && selectedBodyPart ? `선택한 실제 기록 슛의 부위: ${NATIVE_SELECTED_LABEL[selectedBodyPart]}` : hasSelectedShot ? "선택한 슛의 신체 부위: 확인 불가 (아래는 선수 전체 집계)" : "선수 전체 집계 — 개별 슛 부위와 연결되지 않음"}
      </p>

      <AnatomicalShotFigure
        className="mt-2"
        title="슈팅 부위 선택"
        selectedPart={effectiveSelectedPart}
        onSelect={(part) => setSelectedPart((current) => current === part ? null : part)}
        counts={figureCounts}
        labels={FIGURE_LABELS}
      />

      {effectiveSelectedPart && (
        (() => { const part = effectiveSelectedPart; return (<p data-bodypart-selected-part={part} className="mt-1 text-[10px] leading-relaxed text-amber-200/80">
          {selectedAnatomicalPart ? `${FIGURE_LABELS[part]} — 선택한 실제 기록 슛의 부위` : `${FIGURE_LABELS[part]} 집계 선택됨 — 이 부위로 기록된 개별 슛을 가리키지 않음`}
        </p>); })()
      )}

      {ready && (
        <>
          <p className="mt-2 border-t border-white/15 pt-1.5 font-mono text-[11px] text-white/70" data-bodypart-totals>
            합계 {ready.totals.shots}슛 · {ready.totals.goals}골
            {ready.completeness !== "complete" && (
              <span className="ml-1 text-amber-200/80" data-bodypart-source-partial-badge>{ready.completeness === "partial" ? "부분 자료 — 일부 소스만 관측, 부분 합계" : ""}</span>
            )}
            {/* A compact always-visible badge so genuine uncertainty (any
                other/unknown shots at all) is never silently hidden behind
                the disclosure below — only the numeric breakdown moves there. */}
            {offBodyTotal > 0 && <span className="ml-1 text-white/50" data-bodypart-offbody-badge>· 기타·미상 {offBodyTotal}건</span>}
          </p>
          <details className="mt-1 text-[10px] text-white/50">
            <summary className="cursor-pointer select-none text-white/60">상세 (기타·부위 미상·출처)</summary>
            {/* other/unknown cannot be anchored to a body region without
                guessing a location, so they stay explicit and visibly
                off-body — but as detail-on-demand, not an always-open
                number wall next to the figure. */}
            <div className="mt-1 flex gap-2" role="group" aria-label="부위 미상·기타 슈팅">
              {OFF_BODY_REGIONS.map((region) => {
                const counts = ready.parts[region.id];
                const available = counts.shots !== null;
                return (
                  <div key={region.id} data-bodypart-region={region.id}
                    className="flex-1 rounded border border-white/10 bg-white/5 px-2 py-1.5">
                    <p className="text-[10px] text-white/55">{region.label}</p>
                    <p className="font-mono text-xs font-semibold tracking-tight" data-bodypart-value={available ? "ready" : "unavailable"}>
                      {available ? `${counts.shots}슛 · ${counts.goals}골` : "—"}
                    </p>
                  </div>
                );
              })}
            </div>
            {/* Paired xG/xGOT sums, eligible/shots coverage, and the definition
                itself — the figure's own callout stays to one short "퀄리티
                ±X.XX" line, this is where the reader can see exactly what
                that number is built from. */}
            <div className="mt-2 space-y-1" data-bodypart-quality-detail>
              <p className="text-white/55">xGOT−xG = 페어링된 슛의 xGOT 합 − xG 합(부위별 표본 내 관측치만)</p>
              {(["head", "rightFoot", "leftFoot"] as const).map((part) => {
                const counts = ready.parts[part];
                const quality = counts.quality;
                const label = FIGURE_LABELS[part];
                if (quality.state === "unavailable") return <p key={part}>{label}: 페어링 관측 불가 (eligible 0/{counts.shots ?? "—"})</p>;
                return (
                  <p key={part} data-bodypart-quality-detail-row={part}>
                    {label}: xG {quality.xg!.toFixed(2)} · xGOT {quality.xgot!.toFixed(2)} · eligible {quality.eligible}/{counts.shots}
                    {quality.state === "partial" && <span className="text-amber-200/80"> · 일부 표본</span>}
                  </p>
                );
              })}
            </div>
            <p className="mt-2" data-bodypart-source>
              출처 SportsAPI · {ready.context.season} · {ready.context.mode === "league" ? `리그 ${ready.context.scope}개` : ready.context.competition!.toUpperCase()}
            </p>
            {ready.completeness === "partial" && (
              <ul className="mt-1 space-y-0.5" data-bodypart-source-coverage>
                {ready.sources.map((source) => (
                  <li key={source.mappingKey}>
                    {source.competition} · {source.coverage.state === "unavailable" ? "관측 불가" : `유효 ${source.coverage.validMatchIds.length}/${source.coverage.expectedMatchIds.length}`}
                    {source.coverage.missingMatchIds.length > 0 && <span> · 누락 {source.coverage.missingMatchIds.length}</span>}
                    {source.coverage.invalidMatchIds.length > 0 && <span> · 무효 {source.coverage.invalidMatchIds.length}</span>}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}
      {panelState === "unavailable" && (
        <div className="mt-2 border-t border-white/15 pt-1.5" data-bodypart-unavailable-reason={unavailableReason}>
          {unavailableReason === "loading" ? (
            <p role="status" className="text-[10px] leading-relaxed text-white/60">신체 부위 데이터를 불러오는 중입니다.</p>
          ) : unavailableReason === "source-unavailable" ? (
            <>
              <p className="text-[10px] leading-relaxed text-amber-200/90">
                {envelope!.sources.length === 0
                  ? "이 선수는 매핑된 신체 부위 소스가 없습니다 — 네트워크 오류가 아니라 원천 미보유입니다."
                  : "매핑된 소스는 있으나 현재 관측 불가합니다. 추정·0 대체 없음."}
              </p>
              {envelope!.sources.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[10px] text-white/50">
                  {envelope!.sources.map((source) => <li key={source.mappingKey}>{source.competition} · 관측 불가</li>)}
                </ul>
              )}
            </>
          ) : (
            <p className="text-[10px] leading-relaxed text-amber-200/90">
              신체 부위 정보를 불러오지 못했습니다. 추정·0 대체 없음.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
