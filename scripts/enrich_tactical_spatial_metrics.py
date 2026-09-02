"""Backfill tactical spatial fields from the committed heatmap snapshot.

This job makes no provider request. It is deliberately fail-closed: the CSV
and JSON must describe the same exact sessions, existing formula versions may
not change implicitly, and fields outside the spatial enrichment surface must
remain equivalent as parsed CSV values.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.build_tactical_ratios import (
    ACTIVITY_FILTER_VERSION,
    core_activity_points,
    spatial_metrics,
)


CSV_PATH = ROOT / "data" / "tactical_3zone_ratio.csv"
POINTS_PATH = ROOT / "data" / "tactical_heatmap_points.json"
SPATIAL_FIELDS = tuple(spatial_metrics([], positional_points=[]))


def _read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source)
        if not reader.fieldnames:
            raise ValueError("tactical ratio CSV has no header")
        return list(reader.fieldnames), list(reader)


def _read_points(path: Path) -> dict[str, object]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("heatmap snapshot must be an object keyed by heatmap_key")
    return payload


def _exact_rows(rows: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    indexed: dict[str, dict[str, str]] = {}
    for row_number, row in enumerate(rows, start=2):
        key = str(row.get("heatmap_key") or "").strip()
        if not key:
            raise ValueError(f"missing heatmap_key at CSV row {row_number}")
        if key in indexed:
            raise ValueError(f"duplicate heatmap_key: {key}")
        indexed[key] = row
    return indexed


def validate_csv_json_keys(
    rows: list[dict[str, str]], points_by_key: dict[str, object],
) -> set[str]:
    csv_keys = set(_exact_rows(rows))
    json_keys = {str(key) for key in points_by_key}
    csv_only = sorted(csv_keys - json_keys)
    json_only = sorted(json_keys - csv_keys)
    if csv_only or json_only:
        raise ValueError(
            "tactical CSV/JSON key parity failed: "
            f"csv_only={len(csv_only)} json_only={len(json_only)}"
        )
    return csv_keys


def validate_formula_version(
    rows: list[dict[str, str]], *, migrate_definition_from: str | None,
) -> bool:
    versions = {str(row.get("activity_filter") or "").strip() for row in rows}
    if "" in versions:
        raise ValueError("activity_filter is missing on one or more tactical rows")
    if versions == {ACTIVITY_FILTER_VERSION}:
        if migrate_definition_from is not None:
            raise ValueError(
                "migration flag is unnecessary: snapshot already uses "
                f"{ACTIVITY_FILTER_VERSION}"
            )
        return False
    if migrate_definition_from is None:
        raise ValueError(
            "tactical formula version is immutable without an explicit migration flag: "
            f"expected={ACTIVITY_FILTER_VERSION} observed={sorted(versions)}; use "
            "--migrate-definition-from <observed-version> only in a reviewed migration"
        )
    if versions != {migrate_definition_from}:
        raise ValueError(
            "migration source does not exactly match the snapshot: "
            f"flag={migrate_definition_from} observed={sorted(versions)}"
        )
    return True


def validate_non_target_fields(
    before: list[dict[str, str]],
    after: list[dict[str, str]],
    *,
    allow_definition_change: bool,
) -> None:
    before_by_key = _exact_rows(before)
    after_by_key = _exact_rows(after)
    if set(before_by_key) != set(after_by_key):
        raise ValueError("exact tactical heatmap keys changed during enrichment")
    for key, original in before_by_key.items():
        updated = after_by_key[key]
        mutable_fields = set(SPATIAL_FIELDS)
        if allow_definition_change:
            mutable_fields.add("activity_filter")
        for field in (set(original) | set(updated)) - mutable_fields:
            if original.get(field, "") != updated.get(field, ""):
                raise ValueError(
                    f"non-target field changed for heatmap_key={key}: {field}"
                )


def _atomic_write_csv(
    path: Path, fieldnames: list[str], rows: list[dict[str, str]],
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
    csv_path: Path,
    points_path: Path,
    *,
    migrate_definition_from: str | None = None,
) -> tuple[int, int]:
    if not csv_path.exists() or not points_path.exists():
        raise ValueError("tactical ratio CSV or heatmap point JSON is missing")
    fieldnames, original_rows = _read_csv(csv_path)
    migration = validate_formula_version(
        original_rows, migrate_definition_from=migrate_definition_from,
    )
    # Reject an unapproved definition change before loading the much larger
    # coordinate snapshot. This is both safer and materially faster.
    points_by_key = _read_points(points_path)
    original_keys = validate_csv_json_keys(original_rows, points_by_key)

    for field in (*SPATIAL_FIELDS, "activity_filter"):
        if field not in fieldnames:
            fieldnames.append(field)

    updated_rows: list[dict[str, str]] = []
    populated = 0
    for original in original_rows:
        row = dict(original)
        key = str(row["heatmap_key"]).strip()
        points = points_by_key[key]
        if not isinstance(points, list):
            raise ValueError(f"heatmap snapshot is not a list for heatmap_key={key}")
        metrics = spatial_metrics(
            core_activity_points(points), positional_points=points,
        )
        for field, value in metrics.items():
            row[field] = f"{value:.4f}"
        if migration:
            row["activity_filter"] = ACTIVITY_FILTER_VERSION
        if points:
            populated += 1
        updated_rows.append(row)

    validate_non_target_fields(
        original_rows, updated_rows, allow_definition_change=migration,
    )
    if set(_exact_rows(updated_rows)) != original_keys:
        raise ValueError("exact tactical heatmap key preservation audit failed")
    validate_csv_json_keys(updated_rows, points_by_key)
    _atomic_write_csv(csv_path, fieldnames, updated_rows)
    return len(updated_rows), populated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, default=CSV_PATH)
    parser.add_argument("--points", type=Path, default=POINTS_PATH)
    parser.add_argument(
        "--migrate-definition-from",
        help=(
            "Explicitly authorize a reviewed migration from exactly this existing "
            f"activity_filter to {ACTIVITY_FILTER_VERSION}."
        ),
    )
    args = parser.parse_args()
    try:
        rows, populated = enrich(
            args.csv,
            args.points,
            migrate_definition_from=args.migrate_definition_from,
        )
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as exc:
        raise SystemExit(f"Tactical spatial enrichment aborted before publish: {exc}") from exc
    print(
        "Tactical spatial enrichment passed all guards: "
        f"exact_keys={rows}/{rows}, populated={populated}, "
        f"definition={ACTIVITY_FILTER_VERSION}."
    )


if __name__ == "__main__":
    main()
