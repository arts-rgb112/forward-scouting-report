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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cohort", type=Path, default=COHORT_PATH)
    parser.add_argument("--write-missing", type=Path, default=DEFAULT_MISSING_PATH)
    parser.add_argument("--minimum-coverage", type=float, default=0.98)
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


if __name__ == "__main__":
    main()
