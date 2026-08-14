import type { AssetRef } from "./types";

// The generic "Pro League" label is deliberately not included: it is used by
// unrelated competitions and cannot establish a Belgian context on its own.
const belgianAliases = new Set(["First Division A", "Jupiler Pro League", "Jupiler League", "Belgian Pro League Playoffs", "Belgian Pro League Playoff"]);

export function displayLeagueName(league: Pick<AssetRef, "id" | "name">): string {
  return league.id === 40 || belgianAliases.has(league.name) ? "Belgian Pro League" : league.name;
}

export function leagueFallbackLabel(league: Pick<AssetRef, "id" | "name">): string {
  return league.id === 40 ? "BE" : displayLeagueName(league);
}
