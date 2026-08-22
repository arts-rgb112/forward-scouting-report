import type { AgeBand, MinutesBand } from "./types";
import type { WatchlistV3Entry } from "./watchlistV3Contracts";
import { textComparisonKey } from "./textComparisonKey";

export const WATCHLIST_V3_PAGE_SIZE = 50;
export type WatchlistV3MetricSort = "outsideShot" | "boxThreat" | "dangerZone" | "aerial" | "groundDuel" | "combinedDuel" | "spaceControl" | "forwardPress";
export type WatchlistV3CommonSort = "savedAt" | "name" | "score" | "age" | "minutes" | WatchlistV3MetricSort;
export type WatchlistV3Filters = { query: string; role: "ALL" | "Type A" | "Type B"; position: string; ageBand: AgeBand; minutesBand: MinutesBand; sort: WatchlistV3CommonSort; direction: "asc" | "desc" };
export const defaultWatchlistV3Filters: WatchlistV3Filters = { query: "", role: "ALL", position: "ALL", ageBand: "all", minutesBand: "all", sort: "savedAt", direction: "desc" };

export function watchlistV3Profile(entry: WatchlistV3Entry) {
  return entry.taxonomy === "duel-press-v1"
    ? { name: entry.snapshot.name, clubName: entry.snapshot.club.name, leagueName: entry.snapshot.league.name, position: entry.snapshot.position, archetype: entry.snapshot.archetype, age: entry.snapshot.age, minutes: entry.snapshot.minutes, score: entry.snapshot.score, stats: entry.snapshot.stats }
    : { name: entry.snapshot.name, clubName: entry.snapshot.clubName, leagueName: entry.snapshot.leagueName, position: entry.snapshot.position, archetype: entry.snapshot.archetype, age: entry.snapshot.age, minutes: entry.snapshot.minutes, score: entry.snapshot.score, stats: entry.snapshot.stats };
}
function ageMatches(age: number | null | undefined, band: AgeBand) { if (band === "all") return true; if (age == null) return false; if (band === "u23") return age <= 22; if (band === "23-25") return age >= 23 && age <= 25; if (band === "26-30") return age >= 26 && age <= 30; return age >= 31; }
function minutesMatches(minutes: number | undefined, band: MinutesBand) { if (band === "all") return true; if (minutes == null) return false; if (band === "200-499") return minutes >= 200 && minutes <= 499; if (band === "500-999") return minutes >= 500 && minutes <= 999; if (band === "1000-1499") return minutes >= 1000 && minutes <= 1499; if (band === "1500-1999") return minutes >= 1500 && minutes <= 1999; if (band === "2000-2999") return minutes >= 2000 && minutes <= 2999; return minutes >= 3000; }
function nullableNumber(left: number | null | undefined, right: number | null | undefined, direction: "asc" | "desc") { if (left == null && right == null) return 0; if (left == null) return 1; if (right == null) return -1; return direction === "asc" ? left - right : right - left; }

export function filterAndSortWatchlistV3(entries: readonly WatchlistV3Entry[], filters: WatchlistV3Filters): WatchlistV3Entry[] {
  const needle = textComparisonKey(filters.query);
  const filtered = entries.filter((entry) => {
    const profile = watchlistV3Profile(entry); const searchable = textComparisonKey(`${profile.name} ${profile.clubName} ${profile.leagueName ?? ""} ${profile.position} ${entry.context.season} ${entry.context.mode} ${entry.context.scope ?? ""} ${entry.context.competition}`);
    return (!needle || searchable.includes(needle)) && (filters.role === "ALL" || profile.archetype === filters.role) && (filters.position === "ALL" || profile.position === filters.position) && ageMatches(profile.age, filters.ageBand) && minutesMatches(profile.minutes, filters.minutesBand);
  });
  return filtered.slice().sort((left, right) => {
    const a = watchlistV3Profile(left); const b = watchlistV3Profile(right); let comparison = 0;
    if (filters.sort === "savedAt") comparison = filters.direction === "asc" ? Date.parse(left.savedAt) - Date.parse(right.savedAt) : Date.parse(right.savedAt) - Date.parse(left.savedAt);
    else if (filters.sort === "name") comparison = a.name.localeCompare(b.name) * (filters.direction === "asc" ? 1 : -1);
    else if (filters.sort === "score" || filters.sort === "age" || filters.sort === "minutes") comparison = nullableNumber(filters.sort === "score" ? a.score : filters.sort === "age" ? a.age : a.minutes, filters.sort === "score" ? b.score : filters.sort === "age" ? b.age : b.minutes, filters.direction);
    else comparison = nullableNumber((a.stats as Partial<Record<WatchlistV3MetricSort, number>> | undefined)?.[filters.sort], (b.stats as Partial<Record<WatchlistV3MetricSort, number>> | undefined)?.[filters.sort], filters.direction);
    return comparison || left.key.localeCompare(right.key);
  });
}

export function watchlistV3Page(entries: readonly WatchlistV3Entry[], filters: WatchlistV3Filters, requestedPage: number) {
  const filtered = filterAndSortWatchlistV3(entries, filters); const totalPages = Math.max(1, Math.ceil(filtered.length / WATCHLIST_V3_PAGE_SIZE)); const page = Math.min(Math.max(1, requestedPage), totalPages);
  const visible = filtered.slice((page - 1) * WATCHLIST_V3_PAGE_SIZE, page * WATCHLIST_V3_PAGE_SIZE); const start = visible.length ? (page - 1) * WATCHLIST_V3_PAGE_SIZE + 1 : 0;
  return { filtered, visible, page, totalPages, total: filtered.length, start, end: visible.length ? start + visible.length - 1 : 0 };
}
