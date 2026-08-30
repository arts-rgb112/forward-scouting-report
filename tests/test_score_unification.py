from __future__ import annotations

import pytest

from api_server import service


WEIGHTS = {
    "boxThreat": 30,
    "outsideShot": 20,
    "dangerZone": 15,
    "spaceControl": 15,
    "combinedDuel": 10,
    "forwardPress": 10,
}


def test_kane_profile_and_detail_headers_share_one_pressing_score() -> None:
    """The public headline is exactly reconstructable from six card headers."""
    detail = service.build_player_detail(194165, "2025/2026", "league", 7, "all")
    board = service.find_duel_press_detail_readouts_v2(
        194165, "2025/2026", "league", 7, "all",
    )
    assert detail is not None and board is not None

    weighted = sum(
        WEIGHTS[category.id] * float(category.percentileScore or 0)
        for category in board.categories
    ) / 100.0
    assert detail.score == pytest.approx(weighted, abs=0.01)
    assert detail.analysis.score.value == pytest.approx(weighted, abs=0.01)
    assert board.ratingVersion == "messi-score-unified-v3"
    assert all(category.formulaId == "pressing-sector-score-v3" for category in board.categories)
    assert all(category.formulaVersion == "messi-score-unified-v3" for category in board.categories)
