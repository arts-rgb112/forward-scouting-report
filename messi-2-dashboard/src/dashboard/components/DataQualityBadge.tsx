import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { qualityReasonKorean, type QualityDisplay } from "../dataQualityViewModel";

type Props = { quality?: QualityDisplay; placement?: "score" | "metric" };

/** A non-button trigger so it can safely sit next to links, table cells, and score controls. */
export function DataQualityBadge({ quality, placement = "score" }: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null); const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const [position, setPosition] = useState({ left: 8, top: 8 });
  const id = `quality-tooltip-${useId().replace(/:/g, "")}`;
  const isIncomplete = quality?.kind === "incomplete"; const isUnknown = quality?.kind === "unknown";
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect(); if (!rect) return;
    const tip = tooltipRef.current?.getBoundingClientRect(); const width = tip?.width || 240; const height = tip?.height || 104;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const desiredTop = rect.top >= height + 16 ? rect.top - height - 8 : rect.bottom + 8;
    setPosition({ left, top: Math.max(8, Math.min(window.innerHeight - height - 8, desiredTop)) });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => { if (!open) return; const close = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false); window.addEventListener("resize", place); window.addEventListener("scroll", place, true); window.addEventListener("keydown", close); return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.removeEventListener("keydown", close); }; }, [open, place]);
  if (!isIncomplete && !isUnknown) return null;
  const label = isIncomplete ? "데이터 일부 대체" : "품질 정보 확인 불가";
  const detail = isIncomplete ? <><p>관측 데이터 비중: {quality.dataQuality.observedWeightPct}%</p><p>대체값 하한: {quality.dataQuality.fallbackComponentScore}</p><p>{qualityReasonKorean[quality.dataQuality.reason]}</p></> : <p>현재 이 데이터의 품질 정보를 확인할 수 없습니다.</p>;
  return <><span ref={triggerRef} tabIndex={0} aria-describedby={id} aria-label={label} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} className={`inline-flex cursor-help rounded border px-1 py-0.5 text-[9px] font-bold leading-none outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68] ${placement === "metric" ? "ml-1" : "ml-2"} ${isIncomplete ? "border-amber-300/35 bg-amber-300/10 text-amber-100" : "border-zinc-300/35 bg-zinc-300/10 text-zinc-200"}`}>{label}</span>
    {open && typeof document !== "undefined" && createPortal(<div ref={tooltipRef} id={id} role="tooltip" style={{ left: position.left, top: position.top }} className="pointer-events-none fixed z-[100] w-60 rounded-lg border border-white/10 bg-[#0a0d0f] p-3 text-left text-[11px] leading-4 text-zinc-300 shadow-2xl">{detail}</div>, document.body)}
  </>;
}
