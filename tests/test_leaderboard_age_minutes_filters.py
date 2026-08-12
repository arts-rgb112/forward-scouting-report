from __future__ import annotations

import pytest

from api_server import service
from api_server.main import app
from api_server.schemas import AssetRef, PlayerResponse, PlayerStats, PlayerTier
from fastapi.testclient import TestClient


client = TestClient(app)


def make_player(
    player_id: int, *, rank: int | None = None, age: int | None = 24,
    minutes: int = 1200, role: str = "Type A", position: str = "Striker",
    name: str | None = None, score: float = 50.0, metric: float = 50.0,
) -> PlayerResponse:
    return PlayerResponse(
        id=player_id,
        rank=rank or player_id,
        name=name or f"Player {player_id}",
        position=position,
        archetype=role,
        age=age,
        minutes=minutes,
        tier=PlayerTier(code="silver", level=1, label="Silver"),
        score=score,
        face=f"https://images.example.test/player-{player_id}.png",
        nation=None,
        league=AssetRef(id=1, name="Test League", icon="https://images.example.test/league.png"),
        club=AssetRef(id=1, name="Son Test Club", icon="https://images.example.test/club.png"),
        stats=PlayerStats(
            outsideShot=metric,
            boxThreat=metric,
            dangerZone=metric,
            aerial=metric,
            groundDuel=metric,
            spaceControl=metric,
        ),
    )


@pytest.mark.parametrize(
    ("age", "expected"),
    [
        (22, {"u23"}),
        (23, {"u25"}),
        (25, {"u25"}),
        (26, {"26-30"}),
        (30, {"26-30"}),
        (31, {"31-plus"}),
        (None, set()),
    ],
)
def test_age_band_boundaries(age, expected):
    bands = ("u23", "u25", "26-30", "31-plus")
    assert service.matches_age_band(age, "all") is True
    assert {band for band in bands if service.matches_age_band(age, band)} == expected


@pytest.mark.parametrize(
    ("minutes", "expected"),
    [
        (199, set()),
        (200, {"200-499"}),
        (499, {"200-499"}),
        (500, {"500-999"}),
        (999, {"500-999"}),
        (1000, {"1000-1499"}),
        (1499, {"1000-1499"}),
        (1500, {"1500-1999"}),
        (1999, {"1500-1999"}),
        (2000, {"2000-2999"}),
        (2999, {"2000-2999"}),
        (3000, {"3000-plus"}),
    ],
)
def test_minutes_band_boundaries(minutes, expected):
    bands = (
        "200-499", "500-999", "1000-1499", "1500-1999",
        "2000-2999", "3000-plus",
    )
    assert service.matches_minutes_band(minutes, "all") is True
    assert {band for band in bands if service.matches_minutes_band(minutes, band)} == expected


def test_combined_filters_run_before_pagination_and_echo_exact_applied_values(monkeypatch):
    rows = tuple(
        make_player(
            index,
            age=24 if index <= 55 else 31,
            minutes=1200 if index <= 55 else 100,
            role="Type A" if index <= 55 else "Type B",
            position="Striker" if index <= 55 else "Winger",
            name=f"Son Candidate {index}" if index <= 55 else f"Other {index}",
            score=float(100 - index % 20),
        )
        for index in range(1, 66)
    )
    monkeypatch.setattr(service, "build_v2_players", lambda *args: rows)

    response = client.get("/api/v2/leaderboards", params={
        "season": "2025/2026", "page": 1, "pageSize": 50,
        "role": "Type A", "position": "Striker", "ageBand": "u25",
        "minutesBand": "1000-1499", "q": "Son", "sort": "score", "order": "desc",
    })

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["data"]) == payload["meta"]["returned"] == 50
    assert payload["meta"]["population"] == payload["meta"]["totalItems"] == 55
    assert payload["meta"]["totalPages"] == 2
    assert payload["meta"]["hasNextPage"] is True
    assert payload["meta"]["applied"] == {
        "role": "Type A", "position": "Striker", "q": "Son",
        "ageBand": "u25", "minutesBand": "1000-1499",
        "sort": "score", "order": "desc",
    }
    assert all(
        row["archetype"] == "Type A" and row["position"] == "Striker"
        and 23 <= row["age"] <= 25 and 1000 <= row["minutes"] <= 1499
        and "son" in row["name"].casefold()
        for row in payload["data"]
    )


def test_null_age_and_sub_200_minutes_are_only_present_in_all(monkeypatch):
    rows = (
        make_player(1, age=None, minutes=199),
        make_player(2, age=22, minutes=200),
    )
    monkeypatch.setattr(service, "build_v2_players", lambda *args: rows)

    all_rows = client.get("/api/v2/leaderboards", params={"page": 1, "pageSize": 50})
    filtered = client.get("/api/v2/leaderboards", params={
        "page": 1, "pageSize": 50, "ageBand": "u23", "minutesBand": "200-499",
    })

    assert [row["id"] for row in all_rows.json()["data"]] == [1, 2]
    assert all_rows.json()["data"][0]["age"] is None
    assert all_rows.json()["meta"]["applied"] == {
        "role": None, "position": None, "q": None,
        "ageBand": "all", "minutesBand": "all",
        "sort": "rank", "order": "asc",
    }
    assert [row["id"] for row in filtered.json()["data"]] == [2]


@pytest.mark.parametrize(
    "sort",
    ["score", "outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"],
)
def test_score_and_metric_sorts_keep_filtered_page_counts(sort, monkeypatch):
    rows = tuple(
        make_player(
            index, age=24, minutes=1200, score=float(index % 13),
            metric=float(index % 11),
        )
        for index in range(1, 78)
    )
    monkeypatch.setattr(service, "build_v2_players", lambda *args: rows)
    response = client.get("/api/v2/leaderboards", params={
        "page": 1, "pageSize": 50, "ageBand": "u25",
        "minutesBand": "1000-1499", "sort": sort, "order": "desc",
    })
    payload = response.json()
    assert response.status_code == 200
    assert len(payload["data"]) == payload["meta"]["returned"] == 50
    assert payload["meta"]["totalItems"] == payload["meta"]["population"] == 77
    assert payload["meta"]["totalPages"] == 2
    assert payload["meta"]["hasNextPage"] is True
    values = [
        row["score"] if sort == "score" else row["stats"][sort]
        for row in payload["data"]
    ]
    assert values == sorted(values, reverse=True)


@pytest.mark.parametrize("order", ["asc", "desc"])
def test_equal_primary_values_always_tie_break_by_rank_then_id(order, monkeypatch):
    rows = (
        make_player(30, rank=2, score=77),
        make_player(20, rank=1, score=77),
        make_player(10, rank=1, score=77),
        make_player(40, rank=3, score=77),
    )
    monkeypatch.setattr(service, "build_v2_players", lambda *args: rows)
    response = client.get("/api/v2/leaderboards", params={
        "page": 1, "pageSize": 50, "sort": "score", "order": order,
    })
    assert [row["id"] for row in response.json()["data"]] == [10, 20, 30, 40]


@pytest.mark.parametrize("order", ["asc", "desc"])
def test_equal_score_page_boundary_has_no_duplicates_or_omissions(order, monkeypatch):
    rows = tuple(make_player(index, rank=index, score=77) for index in range(1, 61))
    monkeypatch.setattr(service, "build_v2_players", lambda *args: rows)
    common = {"pageSize": 50, "sort": "score", "order": order}
    first = client.get("/api/v2/leaderboards", params={**common, "page": 1}).json()
    second = client.get("/api/v2/leaderboards", params={**common, "page": 2}).json()
    ids = [row["id"] for row in first["data"] + second["data"]]
    assert ids == list(range(1, 61))
    assert len(ids) == len(set(ids)) == first["meta"]["totalItems"] == 60
    assert first["meta"]["hasNextPage"] is True
    assert second["meta"]["hasNextPage"] is False


@pytest.mark.parametrize(
    ("key", "value"),
    [("ageBand", "under-21"), ("minutesBand", "0-199")],
)
def test_unknown_filter_enum_is_422(key, value):
    response = client.get("/api/v2/leaderboards", params={"page": 1, key: value})
    assert response.status_code == 422


def test_openapi_exposes_filter_enums_applied_echo_and_total_items():
    document = client.get("/openapi.json").json()
    operation = document["paths"]["/api/v2/leaderboards"]["get"]
    parameters = {parameter["name"]: parameter["schema"] for parameter in operation["parameters"]}
    assert set(parameters["ageBand"]["enum"]) == {"all", "u23", "u25", "26-30", "31-plus"}
    assert set(parameters["minutesBand"]["enum"]) == {
        "all", "200-499", "500-999", "1000-1499", "1500-1999",
        "2000-2999", "3000-plus",
    }
    schemas = document["components"]["schemas"]
    page_meta = schemas["LeaderboardPageMeta"]["properties"]
    assert page_meta["totalItems"]["minimum"] == 0
    assert page_meta["applied"]["$ref"].endswith("/LeaderboardAppliedFilters")
    applied = schemas["LeaderboardAppliedFilters"]["properties"]
    assert applied["ageBand"]["default"] == "all"
    assert applied["minutesBand"]["default"] == "all"
