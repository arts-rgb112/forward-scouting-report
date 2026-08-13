import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getScoreBand, metricConfig } from "../scoutingConfig";
import type { MetricKey } from "../types";
import type { QualityDisplay } from "../dataQualityViewModel";
import { metricIsImputed } from "../dataQualityViewModel";

type Props = { playerId: number; metric: MetricKey; value: number; surface: "table" | "mobile"; compact?: boolean; snapshot?: boolean; quality?: QualityDisplay };

export function MetricScore({ playerId, metric, value, surface, compact = false, snapshot = false, quality }: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const reactId = useId().replace(/:/g, "");
  const tooltipId = `metric-tooltip-${surface}-${playerId}-${metric}-${reactId}`;
  const help = metricConfig[metric];
  const band = getScoreBand(value);
  const imputed = metricIsImputed(quality, metric);
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tooltipRect = tooltipRef.current?.getBoundingClientRect();
    const width = tooltipRect?.width || 224;
    const height = tooltipRect?.height || 96;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const above = rect.top - 8;
    const below = window.innerHeight - rect.bottom - 8;
    const placeAbove = above >= height || above > below;
    const desiredTop = placeAbove ? rect.top - height - 8 : rect.bottom + 8;
    const top = Math.max(8, Math.min(Math.max(8, window.innerHeight - height - 8), desiredTop));
    setPosition({ left, top });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    place();
    const close = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true); window.addEventListener("keydown", close);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.removeEventListener("keydown", close); };
  }, [open, place]);

  // Preserve the exact established DOM path when no companion quality was supplied.
  if (!imputed) return <div className="flex justify-center">
    <span ref={triggerRef} tabIndex={0} aria-describedby={tooltipId} aria-label={`${help.label} ${value}점, ${band.label}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} className={`inline-flex min-w-10 items-center justify-center rounded-md border px-2 font-mono text-[13px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68] ${compact ? "h-9" : "h-8"} ${band.className}`}>{value}</span>
    {open && typeof document !== "undefined" && createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip" style={{ left: position.left, top: position.top }} className="pointer-events-none fixed z-[100] w-56 rounded-lg border border-white/10 bg-[#0a0d0f] p-3 text-left shadow-2xl"><div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs text-white">{help.label}</b><span className={`rounded border px-1.5 py-0.5 text-[10px] font-black ${band.className}`}>{value}/100 · {band.rangeLabel}</span></div><p className="text-[11px] leading-4 text-zinc-400">{snapshot ? "Stored score at save time. It is not re-ranked against current server data." : help.detail}</p></div>, document.body)}
  </div>;
  return <div className="flex flex-col items-center justify-center gap-0.5">
    <span ref={triggerRef} tabIndex={0} aria-describedby={tooltipId} aria-label={`${help.label} ${value}, 대체값 포함`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} className={`inline-flex min-w-10 items-center justify-center rounded-md border px-2 font-mono text-[13px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68] ${compact ? "h-9" : "h-8"} ${band.className}`}>{value}</span>
    <span className="rounded border border-amber-300/35 bg-amber-300/10 px-1 text-[9px] font-bold leading-4 text-amber-100">대체값</span>
    {open && typeof document !== "undefined" && createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip" style={{ left: position.left, top: position.top }} className="pointer-events-none fixed z-[100] w-56 rounded-lg border border-white/10 bg-[#0a0d0f] p-3 text-left shadow-2xl"><div className="mb-1 flex items-center justify-between gap-2"><b className="text-xs text-white">{help.label}</b><span className={`rounded border px-1.5 py-0.5 text-[10px] font-black ${band.className}`}>{value}/100</span></div><p className="text-[11px] leading-4 text-zinc-400">이 능력치에는 대체값이 포함됩니다. 관측 데이터 비중: {quality?.kind === "incomplete" ? quality.dataQuality.observedWeightPct : 0}%.</p></div>, document.body)}
  </div>;
}
