from __future__ import annotations

from types import SimpleNamespace
import unicodedata

import pytest
from fastapi.testclient import TestClient

from api_server import service
from api_server.main import app
from api_server.search import canonical_search_key


@pytest.mark.parametrize(
    ("accented", "ascii"),
    [
        ("Díaz", "diaz"),
        ("Gündoğan", "gundogan"),
        ("Šeško", "sesko"),
        ("João", "joao"),
        ("Ødegaard", "odegaard"),
        ("Çalhanoğlu", "calhanoglu"),
        ("Łukasz Đorđević", "lukasz dordevic"),
        ("Þór Ægir Œuvre", "thor aegir oeuvre"),
    ],
)
def test_canonical_search_key_folds_latin_diacritics(accented: str, ascii: str) -> None:
    assert canonical_search_key(accented) == ascii


def test_canonical_search_key_is_nfc_nfd_case_whitespace_and_korean_safe() -> None:
    nfc = "  Luís   Díaz\t"
    nfd = unicodedata.normalize("NFD", nfc)
    assert canonical_search_key(nfc) == canonical_search_key(nfd) == "luis diaz"
    assert canonical_search_key("손흥민") == "손흥민"
    assert canonical_search_key(" \n\t ") == ""


def _player(player_id: int, name: str, club: str, league: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=player_id,
        rank=player_id,
        name=name,
        club=SimpleNamespace(name=club),
        league=SimpleNamespace(name=league),
        archetype="Type A",
        position="Striker",
        age=24,
        minutes=1200,
    )


def _matched_ids(rows: tuple[SimpleNamespace, ...], query: str) -> list[int]:
    applied = service.canonical_leaderboard_filters(
        role=None, position=None, age_band="all", minutes_band="all",
        query=query, sort="rank", order="asc",
    )
    haystacks = service._cached_search_haystacks(
        kind="unit", season="2025/2026", mode="league", scope=8,
        competition="all", rows=rows,
    )
    return [
        player.id for player in service._apply_leaderboard_filters(
            rows, applied, search_haystacks=haystacks,
        )
    ]


def test_normalized_haystack_matches_name_club_and_league_once_per_cohort() -> None:
    rows = (
        _player(1, "Luis Díaz", "Bayern München", "Bundesliga"),
        _player(2, "Other Player", "Malmö FF", "Allsvenskan"),
    )
    service._clear_search_haystack_cache()

    assert _matched_ids(rows, "Luis Diaz") == [1]
    assert _matched_ids(rows, "Bayern Munchen") == [1]
    assert _matched_ids(rows, "Malmo") == [2]
    assert service._search_haystack_cache_builds == 1

    # A refreshed cohort at the same context must rebuild its own keys rather
    # than reuse strings from a prior snapshot identity.
    refreshed_rows = tuple(list(rows))
    assert _matched_ids(refreshed_rows, "Bundesliga") == [1]
    assert service._search_haystack_cache_builds == 2


@pytest.mark.parametrize(
    ("endpoint", "context"),
    [
        ("/api/v2/leaderboards", {"mode": "league", "scope": 8, "competition": "all"}),
        ("/api/v2/leaderboards", {"mode": "europe", "competition": "ucl"}),
        ("/api/v2/leaderboards/duel-press", {"mode": "league", "scope": 8, "competition": "all"}),
        ("/api/v2/leaderboards/duel-press", {"mode": "europe", "competition": "ucl"}),
    ],
)
def test_ascii_and_accented_queries_have_identical_server_page_results(
    endpoint: str, context: dict[str, object],
) -> None:
    client = TestClient(app)
    common = {
        "season": "2025/2026", "page": 1, "pageSize": 50,
        "sort": "rank", "order": "asc", **context,
    }
    ascii_response = client.get(endpoint, params={**common, "q": "Luis Diaz"})
    accented_response = client.get(endpoint, params={**common, "q": "Luis Díaz"})
    assert ascii_response.status_code == accented_response.status_code == 200
    ascii_payload = ascii_response.json()
    accented_payload = accented_response.json()

    assert [row["id"] for row in ascii_payload["data"]] == [
        row["id"] for row in accented_payload["data"]
    ]
    assert [(row["id"], row["rank"]) for row in ascii_payload["data"]] == [
        (row["id"], row["rank"]) for row in accented_payload["data"]
    ]
    assert 860914 in [row["id"] for row in ascii_payload["data"]]
    assert next(row["name"] for row in ascii_payload["data"] if row["id"] == 860914) == "Luis Díaz"

    for field in ("season", "mode", "scope", "competition", "population", "returned", "page", "pageSize", "totalItems", "totalPages", "hasNextPage"):
        assert ascii_payload["meta"].get(field) == accented_payload["meta"].get(field)
    assert {**ascii_payload["meta"]["applied"], "q": None} == {
        **accented_payload["meta"]["applied"], "q": None,
    }
    assert ascii_payload["meta"]["applied"]["q"] == "Luis Diaz"
    assert accented_payload["meta"]["applied"]["q"] == "Luis Díaz"
