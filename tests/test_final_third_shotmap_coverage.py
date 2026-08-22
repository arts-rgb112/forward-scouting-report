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
    # Premier League is in every currently supported domestic comparison scope.
    assert context_refs(_row()) == (
        ("league", "3", "all", "Premier League"),
        ("league", "5", "all", "Premier League"),
        ("league", "7", "all", "Premier League"),
        ("league", "8", "all", "Premier League"),
    )


def test_report_keeps_missing_competition_snapshot_explicit() -> None:
    coverage, unavailable = build_report(
        [
            _row(heatmap_key="league-ready"),
            _row(
                fotmob_player_id="860914", player_name="Luis Díaz",
                competition_name="UEFA Champions League", heatmap_key="ucl-missing",
            ),
        ],
        {"league-ready": [], "unrelated-domestic": [{"x": 1}]},
        {"ucl-missing": "source_history_unavailable"},
    )
    league = [row for row in coverage if row["mode"] == "league"]
    assert len(league) == 4
    assert all(row["snapshot_available"] == 1 for row in league)
    assert all(row["verified_zero_shot_sessions"] == 1 for row in league)
    assert unavailable == [{
        "player_id": "860914", "player_name": "Luis Díaz", "season_name": "2025/2026",
        "mode": "europe", "scope": "", "competition": "ucl",
        "competition_name": "UEFA Champions League", "heatmap_key": "ucl-missing",
        "reason": "source_history_unavailable",
    }]
