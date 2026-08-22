"""Generate deterministic, full-response fixtures for the duel-press-v2 trio.

The fixture inputs intentionally use one checked-in player and one checked-in
static detail row.  No network request or live dataset is used.  Each emitted
document has complete board, player, and detail endpoint payloads so consumers
can validate every response against its strict Pydantic model.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api_server import service
from api_server.schemas import DuelPressPlayerEnvelope


FIXTURES = ROOT / "docs" / "fixtures" / "duel_press_v2"
PLAYER_FIXTURE = ROOT / "docs" / "fixtures" / "duel_press_v1" / "valid_player_detail.json"
RECORD_FIXTURE = ROOT / "docs" / "fixtures" / "duel_press_detail_readouts" / "complete_static_record.json"


def _player():
    return DuelPressPlayerEnvelope.model_validate(json.loads(PLAYER_FIXTURE.read_text(encoding="utf-8"))).data


def _record() -> dict[str, object]:
    return json.loads(RECORD_FIXTURE.read_text(encoding="utf-8"))


def _responses(*, mode: str, competition: str, mutation: dict[str, object] | None = None) -> dict[str, object]:
    player = _player()
    record = _record()
    record["player_id"] = player.id
    record.update(mutation or {})
    scope = 8
    with (
        patch.object(service, "build_duel_press_players", lambda *args: (player,)),
        patch.object(service, "_detail_frame_records", lambda *args: [record]),
    ):
        service._v2_frame_cached.cache_clear()
        board = service.duel_press_v2_leaderboard_envelope(
            "2025/2026", mode, scope, competition, page=1, page_size=50,
            role=None, position=None, age_band="all", minutes_band="all",
            query=None, sort="rank", order="asc",
        )
        profile = service.find_duel_press_v2_player(player.id, "2025/2026", mode, scope, competition)
        detail = service.find_duel_press_detail_readouts_v2(player.id, "2025/2026", mode, scope, competition)
    assert profile is not None and detail is not None
    return {
        "leaderboard": board.model_dump(mode="json"),
        "player": profile.model_dump(mode="json"),
        "detail": detail.model_dump(mode="json"),
    }


def _write(name: str, document: dict[str, object]) -> None:
    (FIXTURES / name).write_text(
        json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    league_request = {"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all"}
    complete = _responses(mode="league", competition="all")
    _write("complete_league.json", {
        "request": league_request,
        "payload": {
            "schemaVersion": "2.0.0", "metricTaxonomyVersion": "duel-press-v2",
            "readoutVersion": "detail-readout-v2", "ratingVersion": "stat-pairs-v2",
            "ratingSnapshotId": complete["detail"]["ratingSnapshotId"],
            "categoryOrder": [item["id"] for item in complete["detail"]["categories"]],
            "contextIndicatorOrder": [item["id"] for item in complete["detail"]["contextIndicators"]],
            "completePair": {"pairState": "complete", "pairReason": None, "total": 4, "per90": 0.2, "percentileScore": 99},
        },
        "responses": complete,
    })

    europe = _responses(mode="europe", competition="ucl")
    _write("complete_europe.json", {
        "request": {"season": "2025/2026", "mode": "europe", "competition": "ucl"},
        "payload": {
            "schemaVersion": "2.0.0", "metricTaxonomyVersion": "duel-press-v2",
            "readoutVersion": "detail-readout-v2", "ratingVersion": "stat-pairs-v2",
            "context": {"mode": "europe", "scope": None, "competition": "ucl"},
        },
        "responses": europe,
    })

    observed_zero = _responses(mode="league", competition="all", mutation={
        "out_box_shots_raw": 0, "out_box_xg_raw": 0, "out_box_xgot_raw": 0,
    })
    _write("observed_zero.json", {
        "mutation": {"out_box_shots_raw": 0, "out_box_xg_raw": 0, "out_box_xgot_raw": 0},
        "payload": {"state": "observed", "value": 0, "pairState": "complete"},
        "responses": observed_zero,
    })

    unavailable = _responses(mode="league", competition="all", mutation={"dribble_success_rate_raw": 0})
    unavailable_payload = {"state": "unavailable", "value": None, "percentileScore": None, "pairState": "unavailable", "pairReason": "source_unavailable"}
    _write("unavailable.json", {
        "mutation": {"dribble_success_rate_raw": 0}, "payload": unavailable_payload,
        "responses": unavailable,
    })

    partial = _responses(mode="league", competition="all", mutation={"minutes_played": 0})
    _write("partial_pair.json", {
        "mutation": {"minutes_played": 0},
        "payload": {"totalState": "observed", "total": 4, "per90State": "unavailable", "per90": None, "pairState": "partial", "pairReason": "minutes_unavailable_or_nonpositive"},
        "responses": partial,
    })

    imputed = _responses(mode="league", competition="all", mutation={"dribble_success_rate_raw": 0})
    _write("imputed_lower_better.json", {
        "lowerIsBetter": {"values": [1, 2, 3], "best": {"rank": 1, "percentileScore": 99}, "worst": {"rank": 3, "percentileScore": 0}},
        "imputed": {"mutation": {"dribble_success_rate_raw": 0}, "category": "dangerZone", "scoreState": "imputed", "missingComponent": "dribble_attempts_raw"},
        "responses": imputed,
    })


if __name__ == "__main__":
    main()
