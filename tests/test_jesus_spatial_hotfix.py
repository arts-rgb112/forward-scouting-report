from __future__ import annotations

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_gabriel_jesus_2024_25_has_complete_static_score_inputs() -> None:
    with (ROOT / "data" / "spear_cohort.csv").open(encoding="utf-8", newline="") as stream:
        cohort = list(csv.DictReader(stream))
    rows = [
        row for row in cohort
        if row["player_id"] == "576165" and row["season_name"] == "2024/2025"
        and row["league_id"] == "47"
    ]
    assert len(rows) == 1
    assert float(rows[0]["minutes_played"]) == 603.0
    assert float(rows[0]["xg"]) == 2.96

    with (ROOT / "data" / "tactical_3zone_ratio.csv").open(encoding="utf-8", newline="") as stream:
        tactical = list(csv.DictReader(stream))
    sessions = [row for row in tactical if row["heatmap_key"] == "576165:17:61627"]
    assert len(sessions) == 1
    assert sessions[0]["sportsapi_player_id"] == "794839"
    assert sessions[0]["activity_filter"] == "fixed-n60-r20-v2"
    assert sessions[0]["activity_valid_point_count"] == "148"

    points = json.loads((ROOT / "data" / "tactical_heatmap_points.json").read_text(encoding="utf-8"))
    assert len(points["576165:17:61627"]) == 148


def test_gabriel_jesus_2025_26_remains_below_the_minutes_floor() -> None:
    with (ROOT / "data" / "spear_cohort.csv").open(encoding="utf-8", newline="") as stream:
        cohort = list(csv.DictReader(stream))
    assert not any(
        row["player_id"] == "576165" and row["season_name"] == "2025/2026"
        for row in cohort
    )


def test_gabriel_jesus_2024_25_has_verified_shotmap_snapshot() -> None:
    shard = json.loads(
        (ROOT / "data" / "tactical_shotmap_points_2024_2025.json").read_text(
            encoding="utf-8"
        )
    )
    shots = shard["576165:17:61627"]

    assert len(shots) == 20
    assert all(shot.get("sourceEventId") for shot in shots)
    assert all(shot.get("trajectory") for shot in shots)
    assert {outcome: sum(shot["outcome"] == outcome for shot in shots) for outcome in (
        "goal", "on_target", "off_target", "blocked",
    )} == {"goal": 3, "on_target": 5, "off_target": 8, "blocked": 4}
