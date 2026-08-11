import type { DatasetRouteState } from "../dashboard/types";

export const LEGACY_ORIGIN = "https://forward-scouting-report-fd4zfq2gjrr5ladifytpcq.streamlit.app" as const;
const scopes = new Set([3, 5, 7]);

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
  if (!Number.isSafeInteger(playerId) || playerId <= 0 || !season || !scopes.has(dataset.scope)) return null;
  return legacyUrl(new URLSearchParams({ page: "detail", player: String(playerId), name: player.name, team: player.clubName, season, scope: String(dataset.scope) }));
}
export function legacyCompareHref(): string { return legacyUrl(new URLSearchParams({ page: "compare" })); }
export function legacyAboutHref(): string { return legacyUrl(new URLSearchParams({ page: "about" })); }
export function enabledLegacyHref(href: string, env?: Record<string, string | boolean | undefined>): string | null { return legacyHandoffEnabled(env) ? href : null; }
