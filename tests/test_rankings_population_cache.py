from __future__ import annotations

import base64
import json
import zlib
from dataclasses import asdict

import rankings


_BASELINE_FIELDS_B64 = (
    "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"
)


def _baseline_fields() -> dict[str, dict[str, object]]:
    fixture = json.loads(zlib.decompress(base64.b64decode(_BASELINE_FIELDS_B64)))
    tuple_fields = (
        "spear_imputed_volume_attrs", "spear_imputed_ratio_attrs",
        "pressing_imputed_volume_attrs", "pressing_imputed_ratio_attrs",
    )
    for fields in fixture.values():
        for field in tuple_fields:
            fields[field] = tuple(fields[field])
    return fixture


CONTEXTS = (
    (47, "2021/2022", 3),
    (54, "2023/2024", 7),
    (42, "2023/2024", 7),
)

# SHA-256 of canonical JSON for every LeaguePercentiles field, generated from
# merge-base c6b9104d45390e9199301ec1a3b877ddce244d89 before the cache refactor.
BASELINE_CASES = {
    (47, "2021/2022", 3): (
        "493647", "466482", "1021382", "732282",
    ),
    (54, "2023/2024", 7): (
        "1156141", "530859", "959404", "1430151",
    ),
    (42, "2023/2024", 7): (
        "942368", "846033", "1021586", "1467236",
    ),
}


def test_cache_refactor_preserves_pre_change_fields_for_twelve_players() -> None:
    """All 107 fields must match the committed pre-change implementation."""
    compared_players = 0
    compared_contexts = 0
    baseline = _baseline_fields()
    for league_id, season, scope in CONTEXTS:
        peers, _ = rankings._fetch_elite_dribbler_metrics(
            league_id, season, True, 0, scope,
        )
        cases = BASELINE_CASES[(league_id, season, scope)]
        rankings._league_percentile_population.cache_clear()
        for player_id in cases:
            metrics = peers[player_id]
            result = rankings.calculate_league_percentiles(
                player_id, season, metrics, comparison_scope=scope,
            )
            fixture_key = f"{league_id}|{season}|{scope}|{player_id}"
            assert asdict(result) == baseline[fixture_key]
        cache_info = rankings._league_percentile_population.cache_info()
        assert cache_info.maxsize == 160
        assert cache_info.misses == 1
        assert cache_info.hits == 3
        compared_players += len(cases)
        compared_contexts += 1

    assert compared_players == 12
    assert compared_contexts == 3


def test_subject_missing_from_static_cohort_is_added_outside_cached_population() -> None:
    league_id, season, scope = CONTEXTS[0]
    peers, _ = rankings._fetch_elite_dribbler_metrics(league_id, season, True, 0, scope)
    _, metrics = next(
        (player_id, metric) for player_id, metric in peers.items()
        if metric.league_id == league_id
    )
    missing_player_id = "subject-not-in-static-cohort"

    rankings._league_percentile_population.cache_clear()
    base = rankings._league_percentile_population(
        season, league_id, metrics.league_name or "",
        rankings._minimum_xg_for_competition(league_id), True, 0, scope, "auto",
    )
    result = rankings.calculate_league_percentiles(
        missing_player_id, season, metrics, comparison_scope=scope,
    )

    assert missing_player_id not in base["peer_ids"]
    assert result.eligible_players == int(base["cohort_count"]) + 1
    assert asdict(result) == _baseline_fields()["missing-static-subject"]
    assert rankings._league_percentile_population.cache_info().currsize == 1
