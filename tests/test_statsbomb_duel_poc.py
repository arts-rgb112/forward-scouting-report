import csv
import json

import pytest

from scripts.statsbomb_duel_poc import (
    build_poc, classify_statsbomb_duel, main, normalize_statsbomb_location,
)


def player(player_id: int, name: str) -> dict[str, object]:
    return {"id": player_id, "name": name}


def event(event_type: str, player_data=None, location=None, minute=10, **detail):
    value = {
        "id": f"{event_type}-{minute}-{player_data}", "index": minute,
        "period": 1, "minute": minute, "second": 0,
        "type": {"name": event_type},
    }
    if player_data is not None:
        value["player"] = player_data
    if location is not None:
        value["location"] = location
    value.update(detail)
    return value


def starting_xi(*players):
    return event("Starting XI", tactics={"lineup": [{"player": item} for item in players]}, minute=0)


def test_statsbomb_120x80_coordinates_are_scaled_and_lane_axis_is_inverted():
    assert normalize_statsbomb_location([0, 0]) == (0.0, 100.0)
    assert normalize_statsbomb_location([120, 80]) == (100.0, 0.0)
    assert normalize_statsbomb_location([90, 24]) == (75.0, 70.0)
    with pytest.raises(ValueError, match="location_out_of_bounds"):
        normalize_statsbomb_location([121, 40])


def test_official_ground_and_aerial_shapes_are_classified_conservatively():
    ground, reason = classify_statsbomb_duel(event(
        "Duel", player(1, "A"), [108, 40], duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Success In Play"},
        },
    ))
    assert reason is None and ground is not None
    assert (ground.duel.duel_type, ground.duel.won, ground.duel.x, ground.duel.y) == ("ground", True, 90.0, 50.0)

    lost, reason = classify_statsbomb_duel(event(
        "Duel", player(2, "B"), [60, 40], duel={"type": {"name": "Aerial Lost"}},
    ))
    assert reason is None and lost is not None
    assert (lost.duel.duel_type, lost.duel.won) == ("aerial", False)

    won, reason = classify_statsbomb_duel(event(
        "Clearance", player(1, "A"), [90, 24], clearance={"aerial_won": True},
    ))
    assert reason is None and won is not None
    assert (won.duel.duel_type, won.duel.won) == ("aerial", True)

    unknown, reason = classify_statsbomb_duel(event(
        "Duel", player(1, "A"), [60, 40], duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Maybe"},
        },
    ))
    assert unknown is None and reason == "ambiguous_ground_outcome"


def test_pipeline_outputs_weighted_values_rank_changes_and_exclusion_audit(tmp_path):
    a, b = player(1, "A"), player(2, "B")
    events = [
        starting_xi(a, b),
        # A: one Tier-1 win (raw 1, weighted 3).
        event("Duel", a, [108, 40], minute=10, duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Won"},
        }),
        # B: two Tier-3 wins (raw 2, weighted 2).
        event("Duel", b, [60, 40], minute=20, duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Success"},
        }),
        event("Duel", b, [48, 16], minute=30, duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Success Out"},
        }),
        event("Duel", b, [60, 40], minute=40, duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Unknown"},
        }),
        event("Duel", a, [60, 40], minute=45, duel={"type": {"name": "Aerial Lost"}}),
        event("Clearance", b, [90, 24], minute=45, clearance={"aerial_won": True}),
    ]
    source = tmp_path / "1001.json"
    source.write_text(json.dumps(events), encoding="utf-8")
    result = build_poc(source)

    assert result["meta"]["matchCount"] == 1
    assert result["meta"]["matchIds"] == ["1001"]
    assert result["meta"]["rankBasis"] == "wins-per-90 versus spatially-weighted-wins-per-90"
    assert result["audit"] == {
        "classified_aerial_lost": 1, "classified_aerial_won": 1,
        "classified_ground_won": 3, "excluded_ambiguous_ground_outcome": 1,
    }
    rows = {row["playerId"]: row for row in result["players"]}
    assert rows["1"]["groundRawWins"] == 1
    assert rows["1"]["groundWeightedWins"] == 3.0
    assert rows["1"]["groundBoxDuelsWon"] == rows["1"]["boxDuelsWon"] == 1
    assert rows["2"]["groundRawWins"] == 2
    assert rows["2"]["groundWeightedWins"] == 2.0
    assert rows["1"]["existingGroundRank"] == 2
    assert rows["1"]["newGroundRank"] == 1
    assert rows["1"]["groundRankDelta"] == 1
    assert rows["2"]["aerialWeightedWins"] == 1.5
    assert rows["2"]["aerialWinsByCell"]["d5l4"] == 1


def test_shootout_period_is_never_counted_as_match_duel_activity(tmp_path):
    a = player(1, "A")
    shootout_duel = event(
        "Duel", a, [108, 40], minute=121,
        duel={"type": {"name": "Tackle"}, "outcome": {"name": "Won"}},
    )
    shootout_duel["period"] = 5
    source = tmp_path / "shootout.json"
    source.write_text(json.dumps([starting_xi(a), shootout_duel]), encoding="utf-8")

    result = build_poc(source)

    assert result["audit"]["excluded_shootout_event"] == 1
    assert result["players"][0]["groundRawWins"] == 0
    assert result["players"][0]["groundWeightedWins"] == 0.0


def test_cli_writes_csv_and_json_without_network_access(tmp_path):
    a = player(1, "A")
    source = tmp_path / "match.json"
    source.write_text(json.dumps([
        starting_xi(a),
        event("Duel", a, [108, 40], duel={
            "type": {"name": "Tackle"}, "outcome": {"name": "Won"},
        }),
    ]), encoding="utf-8")
    prefix = tmp_path / "out" / "duels"
    assert main([str(source), "--output-prefix", str(prefix)]) == 0
    payload = json.loads(prefix.with_suffix(".json").read_text(encoding="utf-8"))
    assert payload["meta"]["source"] == "StatsBomb Open Data"
    with prefix.with_suffix(".csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["playerName"] == "A"
    assert json.loads(rows[0]["groundWinsByCell"])["d6l3"] == 1
