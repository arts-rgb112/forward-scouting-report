import { useEffect, useState } from "react";
export type AssetKind = "face" | "nation" | "league" | "club";
type Props = { src: string | null; alt: string; kind: AssetKind; fallbackLabel: string; className?: string; width: number; height: number; loading?: "eager" | "lazy" };
export function AssetImage({ src, alt, kind, fallbackLabel, className = "", width, height, loading = "lazy" }: Props) {
  const [failed, setFailed] = useState(!src); useEffect(() => setFailed(!src), [src]);
  if (failed) { const text = kind === "face" ? fallbackLabel.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() : fallbackLabel.slice(0, 2).toUpperCase(); const classes = `inline-grid shrink-0 place-items-center overflow-hidden border border-white/15 bg-white/[.06] font-mono type-caption font-black text-zinc-400 ${kind === "face" ? "rounded-md" : "rounded-sm"} ${className}`; return alt ? <span role="img" aria-label={alt} style={{ width, height }} className={classes}>{text || "?"}</span> : <span aria-hidden="true" style={{ width, height }} className={classes}>{text || "?"}</span>; }
  return <img src={src!} alt={alt} width={width} height={height} loading={loading} decoding="async" onError={() => setFailed(true)} className={className} />;
}
