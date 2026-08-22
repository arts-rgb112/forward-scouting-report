from __future__ import annotations

from scripts.audit_final_third_shotmap_coverage import build_report, context_refs


def _row(**overrides: str) -> dict[str, str]:
    row = {
        "fotmob_player_id": "194165",
        "player_name": "Harry Kane",
        "competition_name": "Premier League",
        "season_name": "2025/2026",
        "heatmap_key": "194165:17:77333",
    }
    row.update(overrides)
    return row


def test_context_refs_preserve_exact_europe_and_domestic_scope_identity() -> None:
    assert context_refs(_row(competition_name="UEFA Champions League")) == (
        ("europe", "", "ucl", "UEFA Champions League"),
    )
    assert context_refs(_row()) == (
        ("league", "3", "all", "Premier League"),
        ("league", "5", "all", "Premier League"),
        ("league", "7", "all", "Premier League"),
        ("league", "8", "all", "Premier League"),
    )


def test_report_keeps_missing_competition_snapshot_explicit() -> None:
    snapshots = {"league-ready": []}
    coverage, unavailable = build_report(
        [
            _row(heatmap_key="league-ready"),
            _row(
                fotmob_player_id="860914", player_name="Luis Diaz",
                competition_name="UEFA Champions League", heatmap_key="ucl-missing",
            ),
        ],
        lambda key, _season: (key in snapshots, snapshots.get(key, [])),
        {"ucl-missing": "source_history_unavailable"},
    )
    league = [row for row in coverage if row["mode"] == "league"]
    assert len(league) == 4
    assert all(row["snapshot_available"] == 1 for row in league)
    assert all(row["verified_zero_shot_sessions"] == 1 for row in league)
    assert [(row["mode"], row["competition"], row["reason"]) for row in unavailable] == [
        ("europe", "all", "source_history_unavailable"),
        ("europe", "ucl", "source_history_unavailable"),
    ]


def test_report_models_europe_all_as_exact_competition_union() -> None:
    snapshots = {"ucl-ready": [{"x": 1}]}
    coverage, unavailable = build_report(
        [
            _row(
                fotmob_player_id="850356", player_name="Multi Cup Player",
                competition_name="UEFA Champions League", heatmap_key="ucl-ready",
            ),
            _row(
                fotmob_player_id="850356", player_name="Multi Cup Player",
                competition_name="UEFA Europa League", heatmap_key="uel-missing",
            ),
        ],
        lambda key, _season: (key in snapshots, snapshots.get(key, [])),
        {"uel-missing": "snapshot_missing"},
    )
    all_row = next(row for row in coverage if row["mode"] == "europe" and row["competition"] == "all")
    assert all_row == {
        "season_name": "2025/2026", "mode": "europe", "scope": "",
        "competition": "all", "competition_name": "All European competitions",
        "api_contexts": 1, "source_sessions": 2, "available_contexts": 1,
        "partial_contexts": 1, "unavailable_contexts": 0,
        "snapshot_available": 1, "snapshot_missing": 1,
        "verified_zero_shot_sessions": 0, "shots_total": 1,
    }
    assert all(row["competition"] != "all" for row in unavailable)
