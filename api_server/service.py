from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from rankings import get_spear_leaderboard
from spear_cohort import load_spear_cohort

from .schemas import AssetRef, DatasetMeta, PlayerResponse, PlayersEnvelope, PlayerStats, PlayerTier


TIER_BANDS = (
    ("diamond", "Diamond", 0.0, 4.0),
    ("platinum", "Platinum", 4.0, 11.0),
    ("gold", "Gold", 11.0, 40.0),
    ("silver", "Silver", 40.0, 77.0),
    ("bronze", "Bronze", 77.0, 96.0),
    ("iron", "Iron", 96.0, 100.0),
)


def tier_from_rank(rank: int, population: int) -> PlayerTier:
    """Map the existing M.E.S.S.I. percentile bands to the v1 API tier object."""
    percentile = min(100.0, max(0.0, ((rank - 1) / max(population, 1)) * 100.0))
    for index, (code, label, start, end) in enumerate(TIER_BANDS):
        if percentile <= end or index == len(TIER_BANDS) - 1:
            width = (end - start) / 5.0
            level = min(5, max(1, int((percentile - start) / width) + 1))
            return PlayerTier(code=code, level=level, label=label)
    raise AssertionError("tier bands must cover 0–100")


def _asset_id(value: object) -> int:
    try:
        parsed = float(str(value))
    except (TypeError, ValueError):
        return 0
    return int(parsed) if parsed == parsed else 0


def _source_player_id(value: object) -> int:
    """Reject malformed source IDs instead of exposing a frontend-invalid zero ID."""
    parsed = float(str(value))
    if parsed != parsed or not parsed.is_integer() or parsed <= 0:
        raise ValueError("player_id must be a positive integer")
    return int(parsed)


@lru_cache(maxsize=16)
def build_players(season: str, scope: int) -> tuple[PlayerResponse, ...]:
    frame = get_spear_leaderboard(47, season, scope)
    population = len(frame)
    players: list[PlayerResponse] = []
    for record in frame.to_dict(orient="records"):
        try:
            player_id = _source_player_id(record["player_id"])
        except (TypeError, ValueError):
            # A source row without a usable ID cannot be selected, compared,
            # or keyed safely by the strict frontend contract.
            continue
        rank = int(record["rank"])
        players.append(PlayerResponse(
            id=player_id,
            rank=rank,
            name=str(record["player_name"]),
            position=str(record.get("position") or "FW"),
            archetype=str(record.get("role") or "Type A"),
            age=None,
            minutes=max(0, round(float(record.get("minutes_played") or 0))),
            tier=tier_from_rank(rank, population),
            score=round(float(record["score"]), 2),
            face=None,
            nation=None,
            league=AssetRef(id=_asset_id(record.get("league_id") or 0), name=str(record.get("league_name") or "Unknown league"), icon=None),
            club=AssetRef(id=_asset_id(record.get("team_id") or 0), name=str(record.get("team_name") or "Unknown club"), icon=None),
            stats=PlayerStats(
                outsideShot=round(float(record["outside_shot_score"]), 2),
                boxThreat=round(float(record["deep_box_score"]), 2),
                dangerZone=round(float(record["danger_zone_score"]), 2),
                aerial=round(float(record["aerial_score"]), 2),
                groundDuel=round(float(record["ground_duel_score"]), 2),
                spaceControl=round(float(record["space_control_score"]), 2),
            ),
        ))
    return tuple(players)


@lru_cache(maxsize=1)
def dataset_generated_at() -> datetime:
    """Deterministic snapshot time derived from the static inputs, never request time."""
    root = Path(__file__).resolve().parents[1] / "data"
    inputs = (root / "spear_cohort.csv", root / "tactical_3zone_ratio.csv")
    modified = max(path.stat().st_mtime for path in inputs if path.exists())
    return datetime.fromtimestamp(modified, timezone.utc)


@lru_cache(maxsize=1)
def supported_seasons() -> frozenset[str]:
    return frozenset(season for _, season in load_spear_cohort())


def players_envelope(season: str, scope: int, limit: int) -> PlayersEnvelope:
    all_players = build_players(season, scope)
    selected = list(all_players[:limit])
    return PlayersEnvelope(
        data=selected,
        meta=DatasetMeta(
            season=season,
            scope=scope,
            population=len(all_players),
            returned=len(selected),
            generatedAt=dataset_generated_at(),
        ),
    )
