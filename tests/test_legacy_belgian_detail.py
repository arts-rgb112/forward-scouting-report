from types import SimpleNamespace

from legacy_sessions import merge_season_sessions
from spear_cohort import load_spear_cohort


def _session(league_id: int, league_name: str, marker: str):
    return SimpleNamespace(
        league_id=league_id,
        league_name=league_name,
        marker=marker,
    )


def test_partial_live_history_keeps_belgian_league_static_session() -> None:
    static_belgian = _session(40, "Belgian Pro League", "static")
    static_ucl = _session(42, "Champions League", "static")
    live_ucl = _session(42, "Champions League", "live")

    rows = merge_season_sessions(
        "25/26",
        {
            "25/26_42": live_ucl,
            "24/25_40": _session(40, "Belgian Pro League", "wrong-season"),
        },
        [("25/26_40", static_belgian), ("25/26_42", static_ucl)],
    )

    by_league = {stats.league_id: stats for _, stats in rows}
    assert set(by_league) == {40, 42}
    assert by_league[40] is static_belgian
    assert by_league[42] is live_ucl


def test_tresoldi_has_belgian_and_ucl_static_detail_sessions() -> None:
    tresoldi_id = "1334552"
    season = "2025/2026"
    cohorts = load_spear_cohort()

    available_leagues = {
        league_id
        for (league_id, cohort_season), players in cohorts.items()
        if cohort_season == season and tresoldi_id in players
    }

    assert {40, 42}.issubset(available_leagues)
