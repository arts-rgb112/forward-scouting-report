import type { DatasetRouteState } from "../dashboard/types";

export const LEGACY_ORIGIN = "https://forward-scouting-report-fd4zfq2gjrr5ladifytpcq.streamlit.app" as const;
const scopes = new Set([3, 5, 7, 8]);
const competitions = new Set(["all", "ucl", "uel", "uecl"]);

/** The persisted fields required by Streamlit's contextual Compare handoff. */
export type LegacyCompareEntry = {
  playerId: number;
  snapshot: { name: string; clubName: string };
  context: {
    season: string;
    mode: "league" | "europe";
    scope: 3 | 5 | 7 | 8 | null;
    competition: "all" | "ucl" | "uel" | "uecl" | null;
  };
};

export function legacyHandoffEnabled(env: Record<string, string | boolean | undefined> = import.meta.env): boolean {
  return env.VITE_LEGACY_HANDOFF_ENABLED === "true";
}

export function legacySeason(season: string): string | null {
  const match = /^(\d{4})\/(\d{4})$/.exec(season);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return `${match[1].slice(2)}/${match[2].slice(2)}`;
}

function legacyUrl(query: URLSearchParams): string { return `${LEGACY_ORIGIN}/?${query.toString()}`; }
export function legacyDetailHref(playerId: number, player: { name: string; clubName: string }, dataset: DatasetRouteState): string | null {
  const season = legacySeason(dataset.season);
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || !season) return null;
  const query = new URLSearchParams({ page: "detail", player: String(playerId), name: player.name, team: player.clubName, season, mode: dataset.mode });
  if (dataset.mode === "league") {
    if (!scopes.has(dataset.scope)) return null;
    query.set("scope", String(dataset.scope));
  } else {
    if (!competitions.has(dataset.competition)) return null;
    query.set("competition", dataset.competition);
  }
  return legacyUrl(query);
}
function appendCompareContext(query: URLSearchParams, side: "left" | "right", entry: LegacyCompareEntry): boolean {
  const season = legacySeason(entry.context.season);
  if (!Number.isSafeInteger(entry.playerId) || entry.playerId <= 0 || !season) return false;

  query.set(`${side}_player`, String(entry.playerId));
  query.set(`${side}_name`, entry.snapshot.name);
  query.set(`${side}_team`, entry.snapshot.clubName);
  query.set(`${side}_season`, season);
  query.set(`${side}_mode`, entry.context.mode);
  if (entry.context.mode === "league") {
    if (entry.context.scope === null || !scopes.has(entry.context.scope)) return false;
    query.set(`${side}_scope`, String(entry.context.scope));
  } else {
    if (entry.context.competition === null || !competitions.has(entry.context.competition)) return false;
    query.set(`${side}_competition`, entry.context.competition);
  }
  return true;
}

export function legacyCompareHref(): string;
export function legacyCompareHref(entries: readonly LegacyCompareEntry[]): string | null;
export function legacyCompareHref(entries?: readonly LegacyCompareEntry[]): string | null {
  if (entries === undefined) return legacyUrl(new URLSearchParams({ page: "compare" }));
  if (entries.length !== 2) return null;
  const query = new URLSearchParams({ page: "compare" });
  if (!appendCompareContext(query, "left", entries[0]) || !appendCompareContext(query, "right", entries[1])) return null;
  return legacyUrl(query);
}
export function legacyAboutHref(): string { return legacyUrl(new URLSearchParams({ page: "about" })); }
/**
 * Returns a Streamlit handoff only for an explicitly enabled, fixed-origin URL.
 * Callers always supply a usable same-app destination, so malformed or incomplete
 * serializer output can never leave an empty link in the UI.
 */
export function resolveLegacyOrInternalHref(legacyHref: string | null, internalHref: string, env?: Record<string, string | boolean | undefined>): string {
  if (!legacyHandoffEnabled(env) || !legacyHref) return internalHref;
  try {
    const url = new URL(legacyHref);
    return url.protocol === "https:" && url.origin === LEGACY_ORIGIN ? url.href : internalHref;
  } catch { return internalHref; }
}
/** @deprecated Use resolveLegacyOrInternalHref with a nonempty internal fallback. */
export function enabledLegacyHref(href: string, env?: Record<string, string | boolean | undefined>): string | null { return legacyHandoffEnabled(env) ? href : null; }
