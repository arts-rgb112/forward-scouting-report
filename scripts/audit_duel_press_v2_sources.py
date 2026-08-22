"""Audit static source absence for the stat-pairs-v2 readout.

This is deliberately an offline release/ingestion tool.  It never contacts a
provider: a missing source is evidence to record, not permission for an API
request to silently substitute a value.  A separately approved provider
backfill may update the canonical static source only after its player identity,
season/competition context, metric semantics, and units have been verified.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

# Raw fields consumed by api_server.service's stat-pairs-v2 calculator.  Do
# not list derived terms here: their absence is represented by their true
# observed inputs, which keeps the audit actionable for ingestion.
COHORT_FIELDS = (
    "minutes_played",
    "out_box_shots", "out_box_xg", "out_box_xgot",
    "in_box_shots", "in_box_xg", "in_box_xgot",
    "dribbles_succeeded", "dribbles_success_rate",
    "duels_won", "duels_won_percentage",
    "aerial_duels_won",
    "recoveries", "final_third_possessions_won",
    "goals", "xgot", "fouls_won", "penalties_awarded", "dispossessed",
)
TACTICAL_FIELDS = ("cca_area_pct", "danger_zone_density")
REPORT_FIELDS = (
    "playerId", "name", "season", "mode", "scope", "competition",
    "missingFields", "derivableFields", "requiredProviderInputs",
    "providerLookupResult", "reason", "timestamp",
)
REQUIRED_AERIAL_PROVIDER_INPUTS = (
    "verified_sportsapi_player_id;exact_tournament_id;exact_season_id;"
    "aerial_duels_won; aerial_duel_attempts;count_units"
)
BLOCKED_PROVIDER_LOOKUP = "not_attempted_no_verified_sportsapi_raw_duel_schema"


def _present(value: object) -> bool:
    """Keep observed zero distinct from a missing static source."""
    return value is not None and str(value).strip() != ""


EUROPE_COMPETITIONS = {
    "champions league": ("UEFA Champions League", "ucl"),
    "uefa champions league": ("UEFA Champions League", "ucl"),
    "ucl": ("UEFA Champions League", "ucl"),
    "europa league": ("UEFA Europa League", "uel"),
    "uefa europa league": ("UEFA Europa League", "uel"),
    "uel": ("UEFA Europa League", "uel"),
    "conference league": ("UEFA Europa Conference League", "uecl"),
    "europa conference league": ("UEFA Europa Conference League", "uecl"),
    "uefa europa conference league": ("UEFA Europa Conference League", "uecl"),
    "uecl": ("UEFA Europa Conference League", "uecl"),
}


def _europe_competition(cohort_league: str) -> tuple[str, str] | None:
    return EUROPE_COMPETITIONS.get(cohort_league.strip().lower())


def _tactical_competition_name(cohort_league: str) -> str:
    europe = _europe_competition(cohort_league)
    return europe[0] if europe is not None else cohort_league


def _v2_context(cohort_league: str, scope: int) -> tuple[str, str, str]:
    """Match the public v2 context instead of collapsing Europe into league."""
    europe = _europe_competition(cohort_league)
    if europe is not None:
        return "europe", "", europe[1]
    return "league", str(scope), ""


def build_audit_rows(
    cohort_path: Path, tactical_path: Path, *, timestamp: str,
    scope: int = 8,
) -> list[dict[str, str]]:
    """Return one source-absence record per static cohort player-session.

    The report's provider lookup result is intentionally blocked: this repo's
    configured SportsAPI paths cover search, tournament metadata, top-player
    identity, and heatmaps, but no verified raw aerial wins/attempts schema.
    Lookup belongs to a separately authorized ingestion/backfill job, never
    the dashboard request path or this deterministic static audit.
    """
    with cohort_path.open(encoding="utf-8", newline="") as source:
        cohort_rows = list(csv.DictReader(source))
    with tactical_path.open(encoding="utf-8", newline="") as source:
        tactical_rows = list(csv.DictReader(source))

    tactical_by_session = {
        (
            str(row.get("fotmob_player_id", "")).strip(),
            str(row.get("competition_name", "")).strip(),
            str(row.get("season_name", "")).strip(),
        ): row
        for row in tactical_rows
        if str(row.get("fotmob_player_id", "")).strip()
    }
    report: list[dict[str, str]] = []
    for row in cohort_rows:
        player_id = str(row.get("player_id", "")).strip()
        season = str(row.get("season_name", "")).strip()
        league = str(row.get("league_name", "")).strip()
        if not player_id or not season or not league:
            continue
        mode, context_scope, competition = _v2_context(league, scope)
        missing = [field for field in COHORT_FIELDS if not _present(row.get(field))]
        derivable: list[str] = []
        aerial_wins = row.get("aerial_duels_won")
        aerial_attempts = row.get("aerial_duel_attempts_raw")
        aerial_rate = row.get("aerial_duels_won_percentage")
        if not _present(aerial_rate):
            if _present(aerial_wins) and _present(aerial_attempts):
                derivable.append("aerial_duel_win_rate_raw")
            else:
                if not _present(aerial_attempts):
                    missing.append("aerial_duel_attempts_raw")
        tactical = tactical_by_session.get((player_id, _tactical_competition_name(league), season))
        if tactical is None:
            missing.extend(TACTICAL_FIELDS)
            reason = "static_tactical_session_absent"
        else:
            missing.extend(field for field in TACTICAL_FIELDS if not _present(tactical.get(field)))
            reason = "rate_derivable_from_wins_attempts" if not missing and derivable else "static_source_field_absent"
        if not missing and not derivable:
            continue
        report.append({
            "playerId": player_id,
            "name": str(row.get("player_name", "")).strip(),
            "season": season,
            "mode": mode,
            "scope": context_scope,
            "competition": competition,
            "missingFields": ";".join(missing),
            "derivableFields": ";".join(derivable),
            "requiredProviderInputs": REQUIRED_AERIAL_PROVIDER_INPUTS if any(
                field in {"aerial_duels_won", "aerial_duel_attempts_raw"}
                for field in missing
            ) or derivable else "",
            "providerLookupResult": BLOCKED_PROVIDER_LOOKUP,
            "reason": reason,
            "timestamp": timestamp,
        })
    return sorted(report, key=lambda item: (item["season"], item["name"], item["playerId"]))


def write_report(rows: list[dict[str, str]], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=REPORT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit missing stat-pairs-v2 static source fields.")
    parser.add_argument("--cohort", type=Path, default=DATA_DIR / "spear_cohort.csv")
    parser.add_argument("--tactical", type=Path, default=DATA_DIR / "tactical_3zone_ratio.csv")
    parser.add_argument("--output", type=Path, default=DATA_DIR / "missing_duel_press_v2_sources.csv")
    parser.add_argument("--scope", type=int, choices=(3, 5, 7, 8), default=8)
    parser.add_argument(
        "--timestamp", default=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        help="ISO-8601 audit timestamp; expose it explicitly for reproducible release artifacts.",
    )
    args = parser.parse_args()
    rows = build_audit_rows(args.cohort, args.tactical, timestamp=args.timestamp, scope=args.scope)
    write_report(rows, args.output)
    print(f"Wrote {len(rows)} static source-absence rows to {args.output}")


if __name__ == "__main__":
    main()
