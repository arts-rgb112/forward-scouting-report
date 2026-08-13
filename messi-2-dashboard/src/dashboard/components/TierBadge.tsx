import { resolveTierPresentation } from "../scoutingConfig";
import type { Tier } from "../types";

/** Full text is intentionally retained even in dense tables to make the taxonomy transition unambiguous. */
export function TierBadge({ tier, compact: _compact = false }: { tier: Tier; compact?: boolean }) {
  const presentation = resolveTierPresentation(tier);
  return <span aria-label={`Overall M.E.S.S.I. tier: ${presentation.label}, level ${tier.level}`} className={`inline-flex max-w-full items-center justify-center gap-1 rounded border px-1.5 py-1 font-mono text-[9px] font-bold leading-tight ${presentation.className}`} title={presentation.tooltip}>
    <span aria-hidden="true">{presentation.glyph}</span><span className="whitespace-nowrap">{presentation.label}</span><span className="whitespace-nowrap">Lv.{tier.level}</span>
  </span>;
}
