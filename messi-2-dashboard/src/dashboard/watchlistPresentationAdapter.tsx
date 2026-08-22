import type { DuelPressPlayerCore } from "../api/duelPressTypes";
import { datasetHref } from "./datasetRoute";
import type { QualityDisplay } from "./dataQualityViewModel";
import { duelPressDetailHref } from "./duelPressRoute";
import type { LegacyMetricKey, Player, Tier } from "./types";
const legacyDetailHref = (..._args: unknown[]) => "";
const resolveLegacyDetailOrInternalHref = (_legacy: string, fallback: string) => fallback;
import type { DuelWatchlistResolution } from "./duelPressWatchlistResolver";
import type { LegacyWatchlistResolution } from "./useLegacyWatchlistResolution";
import type { DuelPressV3Entry, LegacyV3Entry, WatchlistV3Context, WatchlistV3Entry } from "./watchlistV3Contracts";
import type { LeaderboardPresentationRow } from "./components/LeaderboardPresentation";
import { DataQualityBadge } from "./components/DataQualityBadge";
import type { MetricRankMap } from "./useMetricRanks";

export type WatchlistPreference = "saved" | "current";
type PreferenceProps = { preference: WatchlistPreference | undefined; onPreference(key: string, value: WatchlistPreference): void };

export function datasetFromWatchlistV3Context(context: WatchlistV3Context) {
  return context.mode === "league"
    ? { season: context.season, mode: "league" as const, scope: context.scope, competition: "all" as const }
    : { season: context.season, mode: "europe" as const, scope: 8 as const, competition: context.competition };
}
export function watchlistV3ContextLabel(entry: WatchlistV3Entry) {
  return entry.context.mode === "league" ? `${entry.context.season} · League · ${entry.context.scope} leagues` : `${entry.context.season} · Europe · ${entry.context.competition.toUpperCase()}`;
}
function legacyHref(entry: LegacyV3Entry) {
  const dataset = datasetFromWatchlistV3Context(entry.context);
  return resolveLegacyDetailOrInternalHref(legacyDetailHref(entry.playerId, { name: entry.snapshot.name, clubName: entry.snapshot.clubName }, dataset), datasetHref(`/players/${entry.playerId}`, dataset));
}
function contextBadge(entry: WatchlistV3Entry) { return <span className="rounded border border-lime-300/25 bg-lime-300/10 px-1.5 py-0.5 font-bold text-lime-100">{watchlistV3ContextLabel(entry)}</span>; }
function statusBadge(label: string | null) { return label ? <span className="rounded border border-amber-300/25 bg-amber-300/10 px-1.5 py-0.5 font-bold text-amber-100">{label}</span> : null; }
function selector(entry: WatchlistV3Entry, name: string, preference: WatchlistPreference | undefined, onPreference: PreferenceProps["onPreference"], mobile: boolean) {
  return <select aria-label={`${name} saved or current snapshot`} value={preference ?? "current"} onChange={(event) => onPreference(entry.key, event.target.value as WatchlistPreference)} className={`${mobile ? "min-h-11 w-full" : "h-7"} rounded border border-white/10 bg-[#111516] px-2 text-[10px]`}><option value="current">현재 서버 값</option><option value="saved">저장 시점 값</option></select>;
}
function savedOnlyAction() { return <span className="inline-flex min-h-11 items-center justify-center rounded border border-white/10 px-2 text-xs text-zinc-400">Saved snapshot</span>; }
function legacyStatus(result: LegacyWatchlistResolution | undefined, showingCurrent: boolean, currentAvailable: boolean) {
  // Choosing a saved snapshot is a valid preference when a current profile is
  // available.  It is not a warning state, so do not add a noisy success badge.
  if (showingCurrent || currentAvailable) return null;
  if (result?.status === "pending") return "Resolving · saved snapshot visible";
  if (result?.status === "resolver-unavailable") return "Resolver unavailable · saved snapshot";
  if (result?.status === "contract-error") return "Contract error · saved snapshot";
  if (result?.status === "offline") return "Offline · saved snapshot";
  if (result?.status === "invalid-context") return "Invalid context · saved snapshot";
  if (result?.status === "unavailable") return "Unavailable · saved snapshot";
  return null;
}
function duelStatus(result: DuelWatchlistResolution | undefined, showingCurrent: boolean, currentAvailable: boolean) {
  if (showingCurrent || currentAvailable) return null;
  if (result?.status === "pending") return "Refreshing · saved snapshot visible";
  if (result?.status === "unavailable") return "Unavailable · saved snapshot";
  if (result?.status === "contract-error") return "Contract error · saved snapshot";
  if (result?.status === "offline") return "Offline · saved snapshot";
  return null;
}
function tierFromLegacySnapshot(entry: LegacyV3Entry): Tier | null {
  const tier = entry.snapshot.tier;
  if (!tier) return null;
  return tier.taxonomyVersion || !entry.snapshot.tierTaxonomyVersion ? tier : { ...tier, taxonomyVersion: entry.snapshot.tierTaxonomyVersion };
}
function legacySnapshotIdentity(entry: LegacyV3Entry): LeaderboardPresentationRow<LegacyMetricKey, LegacyV3Entry>["identity"] {
  const snapshot = entry.snapshot;
  if (snapshot.face !== undefined && snapshot.nation !== undefined && snapshot.league && snapshot.club && snapshot.archetype) return { kind: "full", player: { id: entry.playerId, name: snapshot.name, position: snapshot.position, archetype: snapshot.archetype, face: snapshot.face, nation: snapshot.nation, league: snapshot.league, club: snapshot.club } };
  return { kind: "partial", player: { id: entry.playerId, name: snapshot.name, position: snapshot.position || undefined, archetype: snapshot.archetype, face: snapshot.face, nation: snapshot.nation, league: snapshot.league, club: snapshot.club, leagueName: snapshot.leagueName, clubName: snapshot.clubName } };
}
function currentIdentity(player: Player): LeaderboardPresentationRow<LegacyMetricKey, LegacyV3Entry>["identity"] { return { kind: "full", player }; }

export function legacyWatchlistPresentationRow(entry: LegacyV3Entry, result: LegacyWatchlistResolution | undefined, quality: QualityDisplay | undefined, props: PreferenceProps): LeaderboardPresentationRow<LegacyMetricKey, LegacyV3Entry> {
  const current = result?.status === "current" && result.player ? result.player : undefined;
  const showingCurrent = props.preference !== "saved" && current !== undefined;
  const effective = showingCurrent ? current : undefined;
  const name = effective?.name ?? entry.snapshot.name; const status = legacyStatus(result, showingCurrent, current !== undefined);
  const accessory = <>{contextBadge(entry)}{statusBadge(status)}{showingCurrent && <DataQualityBadge quality={quality} />}{current && <span className="hidden md:inline-flex">{selector(entry, name, props.preference, props.onPreference, false)}</span>}</>;
  return {
    key: entry.key, source: entry, playerId: entry.playerId, identity: effective ? currentIdentity(effective) : legacySnapshotIdentity(entry), identityDomId: null, detailHref: legacyHref(entry),
    rank: { hidden: true },
    tier: effective?.tier ?? tierFromLegacySnapshot(entry), tierAccessory: <span>{effective?.rank ?? entry.snapshot.rank ? `${showingCurrent ? "현재 서버 순위" : "저장 시점 순위"} ${effective?.rank ?? entry.snapshot.rank}` : `${showingCurrent ? "현재 서버 순위" : "저장 시점 순위"} 정보 없음`}</span>, score: effective?.score ?? entry.snapshot.score ?? null, stats: effective?.stats ?? entry.snapshot.stats ?? {},
    minutes: effective?.minutes ?? entry.snapshot.minutes ?? null, age: effective ? effective.age : entry.snapshot.age ?? null, metricSnapshot: !showingCurrent, metricQuality: showingCurrent ? quality : undefined,
    profileAccessory: accessory, mobileAccessory: <>{contextBadge(entry)}{statusBadge(status)}{showingCurrent && <DataQualityBadge quality={quality} />}</>,
    mobileAction: current ? selector(entry, name, props.preference, props.onPreference, true) : savedOnlyAction(),
  };
}

export function duelWatchlistPresentationRow(entry: DuelPressV3Entry, result: DuelWatchlistResolution | undefined, props: PreferenceProps, metricRanks?: MetricRankMap): LeaderboardPresentationRow<keyof DuelPressPlayerCore["stats"], DuelPressV3Entry> {
  const current = result?.status === "current" && result.player ? result.player : undefined;
  const showingCurrent = props.preference !== "saved" && current !== undefined; const effective = showingCurrent ? current : entry.snapshot; const status = duelStatus(result, showingCurrent, current !== undefined);
  return {
    key: entry.key, source: entry, playerId: entry.playerId, identity: { kind: "full", player: effective }, identityDomId: null, detailHref: resolveLegacyDetailOrInternalHref(legacyDetailHref(entry.playerId, { name: entry.snapshot.name, clubName: entry.snapshot.club.name }, datasetFromWatchlistV3Context(entry.context)), duelPressDetailHref(entry.playerId, datasetFromWatchlistV3Context(entry.context))),
    rank: { hidden: true }, tier: effective.tier, tierAccessory: <span>{effective.rank ? `${showingCurrent ? "현재 서버 순위" : "저장 시점 순위"} ${effective.rank}` : `${showingCurrent ? "현재 서버 순위" : "저장 시점 순위"} 정보 없음`}</span>, score: effective.score, stats: effective.stats, minutes: effective.minutes, age: effective.age, metricSnapshot: !showingCurrent, metricRanks: showingCurrent ? metricRanks : undefined,
    profileAccessory: <>{contextBadge(entry)}{statusBadge(status)}{current && <span className="hidden md:inline-flex">{selector(entry, effective.name, props.preference, props.onPreference, false)}</span>}</>,
    mobileAccessory: <>{contextBadge(entry)}{statusBadge(status)}</>, mobileAction: current ? selector(entry, effective.name, props.preference, props.onPreference, true) : savedOnlyAction(),
  };
}
