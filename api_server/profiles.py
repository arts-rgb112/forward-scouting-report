"""Static player profile metadata used by the public API."""

from __future__ import annotations

import csv
import functools
from datetime import date, datetime
from pathlib import Path


PROFILE_PATH = Path(__file__).resolve().parents[1] / "data" / "player_profiles.csv"
FOTMOB_IMAGE_BASE = "https://images.fotmob.com/image_resources"
# The public API contract exposes an adult player's age.  Provider profile
# placeholders such as 0001-01-01 must never turn a whole season request into
# a validation error.
MIN_PLAYER_AGE = 15
MAX_PLAYER_AGE = 60


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
            birth_dates: dict[int, date] = {}
            for row in csv.DictReader(source):
                try:
                    player_id = int(row.get("player_id", ""))
                    birth_date = datetime.strptime(row.get("birth_date", ""), "%Y-%m-%d").date()
                except (TypeError, ValueError):
                    # Preserve every valid profile if one provider row is
                    # malformed; a later API layer will omit only that row.
                    continue
                birth_dates[player_id] = birth_date
            return birth_dates
    except OSError:
        return {}


def age_on(birth_date: date, reference_date: date) -> int:
    return reference_date.year - birth_date.year - (
        (reference_date.month, reference_date.day) < (birth_date.month, birth_date.day)
    )


def player_age(player_id: int, reference_date: date | None = None) -> int | None:
    birth_date = load_birth_dates().get(player_id)
    if not birth_date:
        return None
    age = age_on(birth_date, reference_date or date.today())
    return age if MIN_PLAYER_AGE <= age <= MAX_PLAYER_AGE else None
