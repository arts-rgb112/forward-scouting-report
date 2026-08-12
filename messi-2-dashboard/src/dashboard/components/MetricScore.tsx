import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getScoreBand, metricConfig } from "../scoutingConfig";
import type { MetricKey } from "../types";

type Props = { playerId: number; metric: MetricKey; value: number; surface: "table" | "mobile"; compact?: boolean; snapshot?: boolean };

export function MetricScore({ playerId, metric, value, surface, compact = false, snapshot = false }: Props) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const reactId = useId().replace(/:/g, "");
  const tooltipId = `metric-tooltip-${surface}-${playerId}-${metric}-${reactId}`;
  const help = metricConfig[metric];
  const band = getScoreBand(value);
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

  return <div className="flex justify-center">
    <span ref={triggerRef} tabIndex={0} aria-describedby={tooltipId} aria-label={`${help.label} ${value}점, ${band.label}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} className={`inline-flex min-w-10 items-center justify-center rounded-md border px-2 font-mono text-[13px] font-bold outline-none focus-visible:ring-2 focus-visible:ring-[#8cff68] ${compact ? "h-9" : "h-8"} ${band.className}`}>{value}</span>
    {open && typeof document !== "undefined" && createPortal(<div ref={tooltipRef} id={tooltipId} role="tooltip" style={{ left: position.left, top: position.top }} className="pointer-events-none fixed z-[100] w-56 rounded-lg border border-white/10 bg-[#0a0d0f] p-3 text-left shadow-2xl"><div className="mb-1 flex items-center justify-between"><b className="text-xs text-white">{help.label}</b><span className="text-sm font-black text-[#aaf06b]">{value}/100</span></div><p className="text-[11px] leading-4 text-zinc-400">{snapshot ? "Stored score at save time. It is not re-ranked against current server data." : help.detail}</p></div>, document.body)}
  </div>;
}
