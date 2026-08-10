from __future__ import annotations

from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from rankings import COMPARISON_SCOPES, EUROPEAN_COMPETITION_IDS, EUROPEAN_LEADERBOARD_ID, get_spear_leaderboard
from spear_cohort import load_spear_cohort

from .schemas import AssetRef, DatasetMeta, PlayerResponse, PlayersEnvelope, PlayerStats, PlayerTier
from .profiles import league_logo_url, player_age, player_face_url, team_logo_url


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


def _players_from_frame(frame, *, require_complete_profiles: bool = True) -> tuple[PlayerResponse, ...]:
    population = len(frame)
    players: list[PlayerResponse] = []
    for record in frame.to_dict(orient="records"):
        try:
            player_id = _source_player_id(record["player_id"])
        except (TypeError, ValueError):
            # A source row without a usable ID cannot be selected, compared,
            # or keyed safely by the strict frontend contract.
            continue
        league_id = _asset_id(record.get("league_id") or 0)
        team_id = _asset_id(record.get("team_id") or 0)
        age = player_age(player_id)
        if not league_id or not team_id or (require_complete_profiles and age is None):
            # Public rows promise usable image assets and a concrete age. The
            # profile snapshot is built from the same static cohort, so this
            # only excludes a source row while a provider profile is pending.
            continue
        rank = int(record["rank"])
        players.append(PlayerResponse(
            id=player_id,
            rank=rank,
            name=str(record["player_name"]),
            position=str(record.get("position") or "FW"),
            archetype=str(record.get("role") or "Type A"),
            age=age,
            minutes=max(0, round(float(record.get("minutes_played") or 0))),
            tier=tier_from_rank(rank, population),
            score=round(float(record["score"]), 2),
            face=player_face_url(player_id),
            nation=None,
            league=AssetRef(id=league_id, name=str(record.get("league_name") or "Unknown league"), icon=league_logo_url(league_id)),
            club=AssetRef(id=team_id, name=str(record.get("team_name") or "Unknown club"), icon=team_logo_url(team_id)),
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


@lru_cache(maxsize=16)
def build_players(season: str, scope: int) -> tuple[PlayerResponse, ...]:
    """Legacy v1 domestic data. Kept strict for already deployed clients."""
    return _players_from_frame(get_spear_leaderboard(47, season, scope))


def leaderboard_target(mode: str, scope: int, competition: str) -> int:
    if mode == "league":
        return 47
    return {
        "all": EUROPEAN_LEADERBOARD_ID,
        "ucl": 42,
        "uel": 73,
        "uecl": 108,
    }[competition]


@lru_cache(maxsize=64)
def build_v2_players(season: str, mode: str, scope: int, competition: str) -> tuple[PlayerResponse, ...]:
    """Return only rows backed by the static snapshot; no synthetic competition data."""
    target = leaderboard_target(mode, scope, competition)
    return _players_from_frame(get_spear_leaderboard(target, season, scope))


def available_competitions(season: str) -> dict[str, dict[str, object]]:
    labels = {"all": "All European competitions", "ucl": "Champions League", "uel": "Europa League", "uecl": "Europa Conference League"}
    result: dict[str, dict[str, object]] = {}
    for code in labels:
        rows = build_v2_players(season, "europe", 7, code)
        result[code] = {
            "code": code,
            "label": labels[code],
            "available": bool(rows),
            "reason": None if rows else "No verified static cohort is available for this competition and season.",
        }
    return result


def leaderboard_v2_envelope(season: str, mode: str, scope: int, competition: str, limit: int) -> dict[str, object]:
    rows = build_v2_players(season, mode, scope, competition)
    selected = list(rows[:limit])
    return {
        "data": [player.model_dump(mode="json") for player in selected],
        "meta": {
            "schemaVersion": "2.0.0", "season": season, "mode": mode, "scope": scope if mode == "league" else None,
            "competition": competition if mode == "europe" else None, "population": len(rows), "returned": len(selected),
            "generatedAt": dataset_generated_at().isoformat().replace("+00:00", "Z"), "source": "messi-static-cohort",
        },
    }


def leaderboard_options() -> dict[str, object]:
    seasons = sorted(supported_seasons(), reverse=True)
    return {
        "seasons": seasons,
        "scopes": [{"value": scope, "label": f"{scope} major leagues", "leagueIds": sorted(ids)} for scope, ids in sorted(COMPARISON_SCOPES.items())],
        "competitions": available_competitions(seasons[0]) if seasons else {},
    }


def find_v2_player(player_id: int, season: str, mode: str, scope: int, competition: str) -> PlayerResponse | None:
    return next((player for player in build_v2_players(season, mode, scope, competition) if player.id == player_id), None)


@lru_cache(maxsize=1)
def dataset_generated_at() -> datetime:
    """Deterministic snapshot time derived from the static inputs, never request time."""
    root = Path(__file__).resolve().parents[1] / "data"
    inputs = (
        root / "spear_cohort.csv",
        root / "tactical_3zone_ratio.csv",
        root / "player_profiles.csv",
    )
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
