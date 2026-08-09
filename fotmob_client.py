from __future__ import annotations

from dataclasses import dataclass
import functools
import json
import re
import time
from typing import Any
from urllib.parse import quote
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL)


class FotMobError(Exception):
    pass


class PlayerNotFoundError(FotMobError):
    pass


@dataclass(frozen=True)
class PlayerCandidate:
    player_id: str
    name: str
    team_name: str | None = None


def _get(url: str) -> str:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urlopen(request, timeout=15) as response:
            return response.read().decode("utf-8")
    except HTTPError as exc:
        raise FotMobError(f"FotMob request failed (HTTP {exc.code}).") from exc
    except URLError as exc:
        raise FotMobError("Could not reach FotMob.") from exc


@functools.lru_cache(maxsize=512)
def fetch_team_name(team_id: int) -> str | None:
    """Resolve a FotMob team ID without fetching any player profile."""
    if not team_id:
        return None
    try:
        payload = json.loads(_get(f"https://www.fotmob.com/api/data/teams?id={int(team_id)}"))
    except (ValueError, FotMobError):
        return None
    details = payload.get("details") if isinstance(payload, dict) else None
    name = details.get("name") if isinstance(details, dict) else None
    return str(name).strip() if name else None


def search_players(term: str) -> list[PlayerCandidate]:
    response = _get(f"https://apigw.fotmob.com/searchapi/suggest?term={quote(term)}&lang=en")
    try:
        data: Any = json.loads(response)
    except ValueError as exc:
        raise FotMobError("Could not parse the player search response.") from exc
    if isinstance(data, dict) and isinstance(data.get("squadMemberSuggest"), list):
        rows = [
            option for group in data["squadMemberSuggest"] if isinstance(group, dict)
            for option in group.get("options", []) if isinstance(option, dict)
        ]
    else:
        rows = data.get("suggestions", data) if isinstance(data, dict) else data
    candidates = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or str(row.get("type", "player")).lower() not in {"player", "players"}:
            continue
        payload = row.get("payload", {}) if isinstance(row.get("payload"), dict) else row
        player_id = payload.get("id") or row.get("id") or row.get("playerId")
        name = row.get("name") or row.get("title") or str(row.get("text", "")).split("|")[0]
        if player_id and name:
            candidates.append(PlayerCandidate(str(player_id), str(name), payload.get("teamName") or row.get("teamName") or row.get("team")))
    return candidates


def _payload_from_html(html: str) -> dict[str, Any]:
    match = _NEXT_DATA_RE.search(html)
    if not match:
        raise FotMobError("The player page did not include its embedded data.")
    try:
        return json.loads(match.group(1))["props"]["pageProps"]["data"]
    except (ValueError, KeyError, TypeError) as exc:
        raise PlayerNotFoundError("Could not read player data from the page.") from exc


def fetch_player_next_data(player_id: str, season: str | None = None, slug: str | None = None) -> dict[str, Any]:
    path = f"https://www.fotmob.com/players/{player_id}"
    if slug:
        path += f"/{quote(slug)}"
    if season:
        path += f"?season={quote(season)}"
    return _payload_from_html(_get(path))


def fetch_player_season_stats(player_id: str, entry_id: str) -> dict[str, Any]:
    """Fetch the exact tournament selection used by FotMob's season selector."""
    url = f"https://www.fotmob.com/api/data/playerStats?playerId={quote(player_id)}&seasonId={quote(entry_id)}"
    try:
        data = json.loads(_get(url))
    except ValueError as exc:
        raise FotMobError("Could not parse player season statistics.") from exc
    if not isinstance(data, dict):
        raise FotMobError("FotMob returned invalid player season statistics.")
    return data


def fetch_player_competition_stats(
    player_id: str, league_id: int, season_name: str
) -> dict[str, Any]:
    """Fetch one player's statistics for one league-season only.

    League deep-stat tables provide the eligible player ids, but not every
    component required for the net-progression metric.  Fetching the exact
    competition avoids the much more expensive multi-season request for every
    eligible player.
    """
    base = fetch_player_next_data(player_id)
    for season in base.get("statSeasons", []):
        if not isinstance(season, dict) or season.get("seasonName") != season_name:
            continue
        tournaments = season.get("tournaments", [])
        if not isinstance(tournaments, list):
            continue
        for tournament in tournaments:
            if not isinstance(tournament, dict):
                continue
            if tournament.get("tournamentId") != league_id or not tournament.get("entryId"):
                continue
            stats = fetch_player_season_stats(player_id, tournament["entryId"])
            team_id = next((shot.get("teamId") for shot in stats.get("shotmap", []) if isinstance(shot, dict)), None)
            team_name = None
            for shot in stats.get("shotmap", []):
                if not isinstance(shot, dict) or shot.get("teamId") != team_id:
                    continue
                team_name = shot.get("homeTeamName") if shot.get("homeTeamId") == team_id else shot.get("awayTeamName")
                if team_name:
                    break
            return {
                "season": season_name,
                "league_id": league_id,
                "league_name": tournament.get("name"),
                "team_id": team_id,
                "team_name": team_name,
                "stats": stats,
            }
    raise FotMobError(
        f"League {league_id} / season '{season_name}' was not available for player {player_id}."
    )


def fetch_league_stat_table(league_id: int, season_name: str, stat: str) -> list[dict[str, Any]]:
    """Return one FotMob league leaderboard for a concrete season and stat."""
    base = "https://www.fotmob.com/api/data/leagueseasondeepstats"
    lookup = json.loads(_get(f"{base}?id={league_id}&season={quote(season_name)}&type=players&stat=goals"))
    season_id = next(
        (row.get("id") for row in lookup.get("seasons", []) if row.get("name") == season_name),
        None,
    )
    if season_id is None:
        raise FotMobError(f"Season '{season_name}' is not available for league {league_id}.")
    try:
        data = json.loads(_get(f"{base}?id={league_id}&season={season_id}&type=players&stat={quote(stat)}"))
    except ValueError as exc:
        raise FotMobError("Could not parse league statistics.") from exc
    rows = data.get("statsData")
    if not isinstance(rows, list):
        raise FotMobError("FotMob returned invalid league statistics.")
    return [row for row in rows if isinstance(row, dict)]


_CONTINENTAL_HINTS = (
    "champions league", "ucl", "europa league", "conference league",
)
_CUP_HINTS = ("cup", "copa", "super")


def _league_selections(
    data: dict[str, Any], max_seasons: int = 3, competitions_per_season: int = 4,
    target_season: str | None = None,
) -> list[dict[str, Any]]:
    """Choose the domestic league and any UEFA club competition from club seasons.

    FotMob lists a club season's tournaments starting with the domestic league;
    other entries in the same season can be cups, super cups, or continental
    competitions. We keep the first entry (the league) plus any additional
    entry that looks continental, while skipping obvious cup competitions and
    one-year national-team seasons (World Cup, Nations League, etc.).
    """
    selections: list[dict[str, Any]] = []
    seasons_seen = 0
    for row in data.get("statSeasons", []):
        if not isinstance(row, dict) or not re.fullmatch(r"\d{4}/\d{4}", str(row.get("seasonName"))):
            continue
        if target_season and row.get("seasonName") != target_season:
            continue
        tournaments = row.get("tournaments", [])
        if not isinstance(tournaments, list) or not tournaments:
            continue

        season_selections = []
        for index, tournament in enumerate(tournaments):
            if not isinstance(tournament, dict) or not tournament.get("entryId"):
                continue
            name_lower = str(tournament.get("name", "")).lower()
            is_league_slot = index == 0  # FotMob puts the domestic league first
            is_continental = any(hint in name_lower for hint in _CONTINENTAL_HINTS)
            is_cup = any(hint in name_lower for hint in _CUP_HINTS) and not is_continental
            if is_cup or not (is_league_slot or is_continental):
                continue
            season_selections.append({
                "season": row["seasonName"],
                "entry_id": tournament["entryId"],
                "league_id": tournament.get("tournamentId"),
                "league_name": tournament.get("name"),
            })
            if len(season_selections) == competitions_per_season:
                break

        if not season_selections:
            continue
        selections.extend(season_selections)
        seasons_seen += 1
        if target_season or seasons_seen == max_seasons:
            break
    return selections


def fetch_player_multi_season_data(
    player_id: str, *, target_season: str | None = None,
) -> dict[str, Any]:
    """Fetch selected club competitions, optionally for one historical season.

    Interactive reports retain the latest-three-season behaviour.  Batch
    cohort builders pass ``target_season`` so a 21/22 request does not silently
    stop after inspecting only a player's three most recent seasons.
    """
    base = fetch_player_next_data(player_id)
    season_records = []
    for index, selection in enumerate(_league_selections(base, target_season=target_season)):
        if index:
            time.sleep(1.2)
        try:
            season_records.append({**selection, "stats": fetch_player_season_stats(player_id, selection["entry_id"])})
        except FotMobError:
            continue
    return {"base": base, "season_records": season_records}
