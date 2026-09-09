import type { ReactNode } from "react";
import { AnatomicalShotFigure, type AnatomicalShotCount, type AnatomicalShotPart } from "./AnatomicalShotFigure";

export interface PitchSelectionCardProps {
  kind: "shot" | "zone" | "overview";
  title: string;
  sourceLabel: string;
  selectedPart: AnatomicalShotPart | null;
  parts: Record<AnatomicalShotPart, AnatomicalShotCount>;
  onPartSelect: (part: AnatomicalShotPart) => void;
  quality: { delta: number | null; state: "complete" | "partial" | "unavailable" };
  shots: number | null;
  goals: number | null;
  xg: number | null;
  activitySharePct?: number | null;
  shootingSharePct?: number | null;
  onClose?: () => void;
  controls?: ReactNode;
  details?: ReactNode;
}

const LABELS = { head: "헤더", rightFoot: "오른발", leftFoot: "왼발" };
const metric = (value: number | null) => value === null ? "—" : value.toFixed(2);
const percent = (value: number | null | undefined) => value == null ? "—" : `${value.toFixed(1)}%`;

/** One presentation surface. Its caller supplies server-owned selection data. */
export function PitchSelectionCard(props: PitchSelectionCardProps) {
  const { kind, title, sourceLabel, selectedPart, parts, onPartSelect, quality, shots, goals, xg,
    activitySharePct, shootingSharePct, onClose, controls, details } = props;
  const qualityText = quality.state === "unavailable" || quality.delta === null
    ? "—" : `${quality.delta >= 0 ? "+" : ""}${quality.delta.toFixed(2)}`;
  return <section aria-label="선택한 피치 정보" data-pitch-selection-card={kind}
    className="overflow-hidden rounded-2xl border border-[#526078]/45 bg-[#172131]/95 text-[#e8edf3] shadow-2xl backdrop-blur-md">
    <header className="flex items-start justify-between gap-3 px-4 pt-4">
      <div><p className="text-xs tracking-wide text-[#a9b8c9]">{sourceLabel}</p>
        <h3 className="mt-1 text-base font-semibold">{title}</h3></div>
      {onClose && <button type="button" aria-label="선택 해제" onClick={onClose}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 text-xl hover:bg-white/10 focus-visible:outline focus-visible:outline-2">×</button>}
    </header>
    <div className="mx-4 mt-3 flex items-end justify-between border-b border-white/10 pb-3">
      <div><p className="text-xs text-[#a9b8c9]">슈팅 퀄리티</p>
        <p data-selection-quality={quality.state} className="mt-1 font-mono text-3xl font-semibold tracking-tight text-[#f8a4ac]">{qualityText}</p></div>
      <div className="text-right text-xs text-[#a9b8c9]">xGOT − xG
        {quality.state === "partial" && <p className="mt-1 text-amber-200">일부 표본</p>}</div>
    </div>
    <AnatomicalShotFigure selectedPart={selectedPart} onSelect={onPartSelect} counts={parts}
      labels={LABELS} title={`${title} · 슈팅 부위`} className="px-2 pt-2" />
    <div className="px-4 pb-4">
      <dl className="grid grid-cols-3 gap-3 border-t border-white/10 pt-3">
        {[["슛", shots ?? "—"], ["득점", goals ?? "—"], ["xG", metric(xg)]].map(([label, value]) =>
          <div key={label}><dt className="text-xs text-[#a9b8c9]">{label}</dt><dd className="mt-1 font-mono text-lg font-semibold">{value}</dd></div>)}
      </dl>
      {kind !== "shot" && <dl className="mt-3 space-y-2 text-xs">
        <div className="flex justify-between"><dt className="text-[#a9b8c9]">활동 비중</dt><dd className="font-mono">{percent(activitySharePct)}</dd></div>
        <div className="flex justify-between"><dt className="text-[#a9b8c9]">슈팅 비중</dt><dd className="font-mono">{percent(shootingSharePct)}</dd></div>
      </dl>}
      {controls && <div className="mt-3 border-t border-white/10 pt-3">{controls}</div>}
      {details && <details className="mt-3 text-xs text-[#a9b8c9]"><summary className="cursor-pointer">기록·표본 상세</summary><div className="mt-2 space-y-1">{details}</div></details>}
    </div>
  </section>;
}
