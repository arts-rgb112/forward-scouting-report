"""Regression coverage for bounded native player-history summary reads."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from api_server import main, service
from rankings import get_spear_leaderboard
from tactical_ratio import (
    _file_version, _heatmap_value_offsets, _load_heatmap_points_for_key,
    _tactical_ratios_by_player,
)


HARRY_ID = 194165
HISTORICAL_CONTEXTS = tuple(
    (season, mode)
    for season in ("2024/2025", "2023/2024", "2022/2023", "2021/2022")
    for mode in ("league", "europe")
)


def _summary_params(season: str, mode: str) -> dict[str, str | int]:
    # The established player endpoint accepts scope=8 for Europe history
    # requests.  Keep that compatibility while strict companion APIs omit it.
    return {
        "season": season,
        "mode": mode,
        "scope": 8,
        "competition": "all",
        "includeAnalysis": "false",
    }


@pytest.mark.parametrize(("season", "mode"), HISTORICAL_CONTEXTS)
def test_historical_summary_contexts_settle_with_existing_contract(season: str, mode: str):
    """Every valid historical context returns a terminal 200 or normal 404."""
    response = TestClient(main.app).get(
        f"/api/v2/players/{HARRY_ID}", params=_summary_params(season, mode),
    )
    assert response.status_code in {200, 404}
    if response.status_code == 200:
        body = response.json()
        assert body["data"]["id"] == HARRY_ID
        assert response.headers["x-request-id"]
        assert "player-summary" in response.headers["server-timing"]


def test_summary_timeout_is_bounded_and_observable(monkeypatch):
    main._PLAYER_SUMMARY_INFLIGHT.clear()
    monkeypatch.setattr(main, "PLAYER_SUMMARY_DEADLINE_SECONDS", 0.01)

    def slow_summary(*_args):
        time.sleep(0.05)
        return None, {"phaseCohortIndexMs": 50.0, "indexCache": "miss"}

    monkeypatch.setattr(main, "find_v2_player_summary_timed", slow_summary)
    with TestClient(main.app, raise_server_exceptions=False) as client:
        started = time.perf_counter()
        response = client.get(
            f"/api/v2/players/{HARRY_ID}", params=_summary_params("2024/2025", "league"),
            headers={"X-Request-Id": "history-timeout-test"},
        )
        elapsed = time.perf_counter() - started

    assert response.status_code == 504
    assert elapsed < 0.04
    assert "exceeded" in response.json()["detail"]
    # The CPU worker is deliberately shielded from request cancellation.  It
    # clears its same-context single-flight entry on completion.
    time.sleep(0.06)
    assert not main._PLAYER_SUMMARY_INFLIGHT


def test_four_concurrent_cold_history_contexts_finish_before_browser_deadline():
    """The frontend's four-request batch must not recreate the old pile-up."""
    service._v2_player_summary_index.cache_clear()
    service.build_v2_players.cache_clear()
    get_spear_leaderboard.cache_clear()
    _tactical_ratios_by_player.cache_clear()
    _heatmap_value_offsets.cache_clear()
    main._PLAYER_SUMMARY_INFLIGHT.clear()
    contexts = (
        ("2024/2025", "league"),
        ("2024/2025", "europe"),
        ("2023/2024", "league"),
        ("2023/2024", "europe"),
    )

    def fetch(context: tuple[str, str]) -> int:
        season, mode = context
        with TestClient(main.app) as client:
            return client.get(
                f"/api/v2/players/{HARRY_ID}", params=_summary_params(season, mode),
            ).status_code

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=4) as executor:
        statuses = list(executor.map(fetch, contexts))
    elapsed = time.perf_counter() - started

    assert statuses and all(status in {200, 404} for status in statuses)
    assert elapsed < 8.0


def test_summary_cors_keeps_production_preview_and_hostile_boundaries():
    client = TestClient(main.app)
    production = "https://forward-scouting-report-6dn7-tau.vercel.app"
    preview = "https://forward-scouting-report-6dn7-pr-220-messiflick.vercel.app"
    for origin in (production, preview):
        response = client.get(
            f"/api/v2/players/{HARRY_ID}", params=_summary_params("2024/2025", "league"),
            headers={"Origin": origin},
        )
        assert response.status_code in {200, 404}
        assert response.headers.get("access-control-allow-origin") == origin
    hostile = client.get(
        f"/api/v2/players/{HARRY_ID}", params=_summary_params("2024/2025", "league"),
        headers={"Origin": "https://hostile.example"},
    )
    assert "access-control-allow-origin" not in hostile.headers


def test_summary_index_is_context_keyed_and_avoids_repeat_scan(monkeypatch):
    service._v2_player_summary_index.cache_clear()
    calls: list[tuple[str, str, int, str]] = []

    def fake_players(season: str, mode: str, scope: int, competition: str):
        calls.append((season, mode, scope, competition))
        return ()

    monkeypatch.setattr(service, "build_v2_players", fake_players)
    service.find_v2_player(1, "2024/2025", "league", 8, "all")
    service.find_v2_player(2, "2024/2025", "league", 8, "all")
    service.find_v2_player(1, "2024/2025", "europe", 8, "all")
    assert calls == [
        ("2024/2025", "league", 8, "all"),
        ("2024/2025", "europe", 8, "all"),
    ]
    service._v2_player_summary_index.cache_clear()


def test_heatmap_key_offsets_do_not_rescan_from_file_start(tmp_path):
    snapshot = tmp_path / "heatmap.json"
    snapshot.write_text('{"one":[[1,2]],"two":[[3,4]]}', encoding="utf-8")
    version = _file_version(snapshot)
    assert version is not None
    _heatmap_value_offsets.cache_clear()
    assert _heatmap_value_offsets(str(snapshot), version) == {"one": 7, "two": 21}
    assert _load_heatmap_points_for_key(str(snapshot), version, "two") == ((3, 4),)
    _heatmap_value_offsets.cache_clear()
