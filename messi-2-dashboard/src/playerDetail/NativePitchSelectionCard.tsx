import { useState, type ReactNode } from "react";
import type { NativePitchEventV2, NativePitchEventsV2Envelope } from "../api/nativePitchEventsV2Contracts";
import type { AnatomicalShotCount, AnatomicalShotPart } from "./AnatomicalShotFigure";
import { PitchSelectionCard } from "./PitchSelectionCard";

type ZoneSelection = { kind: "box" | "grid"; id: string } | null;
const unavailable = { delta: null, state: "unavailable" as const };
const empty: AnatomicalShotCount = { shots: null, goals: null, quality: unavailable };
const partLabel = { head: "헤더", leftFoot: "왼발", rightFoot: "오른발", other: "기타", unknown: "부위 미상" };
const outcomeLabel = { goal: "득점", on_target: "유효 슛", off_target: "빗나감", blocked: "블록" };

/** Selects fields, never aggregates events or recalculates a public metric. */
export function NativePitchSelectionCard({ data, event, zone: selection, controls, onClose }: {
  data: NativePitchEventsV2Envelope;
  event?: NativePitchEventV2;
  zone: ZoneSelection;
  controls: ReactNode;
  onClose: () => void;
}) {
  const [focusedPart, setFocusedPart] = useState<AnatomicalShotPart | null>(null);
  const zone = selection ? data.selectionZones[selection.kind].find(item => item.id === selection.id) : undefined;
  const kind = event ? "shot" : selection ? "zone" : "overview";
  const aggregate = zone ?? (!selection ? data.bodyParts : undefined);
  const counts = aggregate?.parts;
  const parts: Record<AnatomicalShotPart, AnatomicalShotCount> = {
    head: event ? empty : counts?.head ?? empty,
    rightFoot: event ? empty : counts?.rightFoot ?? empty,
    leftFoot: event ? empty : counts?.leftFoot ?? empty,
  };
  const eventPart = event && (event.bodyPart === "head" || event.bodyPart === "leftFoot" || event.bodyPart === "rightFoot") ? event.bodyPart : null;
  // One selected record, not a rollup or a cross-provider join.
  if (event && eventPart) parts[eventPart] = { shots: 1, goals: event.outcome === "goal" ? 1 : 0, quality: event.quality };
  const totals = zone ?? (!selection ? data.bodyParts.totals : undefined);
  return <PitchSelectionCard kind={kind}
    title={event ? `${outcomeLabel[event.outcome]} · ${partLabel[event.bodyPart]}` : zone?.label ?? (selection ? "구역 통계 사용 불가" : "전체 슈팅")}
    sourceLabel={`SportsAPI · ${selection?.kind === "box" || !data.includePenalties ? "PK 제외" : "PK 포함"}`}
    selectedPart={event ? eventPart : focusedPart} parts={parts}
    onPartSelect={part => { if (!event) setFocusedPart(current => current === part ? null : part); }}
    quality={event?.quality ?? totals?.quality ?? unavailable}
    shots={event ? 1 : totals?.shots ?? null} goals={event ? (event.outcome === "goal" ? 1 : 0) : totals?.goals ?? null}
    xg={event ? event.xg : zone?.xg ?? null}
    shootingSharePct={zone?.shootingSharePct ?? null}
    onClose={event || selection ? onClose : undefined}
    controls={controls}
    details={<>
      {event ? <>
        <p data-native-pitch-event-bodypart>{partLabel[event.bodyPart]} · xG {event.xg ?? "—"} · xGOT {event.xgot ?? "—"}</p>
        <p>{event.destination.kind === "unavailable" ? "관측 종점 없음 · 궤적 미표시" : "원천 평면 좌표 · 높이와 중간 경로는 모식 표현"}</p>
      </> : <>
        <p>기타 {counts?.other.shots ?? "—"}슛 · 부위 미상 {counts?.unknown.shots ?? "—"}슛</p>
        <p>활동 비중은 별도 활동 원천이므로 이 슈팅 집계에 합치지 않습니다.</p>
        <p>품질 적격 {totals?.quality.eligible ?? "—"} / {totals?.shots ?? "—"}</p>
      </>}
      <p>원천 수집: {data.bodyParts.completeness === "complete" ? "완전" : data.bodyParts.completeness === "partial" ? "일부" : "미관측"}</p>
    </>} />;
}
