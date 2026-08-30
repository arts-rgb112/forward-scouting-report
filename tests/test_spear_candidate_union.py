from __future__ import annotations

from metrics import DecisionMetrics
import rankings
from scripts import build_spear_cohort


def test_candidate_union_keeps_expected_goals_only_player_and_name(monkeypatch) -> None:
    def table(_league_id: int, _season: str, stat: str):
        if stat == "won_contest":
            return [{"id": 1, "name": "Contest player"}]
        if stat == "expected_goals":
            return [
                {"id": 1, "name": "Contest player"},
                {"id": 576165, "name": "Gabriel Jesus"},
            ]
        return []

    monkeypatch.setattr(rankings, "fetch_league_stat_table", table)
    candidates = rankings.cohort_candidate_rows(47, "2024/2025")

    assert set(candidates) == {"1", "576165"}
    assert candidates["576165"]["name"] == "Gabriel Jesus"


def test_expected_goals_only_eligible_player_survives_exact_profile_filter(monkeypatch) -> None:
    def table(_league_id: int, _season: str, stat: str):
        if stat == "won_contest":
            return [{"id": 1, "name": "Contest player"}]
        if stat == "expected_goals":
            return [
                {"id": 1, "name": "Contest player"},
                {"id": 576165, "name": "Gabriel Jesus"},
            ]
        return []

    def extract(player_id: str):
        minutes, xg = (900, 3.0) if player_id == "1" else (603, 2.96)
        return {"24/25_47": DecisionMetrics(league_id=47, league_name="Premier League", minutes_played=minutes, xg=xg)}

    monkeypatch.setattr(rankings, "fetch_league_stat_table", table)
    monkeypatch.setattr(rankings, "fetch_player_multi_season_data", lambda player_id, **_kwargs: player_id)
    monkeypatch.setattr(rankings, "extract_multi_season_metrics", extract)
    monkeypatch.setattr(rankings, "passes_final_third_filter", lambda *_args: True)

    metrics, _ = rankings._fetch_live_spear_cohort(47, "2024/2025")

    assert set(metrics) == {"1", "576165"}
    assert metrics["576165"].minutes_played == 603
    assert metrics["576165"].xg == 2.96


def test_builder_uses_candidate_union_for_expected_goals_only_name(monkeypatch) -> None:
    metric = DecisionMetrics(league_id=47, team_id=9825, minutes_played=603, xg=2.96)
    monkeypatch.setattr(build_spear_cohort, "_fetch_live_spear_cohort", lambda *_args: ({"576165": metric}, {}))
    monkeypatch.setattr(build_spear_cohort, "cohort_candidate_rows", lambda *_args: {"576165": {"id": 576165, "name": "Gabriel Jesus"}})
    monkeypatch.setattr(build_spear_cohort, "fetch_team_name", lambda _team_id: "Arsenal")

    rows = build_spear_cohort.build("2024/2025", ["Premier League"])

    assert rows[0]["player_name"] == "Gabriel Jesus"
    assert rows[0]["team_name"] == "Arsenal"
