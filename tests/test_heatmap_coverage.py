import unittest
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from metrics import extract_multi_season_metrics
from scripts.build_tactical_ratios import (
    SportsApiClient,
    discover_tournaments,
    missing_static_cohort_sessions,
    read_fotmob_map,
    read_missing_failure_reasons,
    reverse_fotmob_map,
    resolve_ranked_sportsapi_id,
    spatial_metrics,
    tactical_coverage_regressions,
)
from positional_grid import (
    POSITIONAL_CELL_FIELDS,
    POSITIONAL_DEPTH_FIELDS,
    POSITIONAL_LANE_BOUNDARIES,
    positional_grid_metrics,
)
from tactical_ratio import _same_competition, cca_core_region


def _payload(league_name: str, league_id: int) -> dict:
    return {
        "base": {"primaryPosition": {"key": "F", "label": "Forward"}},
        "season_records": [{
            "season": "2025/2026",
            "league_id": league_id,
            "league_name": league_name,
            "stats": {"items": [
                {"title": "Goals", "value": 4},
                {"title": "Expected goals (xG)", "value": 3.5},
                {"title": "Expected goals on target (xGOT)", "value": 4.1},
                {"title": "Minutes played", "value": 900},
            ]},
        }],
    }


class ExpandedLeagueParsingTests(unittest.TestCase):
    def test_liga_portugal_session_alias_matches_tactical_label(self) -> None:
        self.assertTrue(_same_competition("Liga Portugal", "Primeira Liga"))
        self.assertTrue(_same_competition("Primeira Liga", "Liga Portugal"))


class CcaOverlayTests(unittest.TestCase):
    def test_etl_script_can_import_the_root_positional_grid_when_run_as_a_script(self) -> None:
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, "scripts/build_tactical_ratios.py", "--help"],
            cwd=root, capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--season-name", result.stdout)

    def test_positional_grid_uses_the_supplied_non_uniform_five_lanes(self) -> None:
        # The supplied pitch has wide outer lanes and narrower central lanes;
        # this must not regress to arbitrary 20-percent y bins.
        self.assertEqual(POSITIONAL_LANE_BOUNDARIES, (0.0, 21.82, 37.0, 63.0, 78.18, 100.0))
        points = [(1, 1), (20, 21.81), (20, 21.82), (40, 37), (99, 99)]

        metrics = positional_grid_metrics(points)

        self.assertEqual(metrics["grid_d1_l1_ratio"], 20.0)
        self.assertEqual(metrics["grid_d2_l1_ratio"], 20.0)
        self.assertEqual(metrics["grid_d2_l2_ratio"], 20.0)
        self.assertEqual(metrics["grid_d3_l3_ratio"], 20.0)
        self.assertEqual(metrics["grid_d6_l5_ratio"], 20.0)
        self.assertAlmostEqual(sum(metrics[field] for field in POSITIONAL_DEPTH_FIELDS), 100.0)
        self.assertAlmostEqual(sum(metrics[field] for field in POSITIONAL_CELL_FIELDS), 100.0)

    def test_grid_occupancy_uses_all_saved_points_while_cca_remains_repeat_only(self) -> None:
        # CCA intentionally discards one-off noise; positional occupancy must
        # still describe the full heatmap shown to users.
        core_points = [(10, 10)] * 4
        all_points = [*core_points, (90, 90)]

        metrics = spatial_metrics(core_points, positional_points=all_points)

        self.assertEqual(metrics["grid_d1_l1_ratio"], 80.0)
        self.assertEqual(metrics["grid_d6_l5_ratio"], 20.0)
        self.assertEqual(sum(metrics[f"lane_{lane}_ratio"] for lane in range(1, 6)), 100.0)

    def test_cca_overlay_uses_the_densest_repeated_cells_not_all_visual_points(self) -> None:
        # Four points in one cell and three in a second cell form the earliest
        # core that reaches at least 50% of the seven repeated observations.
        points = [
            [11, 11], [12, 13], [13, 12], [14, 14],
            [31, 31], [32, 32], [33, 33],
            [90, 90],  # A one-off visual point must not enter CCA.
        ]
        core, hull = cca_core_region(points)
        self.assertEqual(len(core), 4)
        self.assertEqual(set(core), {(11.0, 11.0), (12.0, 13.0), (13.0, 12.0), (14.0, 14.0)})
        self.assertGreaterEqual(len(hull), 3)

    def test_eredivisie_is_retained(self) -> None:
        metrics = extract_multi_season_metrics(_payload("Eredivisie", 999))
        self.assertIn("25/26_57", metrics)
        self.assertEqual(metrics["25/26_57"].league_id, 57)

    def test_primeira_liga_is_retained(self) -> None:
        metrics = extract_multi_season_metrics(_payload("Primeira Liga", 999))
        self.assertIn("25/26_61", metrics)
        self.assertEqual(metrics["25/26_61"].league_id, 61)

    def test_liga_portugal_alias_is_retained(self) -> None:
        metrics = extract_multi_season_metrics(_payload("Liga Portugal", 999))
        self.assertIn("25/26_61", metrics)
        self.assertEqual(metrics["25/26_61"].league_id, 61)


class TacticalCoverageAuditTests(unittest.TestCase):
    def test_failure_reason_reader_returns_dict_for_existing_csv(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.csv"
            path.write_text(
                "fotmob_player_id,player_name,team_name,competition_name,season_name,reason\n"
                "212867,Heung-Min Son,Tottenham Hotspur,Premier League,2023/2024,sportsapi_id_unresolved\n",
                encoding="utf-8",
            )

            reasons = read_missing_failure_reasons(path)

        self.assertEqual(
            reasons[("212867", "Premier League", "2023/2024")],
            "sportsapi_id_unresolved",
        )

    def test_failure_reason_reader_returns_empty_dict_for_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            reasons = read_missing_failure_reasons(Path(directory) / "missing.csv")
        self.assertEqual(reasons, {})

    def test_failure_reason_reader_ignores_incomplete_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.csv"
            path.write_text(
                "fotmob_player_id,competition_name,season_name,reason\n"
                ",Premier League,2023/2024,sportsapi_id_unresolved\n",
                encoding="utf-8",
            )
            reasons = read_missing_failure_reasons(path)
        self.assertEqual(reasons, {})

    def test_verified_son_mapping_is_available_in_both_directions(self) -> None:
        root = Path(__file__).resolve().parents[1]
        mapping = read_fotmob_map(root / "data" / "fotmob_player_map.csv")

        self.assertEqual(mapping["111505"], "212867")
        self.assertEqual(reverse_fotmob_map(mapping)["212867"], {"111505"})

    def test_reports_only_missing_competition_season_sessions(self) -> None:
        cohort = [
            {
                "player_id": "10", "player_name": "Covered", "team_name": "A",
                "league_name": "Champions League", "season_name": "2025/2026",
            },
            {
                "player_id": "11", "player_name": "Missing", "team_name": "B",
                "league_name": "Premier League", "season_name": "2024/2025",
            },
        ]
        output = [{
            "fotmob_player_id": "10", "competition_name": "UEFA Champions League",
            "season_name": "2025/2026", "heatmap_key": "10:42:1",
        }]

        missing = missing_static_cohort_sessions(output, cohort)

        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["fotmob_player_id"], "11")
        self.assertEqual(missing[0]["competition_name"], "Premier League")

    def test_reports_csv_session_without_json_points(self) -> None:
        cohort = [{
            "player_id": "10", "player_name": "No points", "team_name": "A",
            "league_name": "Champions League", "season_name": "2025/2026",
        }]
        output = [{
            "fotmob_player_id": "10", "competition_name": "UEFA Champions League",
            "season_name": "2025/2026", "heatmap_key": "10:42:1",
        }]

        missing = missing_static_cohort_sessions(output, cohort, visual_points={})

        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["reason"], "missing_heatmap_points")

    def test_maps_liga_portugal_cohort_label_to_tactical_name(self) -> None:
        cohort = [{
            "player_id": "61", "player_name": "Portugal player", "team_name": "A",
            "league_name": "Liga Portugal", "season_name": "2025/2026",
        }]

        missing = missing_static_cohort_sessions([], cohort)

        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["competition_name"], "Primeira Liga")

    def test_preserves_specific_failure_reason_for_a_missing_session(self) -> None:
        cohort = [{
            "player_id": "212867", "player_name": "Heung-Min Son",
            "team_name": "Tottenham Hotspur", "league_name": "Premier League",
            "season_name": "2023/2024",
        }]
        key = ("212867", "Premier League", "2023/2024")

        missing = missing_static_cohort_sessions(
            [], cohort, failure_reasons={key: "provider_heatmap_empty"},
        )

        self.assertEqual(missing[0]["reason"], "provider_heatmap_empty")

    def test_completeness_gate_allows_repairs_but_rejects_new_gaps(self) -> None:
        baseline = {("1", "Premier League", "2024/2025")}
        self.assertEqual(tactical_coverage_regressions(set(), baseline), set())
        regression = ("2", "LaLiga", "2024/2025")
        self.assertEqual(
            tactical_coverage_regressions({*baseline, regression}, baseline),
            {regression},
        )


class RankedPlayerMappingTests(unittest.TestCase):
    def test_maps_unique_exact_normalized_name_before_position_filter(self) -> None:
        players = {
            "100": {"name": "Raphael Guerreiro", "team_name": "Bayern München"},
        }

        self.assertEqual(
            resolve_ranked_sportsapi_id(
                players, "Raphaël Guerreiro", "Bayern München",
            ),
            "100",
        )

    def test_uses_team_to_disambiguate_namesakes(self) -> None:
        players = {
            "100": {"name": "Luis Suárez", "team_name": "Atletico Madrid"},
            "200": {"name": "Luis Suárez", "team_name": "Granada"},
        }

        self.assertEqual(
            resolve_ranked_sportsapi_id(players, "Luis Suárez", "Granada"),
            "200",
        )

    def test_refuses_ambiguous_namesake_without_team_match(self) -> None:
        players = {
            "100": {"name": "Luis Suárez", "team_name": "Atletico Madrid"},
            "200": {"name": "Luis Suárez", "team_name": "Granada"},
        }

        self.assertIsNone(
            resolve_ranked_sportsapi_id(players, "Luis Suárez", "Unknown"),
        )


class TournamentDiscoveryTests(unittest.TestCase):
    def test_distinctive_expanded_leagues_ignore_country_label_drift(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str) -> dict:
                self.request = (path, key_scope)
                return {"leagues": [
                    {"id": 37, "name": "Eredivisie", "countryName": "The Netherlands"},
                    {"id": 238, "name": "Liga Portugal", "countryName": "Portuguese Republic"},
                ]}

        with patch(
            "scripts.build_tactical_ratios.cached_tournament_discoveries",
            return_value={},
        ):
            discovered = discover_tournaments(FakeClient())

        self.assertEqual(
            {item["name"]: item["id"] for item in discovered},
            {"Eredivisie": 37, "Primeira Liga": 238},
        )

    def test_catalog_omissions_use_season_validated_fallback_ids(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str) -> dict:
                return {"leagues": []}

        with patch(
            "scripts.build_tactical_ratios.cached_tournament_discoveries",
            return_value={},
        ):
            discovered = discover_tournaments(FakeClient())

        self.assertEqual(
            {item["name"]: item["id"] for item in discovered},
            {"Eredivisie": 37, "Primeira Liga": 238},
        )


class SportsApiRetryTests(unittest.TestCase):
    def test_best_effort_request_can_be_limited_to_one_attempt(self) -> None:
        client = SportsApiClient({"player": "secret"}, delay_seconds=0)
        with (
            patch(
                "scripts.build_tactical_ratios.BASE_URLS",
                ("https://sports.example",),
            ),
            patch(
                "scripts.build_tactical_ratios.urlopen",
                side_effect=URLError("offline"),
            ) as request,
        ):
            with self.assertRaises(URLError):
                client.get("search?q=player", "player", max_attempts=1)

        self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
