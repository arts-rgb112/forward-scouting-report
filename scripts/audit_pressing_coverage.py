"""Audit static forward-pressing source coverage after a S.P.E.A.R. refresh."""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COHORT_PATH = ROOT / "data" / "spear_cohort.csv"
DEFAULT_MISSING_PATH = ROOT / "data" / "missing_pressing_sessions.csv"
MISSING_FIELDS = (
    "player_id", "player_name", "team_name", "league_id", "league_name",
    "season_name", "reason",
)
COHORT_KEY_FIELDS = ("player_id", "league_id", "season_name")


def present(row: dict[str, str], field: str) -> bool:
    return str(row.get(field, "")).strip() != ""


def audit(path: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    with path.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    missing: list[dict[str, str]] = []
    for row in rows:
        has_recoveries = present(row, "recoveries")
        has_final_third = present(row, "final_third_possessions_won")
        if has_recoveries and has_final_third:
            continue
        if not has_recoveries and not has_final_third:
            reason = "both_source_metrics_unavailable"
        elif not has_recoveries:
            reason = "recoveries_unavailable"
        else:
            reason = "final_third_possessions_won_unavailable"
        missing.append({field: str(row.get(field, "")) for field in MISSING_FIELDS[:-1]} | {"reason": reason})
    return rows, missing


def exact_key(row: dict[str, str]) -> tuple[str, str, str]:
    return tuple(
        str(row.get(field, "")).strip() for field in COHORT_KEY_FIELDS
    )  # type: ignore[return-value]


def audit_baseline_non_loss(
    rows: list[dict[str, str]], baseline_path: Path,
) -> tuple[int, int]:
    """Require every previously published exact cohort row to survive."""

    with baseline_path.open(encoding="utf-8", newline="") as source:
        baseline_rows = list(csv.DictReader(source))
    baseline_keys = {exact_key(row) for row in baseline_rows}
    current_keys = [exact_key(row) for row in rows]
    current_key_set = set(current_keys)
    if len(current_key_set) != len(current_keys):
        raise SystemExit(
            "Cohort non-loss audit failed: duplicate exact player/competition/season keys"
        )
    missing = sorted(baseline_keys - current_key_set)
    if missing:
        preview = ", ".join("|".join(key) for key in missing[:5])
        raise SystemExit(
            "Cohort non-loss audit failed: "
            f"{len(missing)} previously published exact keys are missing; sample={preview}"
        )
    baseline_slices = {
        (
            str(row.get("season_name", "")).strip(),
            str(row.get("league_id", "")).strip(),
        )
        for row in baseline_rows
    }
    current_slices = {
        (
            str(row.get("season_name", "")).strip(),
            str(row.get("league_id", "")).strip(),
        )
        for row in rows
    }
    missing_slices = sorted(baseline_slices - current_slices)
    if missing_slices:
        raise SystemExit(
            "Cohort non-loss audit failed: published season/competition slices disappeared: "
            + ", ".join(f"{season}|{league}" for season, league in missing_slices)
        )
    return len(baseline_keys), len(current_key_set)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cohort", type=Path, default=COHORT_PATH)
    parser.add_argument("--write-missing", type=Path, default=DEFAULT_MISSING_PATH)
    parser.add_argument("--minimum-coverage", type=float, default=0.98)
    parser.add_argument(
        "--baseline", type=Path,
        help="Optional published cohort whose exact keys must all remain present.",
    )
    args = parser.parse_args()

    rows, missing = audit(args.cohort)
    complete = len(rows) - len(missing)
    coverage = complete / len(rows) if rows else 0.0
    by_slice: dict[tuple[str, str], list[int]] = defaultdict(lambda: [0, 0])
    missing_keys = {
        (row["player_id"], row["league_id"], row["season_name"])
        for row in missing
    }
    for row in rows:
        key = (str(row.get("league_name", "")), str(row.get("season_name", "")))
        by_slice[key][0] += 1
        row_key = (
            str(row.get("player_id", "")), str(row.get("league_id", "")),
            str(row.get("season_name", "")),
        )
        if row_key not in missing_keys:
            by_slice[key][1] += 1

    args.write_missing.parent.mkdir(parents=True, exist_ok=True)
    with args.write_missing.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=MISSING_FIELDS)
        writer.writeheader()
        writer.writerows(missing)

    print(
        f"Pressing coverage: complete={complete} total={len(rows)} "
        f"coverage={coverage:.4%} missing={len(missing)}"
    )
    for (competition, season), (total, available) in sorted(by_slice.items()):
        print(
            f"  {season} | {competition}: {available}/{total} "
            f"({available / total:.2%})"
        )
    if coverage < args.minimum_coverage:
        raise SystemExit(
            f"Pressing coverage {coverage:.4%} is below required {args.minimum_coverage:.2%}."
        )
    if args.baseline is not None:
        baseline_count, current_count = audit_baseline_non_loss(rows, args.baseline)
        print(
            "Cohort non-loss audit: "
            f"retained={baseline_count}/{baseline_count} current={current_count}"
        )


if __name__ == "__main__":
    main()
