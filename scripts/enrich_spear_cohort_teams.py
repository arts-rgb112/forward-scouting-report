"""Populate missing season-specific team names in the static cohort safely."""

from __future__ import annotations

import csv
import os
import sys
import time
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fotmob_client import fetch_team_name
from spear_cohort import DATA_PATH


TEAM_FIELD = "team_name"


def _read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames:
            raise ValueError("static cohort CSV has no header")
        return list(reader.fieldnames), list(reader)


def _exact_rows(
    rows: list[dict[str, str]],
) -> dict[tuple[str, str, str], dict[str, str]]:
    indexed: dict[tuple[str, str, str], dict[str, str]] = {}
    for row_number, row in enumerate(rows, start=2):
        key = (
            str(row.get("player_id") or "").strip(),
            str(row.get("league_id") or "").strip(),
            str(row.get("season_name") or "").strip(),
        )
        if not all(key):
            raise ValueError(f"missing exact cohort key at CSV row {row_number}")
        if key in indexed:
            raise ValueError(f"duplicate exact cohort key: {key}")
        indexed[key] = row
    return indexed


def validate_team_name_only_change(
    before: list[dict[str, str]], after: list[dict[str, str]],
) -> None:
    before_by_key = _exact_rows(before)
    after_by_key = _exact_rows(after)
    if set(before_by_key) != set(after_by_key):
        raise ValueError("exact cohort keys changed during team-name enrichment")
    for key, original in before_by_key.items():
        updated = after_by_key[key]
        for field in (set(original) | set(updated)) - {TEAM_FIELD}:
            if original.get(field, "") != updated.get(field, ""):
                raise ValueError(
                    f"field other than team_name changed for cohort key={key}: {field}"
                )


def _atomic_write_csv(
    path: Path, fieldnames: list[str], rows: list[dict[str, str]],
) -> None:
    temporary_path: Path | None = None
    try:
        with NamedTemporaryFile(
            "w", encoding="utf-8", newline="", dir=path.parent, delete=False,
        ) as temporary:
            writer = csv.DictWriter(
                temporary, fieldnames=fieldnames, extrasaction="raise", lineterminator="\n",
            )
            writer.writeheader()
            writer.writerows(rows)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def enrich(
    data_path: Path,
    *,
    resolver: Callable[[int], str | None] = fetch_team_name,
    delay_seconds: float = 0.12,
) -> tuple[int, int, int]:
    if not data_path.exists():
        raise ValueError("static cohort CSV is missing")
    fieldnames, original_rows = _read_rows(data_path)
    if TEAM_FIELD not in fieldnames:
        raise ValueError("static cohort CSV is missing team_name")
    original_keys = set(_exact_rows(original_rows))

    team_ids = sorted({
        int(row["team_id"])
        for row in original_rows
        if row.get("team_id") and not row.get(TEAM_FIELD)
    })
    team_names: dict[int, str] = {}
    for index, team_id in enumerate(team_ids):
        if index and delay_seconds:
            time.sleep(delay_seconds)
        if team_name := resolver(team_id):
            team_names[team_id] = team_name

    updated_rows: list[dict[str, str]] = []
    updated = 0
    for original in original_rows:
        row = dict(original)
        if not row.get(TEAM_FIELD):
            try:
                team_id = int(row["team_id"])
            except (KeyError, TypeError, ValueError):
                team_id = 0
            if team_name := team_names.get(team_id):
                row[TEAM_FIELD] = team_name
                updated += 1
        updated_rows.append(row)

    validate_team_name_only_change(original_rows, updated_rows)
    if set(_exact_rows(updated_rows)) != original_keys:
        raise ValueError("exact cohort key preservation audit failed")
    if updated:
        _atomic_write_csv(data_path, fieldnames, updated_rows)
    return len(original_rows), len(team_names), updated


def main() -> None:
    try:
        rows, resolved, updated = enrich(DATA_PATH)
    except (OSError, ValueError, csv.Error) as exc:
        raise SystemExit(f"Cohort team enrichment aborted before publish: {exc}") from exc
    print(
        "Cohort team enrichment passed all guards: "
        f"exact_keys={rows}/{rows}, resolved_team_ids={resolved}, "
        f"updated_rows={updated}; mutable_field=team_name."
    )


if __name__ == "__main__":
    main()
