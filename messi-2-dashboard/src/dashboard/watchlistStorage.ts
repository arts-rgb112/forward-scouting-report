export const WATCHLIST_KEY = "messi-2-watchlist";

export function parseWatchlist(raw: string | null, validIds: ReadonlySet<number>): number[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is number => Number.isInteger(id) && validIds.has(id)))];
  } catch { return []; }
}

export function readWatchlist(validIds: ReadonlySet<number>): number[] {
  if (typeof window === "undefined") return [];
  try { return parseWatchlist(window.localStorage.getItem(WATCHLIST_KEY), validIds); } catch { return []; }
}

export function writeWatchlist(ids: readonly number[]): boolean {
  if (typeof window === "undefined") return false;
  try { window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...new Set(ids)])); return true; } catch { return false; }
}
