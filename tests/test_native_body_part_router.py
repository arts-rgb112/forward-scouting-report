from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from api_server.native_body_part_contract import build_native_body_part_envelope
from api_server.native_body_part_router import create_native_body_part_router
from api_server.pitch_source_provider import ResolvedPitchPlayer
from api_server.pitch_routes import create_pitch_router


def client_for(provider):
    app = FastAPI()
    app.include_router(create_native_body_part_router(provider, lambda: ["2025/2026"]))
    return TestClient(app)


def unavailable(context, include):
    return build_native_body_part_envelope(context, [], include_penalties=include)


def test_known_unavailable_200_unknown_player_404_and_filter_roundtrip():
    client = client_for(lambda context, include: unavailable(context, include) if context.playerId == 10 else None)
    for flag in ("true", "false"):
        response = client.get(f"/api/v2/players/10/body-part-shooting-stats?includePenalties={flag}")
        assert response.status_code == 200, response.text
        assert response.json()["includePenalties"] is (flag == "true")
        assert response.json()["completeness"] == "unavailable"
        assert response.headers["cache-control"] == "no-store"
    assert client.get("/api/v2/players/11/body-part-shooting-stats").status_code == 404


@pytest.mark.parametrize("query,status", [
    ("?includePenalties=maybe", 422), ("?includePenalties=true&includePenalties=false", 422),
    ("?mode=europe&scope=8", 422), ("?mode=league&competition=ucl", 422),
    ("?season=2025/2028", 422), ("?season=2024/2025", 404), ("?unknown=1", 422),
])
def test_invalid_query_rejected_before_provider(query, status):
    calls = []
    response = client_for(lambda *args: calls.append(args)).get("/api/v2/players/10/body-part-shooting-stats" + query)
    assert response.status_code == status
    assert calls == []


def test_bad_source_filter_or_context_is_not_no_data():
    def wrong_filter(context, include):
        result = unavailable(context, include)
        result.includePenalties = not include
        return result
    assert client_for(wrong_filter).get("/api/v2/players/10/body-part-shooting-stats").status_code == 500

    def corrupt(context, include):
        raise OSError("private local file name")
    response = client_for(corrupt).get("/api/v2/players/10/body-part-shooting-stats")
    assert response.status_code == 500 and "private" not in response.text


def test_native_recorded_source_and_real_cohort_through_both_http_pk_modes():
    from api_server.service import find_v2_player

    root = Path(__file__).resolve().parents[1] / "data"

    def lookup(context):
        player = find_v2_player(context.playerId, context.season, context.mode, context.scope or 8, context.competition or "all")
        return None if player is None else ResolvedPitchPlayer(player.id, player.league.name)

    app = FastAPI()
    app.include_router(create_pitch_router(root, lookup, lambda: ["2025/2026"]))
    client = TestClient(app)
    box = client.get("/api/v2/players/194165/box-subregion-stats?scope=8")
    assert box.status_code == 200, box.text
    assert box.json()["accounting"]["source"]["shots"] == 119
    included = client.get("/api/v2/players/194165/body-part-shooting-stats?scope=8&includePenalties=true")
    excluded = client.get("/api/v2/players/194165/body-part-shooting-stats?scope=8&includePenalties=false")
    assert included.status_code == excluded.status_code == 200, (included.text, excluded.text)
    full, nonpk = included.json(), excluded.json()
    assert full["schemaVersion"] == nonpk["schemaVersion"] == "native-body-part-stats-v2"
    assert full["provider"] == "sportsapi" and full["completeness"] == "complete"
    assert (full["totals"]["shots"], full["totals"]["goals"]) == (119, 36)
    assert (nonpk["totals"]["shots"], nonpk["totals"]["goals"]) == (108, 26)
    assert nonpk["totals"]["excludedPenaltyShots"] == 11 and nonpk["totals"]["excludedPenaltyGoals"] == 10
    assert (full["parts"]["head"]["shots"], full["parts"]["head"]["goals"]) == (15, 3)
    assert (full["parts"]["leftFoot"]["shots"], full["parts"]["leftFoot"]["goals"]) == (20, 6)
    assert (full["parts"]["rightFoot"]["shots"], full["parts"]["rightFoot"]["goals"]) == (84, 27)
    assert (nonpk["parts"]["rightFoot"]["shots"], nonpk["parts"]["rightFoot"]["goals"]) == (73, 17)
    assert full["parts"]["leftFoot"]["quality"] == {"xg": 3.687, "xgot": 5.2205, "delta": 1.5335, "eligible": 19, "state": "partial"}
    assert full["totals"]["quality"] == {"xg": 26.4979, "xgot": 31.0131, "delta": 4.5152, "eligible": 118, "state": "partial"}
    assert nonpk["totals"]["quality"] == {"xg": 17.8255, "xgot": 23.0167, "delta": 5.1912, "eligible": 107, "state": "partial"}
    assert full["parts"]["unknown"]["quality"] == full["parts"]["other"]["quality"] == {"xg": 0.0, "xgot": 0.0, "delta": 0.0, "eligible": 0, "state": "complete"}
