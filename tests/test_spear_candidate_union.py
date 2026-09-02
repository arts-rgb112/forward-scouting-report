from __future__ import annotations

import csv
from pathlib import Path

import pytest

from metrics import DecisionMetrics
import rankings
from scripts import build_spear_cohort
from scripts.audit_pressing_coverage import audit_baseline_non_loss


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


def test_builder_fails_the_whole_request_when_one_competition_fails(monkeypatch) -> None:
    metric = DecisionMetrics(
        league_id=47, team_id=9825, minutes_played=603, xg=2.96,
    )

    def fetch(league_id: int, *_args):
        if league_id == 54:
            raise build_spear_cohort.FotMobError("provider unavailable")
        return {"576165": metric}, {}

    monkeypatch.setattr(build_spear_cohort, "_fetch_live_spear_cohort", fetch)
    monkeypatch.setattr(
        build_spear_cohort,
        "cohort_candidate_rows",
        lambda *_args: {"576165": {"id": 576165, "name": "Gabriel Jesus"}},
    )
    monkeypatch.setattr(
        build_spear_cohort, "fetch_team_name", lambda _team_id: "Arsenal",
    )

    with pytest.raises(build_spear_cohort.CohortBuildError, match="Bundesliga"):
        build_spear_cohort.build(
            "2024/2025", ["Premier League", "Bundesliga"],
        )


def _write_cohort(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(
            target, fieldnames=("player_id", "league_id", "season_name"),
        )
        writer.writeheader()
        writer.writerows(rows)


def test_baseline_non_loss_audit_rejects_a_missing_historical_season(
    tmp_path: Path,
) -> None:
    baseline = tmp_path / "before.csv"
    _write_cohort(baseline, [
        {"player_id": "1", "league_id": "47", "season_name": "2024/2025"},
        {"player_id": "2", "league_id": "47", "season_name": "2025/2026"},
    ])

    with pytest.raises(SystemExit, match="1 previously published exact keys"):
        audit_baseline_non_loss(
            [{
                "player_id": "2", "league_id": "47",
                "season_name": "2025/2026",
            }],
            baseline,
        )


def test_refresh_spear_workflow_is_manual_only_and_reaudits_after_rebase() -> None:
    workflow = (
        Path(__file__).resolve().parents[1]
        / ".github" / "workflows" / "refresh-spear-cohort.yml"
    ).read_text(encoding="utf-8")

    assert "workflow_dispatch:" in workflow
    assert "schedule:" not in workflow
    assert "cron:" not in workflow
    assert workflow.count("--baseline") == 2
    assert "git rebase origin/main" in workflow
    assert workflow.index("git rebase origin/main") < workflow.rindex("--baseline")
