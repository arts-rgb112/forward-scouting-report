import type { DatasetMeta } from "../types";

export function DatasetFooter({ meta, resultRange }: { meta: DatasetMeta; resultRange: string }) {
  return <footer className="mt-3 flex flex-wrap justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-4 py-3 text-[10px] uppercase tracking-widest text-zinc-600">
    <span>{resultRange} players · {meta.returned} returned on this page</span>
    <span>{meta.source} · schema {meta.schemaVersion} · {new Date(meta.generatedAt).toLocaleString()}</span>
  </footer>;
}
