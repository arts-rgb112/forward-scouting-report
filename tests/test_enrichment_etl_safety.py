from __future__ import annotations

import csv
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from scripts import enrich_spear_cohort_teams as team_enrichment
from scripts import enrich_tactical_spatial_metrics as tactical_enrichment


TACTICAL_FIELDS = [
    "heatmap_key", "activity_filter", "player_name", "in_box_ratio",
    *tactical_enrichment.SPATIAL_FIELDS,
]
COHORT_FIELDS = [
    "player_id", "player_name", "season_name", "league_id", "team_id",
    "team_name", "goals",
]


def _write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as source:
        return list(csv.DictReader(source))


def _tactical_row(key: str, version: str) -> dict[str, str]:
    row = {field: "0.0000" for field in TACTICAL_FIELDS}
    row.update({
        "heatmap_key": key,
        "activity_filter": version,
        "player_name": "Protected name",
        "in_box_ratio": "77",
    })
    return row


def test_tactical_enrichment_fails_closed_on_formula_mismatch(tmp_path: Path) -> None:
    ratios = tmp_path / "ratios.csv"
    points = tmp_path / "points.json"
    _write_csv(ratios, TACTICAL_FIELDS, [
        _tactical_row("1:2:3", "fixed-n60-r20-v2"),
    ])
    points.write_text('{"1:2:3":[[90,50]]}', encoding="utf-8")
    before = ratios.read_bytes()

    with pytest.raises(ValueError, match="explicit migration flag"):
        tactical_enrichment.enrich(ratios, points)

    assert ratios.read_bytes() == before


def test_tactical_migration_preserves_keys_and_non_target_fields(tmp_path: Path) -> None:
    ratios = tmp_path / "ratios.csv"
    points = tmp_path / "points.json"
    rows = [
        _tactical_row("1:2:3", "fixed-n60-r20-v2"),
        _tactical_row("4:5:6", "fixed-n60-r20-v2"),
    ]
    rows[1]["player_name"] = "Also protected"
    _write_csv(ratios, TACTICAL_FIELDS, rows)
    points.write_text(json.dumps({
        "1:2:3": [[90, 50], [90, 50]],
        "4:5:6": [],
    }), encoding="utf-8")

    total, populated = tactical_enrichment.enrich(
        ratios, points, migrate_definition_from="fixed-n60-r20-v2",
    )

    assert (total, populated) == (2, 1)
    updated = _read_csv(ratios)
    assert [row["heatmap_key"] for row in updated] == ["1:2:3", "4:5:6"]
    assert [row["activity_filter"] for row in updated] == [
        tactical_enrichment.ACTIVITY_FILTER_VERSION,
        tactical_enrichment.ACTIVITY_FILTER_VERSION,
    ]
    assert [row["player_name"] for row in updated] == [
        "Protected name", "Also protected",
    ]
    assert [row["in_box_ratio"] for row in updated] == ["77", "77"]


def test_tactical_enrichment_rejects_csv_json_key_drift(tmp_path: Path) -> None:
    ratios = tmp_path / "ratios.csv"
    points = tmp_path / "points.json"
    _write_csv(ratios, TACTICAL_FIELDS, [
        _tactical_row("1:2:3", tactical_enrichment.ACTIVITY_FILTER_VERSION),
    ])
    points.write_text('{"other":[]}', encoding="utf-8")

    with pytest.raises(ValueError, match="csv_only=1 json_only=1"):
        tactical_enrichment.enrich(ratios, points)


def test_tactical_atomic_replace_failure_preserves_original(tmp_path: Path) -> None:
    ratios = tmp_path / "ratios.csv"
    points = tmp_path / "points.json"
    _write_csv(ratios, TACTICAL_FIELDS, [
        _tactical_row("1:2:3", tactical_enrichment.ACTIVITY_FILTER_VERSION),
    ])
    points.write_text('{"1:2:3":[[90,50]]}', encoding="utf-8")
    before = ratios.read_bytes()

    with patch.object(tactical_enrichment.os, "replace", side_effect=OSError("stop")):
        with pytest.raises(OSError, match="stop"):
            tactical_enrichment.enrich(ratios, points)

    assert ratios.read_bytes() == before
    assert sorted(tmp_path.iterdir()) == [points, ratios]


def test_team_enrichment_changes_only_team_name_and_preserves_keys(tmp_path: Path) -> None:
    cohort = tmp_path / "cohort.csv"
    rows = [
        {"player_id": "1", "player_name": "A", "season_name": "2025/2026", "league_id": "47", "team_id": "9", "team_name": "", "goals": "4"},
        {"player_id": "2", "player_name": "B", "season_name": "2025/2026", "league_id": "47", "team_id": "10", "team_name": "Existing", "goals": "5"},
    ]
    _write_csv(cohort, COHORT_FIELDS, rows)

    result = team_enrichment.enrich(
        cohort, resolver=lambda team_id: "Resolved" if team_id == 9 else None,
        delay_seconds=0,
    )

    assert result == (2, 1, 1)
    updated = _read_csv(cohort)
    assert updated[0]["team_name"] == "Resolved"
    assert updated[1]["team_name"] == "Existing"
    for index, row in enumerate(rows):
        for field in set(COHORT_FIELDS) - {"team_name"}:
            assert updated[index][field] == row[field]


def test_team_enrichment_rejects_duplicate_exact_keys_before_network(tmp_path: Path) -> None:
    cohort = tmp_path / "cohort.csv"
    row = {"player_id": "1", "player_name": "A", "season_name": "2025/2026", "league_id": "47", "team_id": "9", "team_name": "", "goals": "4"}
    _write_csv(cohort, COHORT_FIELDS, [row, row])
    calls: list[int] = []

    with pytest.raises(ValueError, match="duplicate exact cohort key"):
        team_enrichment.enrich(
            cohort, resolver=lambda team_id: calls.append(team_id) or "Resolved",
            delay_seconds=0,
        )

    assert calls == []


def test_manual_enrichment_workflows_have_no_schedule_or_always_publish() -> None:
    root = Path(__file__).resolve().parents[1]
    for name in ("enrich-tactical-spatial.yml", "enrich-spear-cohort-teams.yml"):
        workflow = (root / ".github" / "workflows" / name).read_text(encoding="utf-8")
        assert "workflow_dispatch:" in workflow
        assert "schedule:" not in workflow
        assert "if: always()" not in workflow
