import { useEffect, useState } from "react";
import { parseMessiApiConfig, type MessiApiConfig } from "../api/env";
import { fetchPlayerDetail } from "../api/leaderboardsApi";
import type { DatasetRouteState, Player } from "../dashboard/types";

function datasetStateFromUrl(config: MessiApiConfig): DatasetRouteState {
  const query = new URLSearchParams(window.location.search);
  const scope = Number(query.get("scope"));
  return {
    season: query.get("season") ?? config.season,
    mode: query.get("mode") === "europe" ? "europe" : "league",
    scope: ([3, 5, 7].includes(scope) ? scope : config.scope) as 3 | 5 | 7,
    competition: (["all", "ucl", "uel", "uecl"].includes(query.get("competition") ?? "") ? query.get("competition") : "all") as DatasetRouteState["competition"],
  };
}

function BackLink() {
  return <a href={`/${window.location.search}`} className="text-lime-300">← Leaderboard</a>;
}

export function StaticRoute() {
  const path = window.location.pathname;
  if (path === "/about/messi") return <main className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><article className="max-w-2xl rounded-xl border border-white/10 bg-[#101415] p-7"><BackLink /><h1 className="mt-5 text-3xl font-black">M.E.S.S.I. metrics</h1><p className="mt-3 text-zinc-400">The index combines outside-box shooting, in-box shooting, dribbling, aerial and ground duels, and off-the-ball movement. Scores remain the existing algorithm; dashboard labels improve readability only.</p></article></main>;
  if (path === "/compare") return <main className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><article className="max-w-xl rounded-xl border border-white/10 bg-[#101415] p-7"><BackLink /><h1 className="mt-5 text-3xl font-black">Player comparison</h1><p className="mt-3 text-zinc-400">Select up to four players from the leaderboard to compare their six sector scores.</p></article></main>;
  return <PlayerDetail id={Number(path.split("/")[2])} />;
}

function PlayerDetail({ id }: { id: number }) {
  const [player, setPlayer] = useState<Player>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!Number.isInteger(id) || id <= 0) { setError("Player not found"); return; }
    const controller = new AbortController();
    try {
      const config = parseMessiApiConfig(import.meta.env, import.meta.env.MODE);
      fetchPlayerDetail(config, id, datasetStateFromUrl(config), controller.signal)
        .then(setPlayer)
        .catch(() => setError("Player details are unavailable for this dataset."));
    } catch { setError("Dashboard API configuration is unavailable."); }
    return () => controller.abort();
  }, [id]);

  return <main className="grid min-h-screen place-items-center bg-[#080b0c] p-6 text-zinc-100"><article className="w-full max-w-xl rounded-xl border border-white/10 bg-[#101415] p-7"><BackLink />{error ? <p role="alert" className="mt-5 text-amber-300">{error}</p> : !player ? <p className="mt-5 text-zinc-400">Loading player profile…</p> : <><h1 className="mt-5 text-3xl font-black">{player.name}</h1><p className="mt-2 text-zinc-400">{player.club.name} · {player.league.name} · {player.position}</p><div className="mt-5 grid grid-cols-2 gap-3 text-sm">{Object.entries(player.stats).map(([key, value]) => <div key={key} className="rounded bg-black/20 p-3"><span className="text-zinc-500">{key}</span><b className="float-right text-lime-300">{value}</b></div>)}</div></>}</article></main>;
}
