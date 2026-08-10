"""Static player profile metadata used by the public API."""

from __future__ import annotations

import csv
import functools
from datetime import date, datetime
from pathlib import Path


PROFILE_PATH = Path(__file__).resolve().parents[1] / "data" / "player_profiles.csv"
FOTMOB_IMAGE_BASE = "https://images.fotmob.com/image_resources"


def player_face_url(player_id: int) -> str:
    return f"{FOTMOB_IMAGE_BASE}/playerimages/{player_id}.png"


def team_logo_url(team_id: int) -> str:
    return f"{FOTMOB_IMAGE_BASE}/logo/teamlogo/{team_id}.png"


def league_logo_url(league_id: int) -> str:
    return f"{FOTMOB_IMAGE_BASE}/logo/leaguelogo/{league_id}.png"


@functools.lru_cache(maxsize=1)
def load_birth_dates() -> dict[int, date]:
    """Load FotMob birth dates captured with the static cohort snapshot."""
    try:
        with PROFILE_PATH.open(encoding="utf-8", newline="") as source:
            rows = csv.DictReader(source)
            return {
                int(row["player_id"]): datetime.strptime(row["birth_date"], "%Y-%m-%d").date()
                for row in rows
                if row.get("player_id") and row.get("birth_date")
            }
    except (OSError, ValueError, KeyError):
        return {}


def age_on(birth_date: date, reference_date: date) -> int:
    return reference_date.year - birth_date.year - (
        (reference_date.month, reference_date.day) < (birth_date.month, birth_date.day)
    )


def player_age(player_id: int, reference_date: date | None = None) -> int | None:
    birth_date = load_birth_dates().get(player_id)
    return age_on(birth_date, reference_date or date.today()) if birth_date else None
