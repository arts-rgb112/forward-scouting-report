"""Competition-session merging for the legacy Streamlit reports."""

from __future__ import annotations

from typing import Protocol, TypeVar


class LeagueSession(Protocol):
    league_id: int | None
    league_name: str | None


SessionT = TypeVar("SessionT", bound=LeagueSession)


def merge_season_sessions(
    season: str,
    live_sessions: dict[str, SessionT] | None,
    static_sessions: list[tuple[str, SessionT]],
) -> list[tuple[str, SessionT]]:
    """Return one record per competition, preferring live records when present.

    Player-history responses can be partial (for example UCL without the
    domestic league).  Static cohort rows therefore seed the result and a live
    record replaces only the matching league instead of replacing the season.
    """

    rows_by_league: dict[int, tuple[str, SessionT]] = {
        int(stats.league_id): (key, stats)
        for key, stats in static_sessions
        if stats.league_id is not None
    }
    for key, stats in (live_sessions or {}).items():
        if key.split("_", 1)[0] != season or stats.league_id is None:
            continue
        rows_by_league[int(stats.league_id)] = (key, stats)
    return sorted(
        rows_by_league.values(),
        key=lambda item: ((item[1].league_name or ""), item[1].league_id or 0),
    )
