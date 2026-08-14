import unittest
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import URLError

from metrics import extract_multi_season_metrics
from scripts.build_tactical_ratios import (
    SportsApiClient,
    discover_tournaments,
    search_belgian_tournament,
    missing_static_cohort_sessions,
    read_fotmob_map,
    read_missing_failure_reasons,
    reverse_fotmob_map,
    resolve_sportsapi_id,
    resolve_ranked_sportsapi_id,
    spatial_metrics,
    tactical_coverage_regressions,
)
from positional_grid import (
    POSITIONAL_CELL_FIELDS,
    POSITIONAL_DEPTH_BOUNDARIES,
    POSITIONAL_DEPTH_FIELDS,
    POSITIONAL_LANE_BOUNDARIES,
    positional_grid_metrics,
)
from true_core import true_core_zones, true_core_zones_from_points
from continuous_core import continuous_core_from_points, continuous_core_summary
from tactical_ratio import (
    _same_competition,
    get_tactical_ratio_for_session,
    passes_final_third_filter,
)
from scripts.backfill_true_core_zones import DEFINITION_VERSION
from scripts.build_shotmap_points import normalize_shotmap, shot_outcome
from fotmob_client import FotMobError, _get, _league_selections
from scripts.audit_shotmap_coverage import load_source_exceptions


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
    def test_reviewed_shotmap_source_exceptions_keep_explicit_reason(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "exceptions.csv"
            path.write_text(
                "heatmap_key,reason,evidence\n"
                "1:38:10,source_history_unavailable,reviewed\n",
                encoding="utf-8",
            )
            self.assertEqual(
                load_source_exceptions(path),
                {"1:38:10": "source_history_unavailable"},
            )

    def test_liga_portugal_session_alias_matches_tactical_label(self) -> None:
        self.assertTrue(_same_competition("Liga Portugal", "Primeira Liga"))
        self.assertTrue(_same_competition("Primeira Liga", "Liga Portugal"))

    def test_conference_league_short_name_matches_tactical_label(self) -> None:
        self.assertTrue(_same_competition(
            "Conference League", "UEFA Europa Conference League",
        ))

    def test_belgian_league_aliases_share_one_tactical_identity(self) -> None:
        self.assertTrue(_same_competition("First Division A", "Belgian Pro League"))
        self.assertTrue(_same_competition("Jupiler Pro League", "Belgian Pro League"))

    def test_belgian_playoff_groups_share_regular_season_identity(self) -> None:
        self.assertTrue(_same_competition(
            "Belgian Pro League",
            "Belgian Pro League Playoff Conference League Group",
        ))
        self.assertTrue(_same_competition(
            "Belgian Pro League Playoff Relegation Group",
            "Belgian Pro League",
        ))


class CcaOverlayTests(unittest.TestCase):
    def test_player_season_selection_keeps_second_domestic_league_after_transfer(self) -> None:
        payload = {"statSeasons": [{
            "seasonName": "2025/2026",
            "tournaments": [
                {"name": "Premier League", "entryId": "1", "tournamentId": 17},
                {"name": "FA Cup", "entryId": "2", "tournamentId": 132},
                {"name": "Serie A", "entryId": "3", "tournamentId": 23},
                {"name": "Conference League", "entryId": "4", "tournamentId": 9469},
            ],
        }]}

        selections = _league_selections(payload, target_season="2025/2026")

        self.assertEqual(
            [selection["league_name"] for selection in selections],
            ["Premier League", "Serie A", "Conference League"],
        )

    @patch("fotmob_client.time.sleep")
    @patch("fotmob_client.urlopen")
    def test_fotmob_request_retries_read_timeouts(self, mock_urlopen, mock_sleep) -> None:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        mock_urlopen.side_effect = [TimeoutError("slow"), response]

        self.assertEqual(_get("https://example.test/data"), '{"ok":true}')
        self.assertEqual(mock_urlopen.call_count, 2)
        mock_sleep.assert_called_once_with(1.5)

    @patch("fotmob_client.time.sleep")
    @patch("fotmob_client.urlopen", side_effect=TimeoutError("slow"))
    def test_fotmob_request_wraps_repeated_timeouts(self, mock_urlopen, mock_sleep) -> None:
        with self.assertRaises(FotMobError):
            _get("https://example.test/data")
        self.assertEqual(mock_urlopen.call_count, 3)
        self.assertEqual(mock_sleep.call_count, 2)

    def test_true_core_module_accepts_the_legacy_positional_grid_surface(self) -> None:
        """Streamlit hot reload may retain the pre-True-Core grid module."""
        root = Path(__file__).resolve().parents[1]
        code = (
            "import sys,types; "
            "m=types.ModuleType('positional_grid'); "
            "m.POSITIONAL_DEPTH_BOUNDARIES=(0,16.67,33.33,50,66.67,83.33,100); "
            "m.POSITIONAL_LANE_BOUNDARIES=(0,21.82,37,63,78.18,100); "
            "m.POSITIONAL_CELL_FIELDS=tuple(f'grid_d{d}_l{l}_ratio' for d in range(1,7) for l in range(1,6)); "
            "sys.modules['positional_grid']=m; "
            "import true_core; "
            "assert true_core.true_core_zones_from_points([(90,50)])['zoneIds']==['depth6_lane3']"
        )
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=root,
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_true_core_backfill_has_an_explicit_definition_version(self) -> None:
        self.assertEqual(DEFINITION_VERSION, "continuous-hdr-50-v1")

    def test_continuous_core_uses_only_high_density_raster_area(self) -> None:
        points = [(25, 50)] * 80 + [(75, 50)] * 80 + [(50, 10)] * 20

        core = continuous_core_from_points(points)
        zone_core = true_core_zones_from_points(points)

        self.assertEqual(core["definitionVersion"], "continuous-hdr-50-v1")
        self.assertGreaterEqual(core["achievedDensityPct"], 50.0)
        self.assertGreater(core["coreAreaPct"], 0.0)
        self.assertLess(core["coreAreaPct"], zone_core["coreAreaPct"])
        self.assertEqual(core["coreMask"].shape, (22, 32))

    def test_continuous_core_summary_is_json_safe_and_empty_safe(self) -> None:
        summary = continuous_core_summary([])
        self.assertEqual(summary["coreAreaPct"], 0.0)
        self.assertEqual(summary["gridColumns"], 32)
        self.assertEqual(summary["gridRows"], 22)
        self.assertNotIn("density", summary)

    def test_shotmap_snapshot_keeps_only_source_coordinates(self) -> None:
        raw = [
            {"x": 103.95, "y": 34, "eventType": "Goal", "expectedGoals": 0.4},
            {"x": 80, "y": 40, "eventType": "AttemptSaved", "isOnTarget": True, "expectedGoalsOnTarget": 0.2},
            {"x": 70, "y": 30, "eventType": "AttemptSaved", "isBlocked": True},
            {"x": 120, "y": 40, "eventType": "Miss"},
        ]
        shots = normalize_shotmap(raw)
        self.assertEqual([shot["outcome"] for shot in shots], ["goal", "on_target", "blocked"])
        self.assertAlmostEqual(shots[0]["x"], 99.0, places=2)
        self.assertEqual(shots[0]["y"], 50.0)
        self.assertEqual(shots[0]["xg"], 0.4)
        self.assertIsNone(shots[0]["xgot"])
        self.assertEqual(shot_outcome({"eventType": "Miss"}), "off_target")
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

    def test_grid_occupancy_and_true_core_use_all_saved_points(self) -> None:
        core_points = [(10, 10)] * 4
        all_points = [*core_points, (90, 90)]

        metrics = spatial_metrics(core_points, positional_points=all_points)

        self.assertEqual(metrics["grid_d1_l1_ratio"], 80.0)
        self.assertEqual(metrics["grid_d6_l5_ratio"], 20.0)
        self.assertEqual(sum(metrics[f"lane_{lane}_ratio"] for lane in range(1, 6)), 100.0)
        self.assertGreater(metrics["cca_area_pct"], 0.0)

    def test_true_core_selects_the_minimum_cells_reaching_half_density(self) -> None:
        occupancy = {field: 0.0 for field in POSITIONAL_CELL_FIELDS}
        occupancy.update({
            "grid_d6_l3_ratio": 40.0,
            "grid_d5_l3_ratio": 30.0,
            "grid_d4_l3_ratio": 20.0,
            "grid_d3_l3_ratio": 10.0,
        })

        core = true_core_zones(occupancy)

        self.assertEqual(core["zoneIds"], ["depth6_lane3", "depth5_lane3"])
        self.assertEqual(core["zoneCount"], 2)
        self.assertEqual(core["achievedDensityPct"], 70.0)
        self.assertLess(core["zones"][0]["densityPct"], 50.0)
        expected_area = sum(
            (POSITIONAL_DEPTH_BOUNDARIES[depth] - POSITIONAL_DEPTH_BOUNDARIES[depth - 1])
            * (POSITIONAL_LANE_BOUNDARIES[3] - POSITIONAL_LANE_BOUNDARIES[2]) / 100.0
            for depth in (6, 5)
        )
        self.assertAlmostEqual(core["coreAreaPct"], expected_area, places=4)

    def test_true_core_excludes_zeroes_and_breaks_density_ties_by_depth_then_lane(self) -> None:
        occupancy = {field: 0.0 for field in POSITIONAL_CELL_FIELDS}
        occupancy.update({
            "grid_d2_l1_ratio": 25.0,
            "grid_d1_l2_ratio": 25.0,
            "grid_d1_l1_ratio": 25.0,
            "grid_d2_l2_ratio": 25.0,
        })

        core = true_core_zones(occupancy)

        self.assertEqual(core["zoneIds"], ["depth1_lane1", "depth1_lane2"])
        self.assertEqual(core["achievedDensityPct"], 50.0)
        self.assertNotIn("depth1_lane3", core["zoneIds"])

    def test_true_core_raw_point_wrapper_uses_the_same_30_zone_distribution(self) -> None:
        points = [(90, 50)] * 3 + [(10, 10)] * 2

        direct = true_core_zones(positional_grid_metrics(points))
        wrapped = true_core_zones_from_points(points)

        self.assertEqual(wrapped, direct)
        self.assertEqual(wrapped["zoneIds"], ["depth6_lane3"])
        self.assertEqual(wrapped["achievedDensityPct"], 60.0)

    def test_true_core_raw_counts_preserve_tie_break_before_rounding_residual(self) -> None:
        points = [(1, 1), (1, 25), (1, 50)]
        core = true_core_zones_from_points(points)
        self.assertEqual(core["zoneIds"], ["depth1_lane1", "depth1_lane2"])

    def test_spatial_metrics_keep_positional_core_when_repeat_filter_is_empty(self) -> None:
        metrics = spatial_metrics([], positional_points=[(90, 50), (90, 50)])
        self.assertEqual(metrics["grid_d6_l3_ratio"], 100.0)
        self.assertGreater(metrics["cca_area_pct"], 0.0)

    def test_true_core_returns_empty_for_zero_distribution_and_rejects_malformed_input(self) -> None:
        empty = {field: 0.0 for field in POSITIONAL_CELL_FIELDS}
        self.assertEqual(true_core_zones(empty), {
            "zoneIds": [], "zoneCount": 0, "coreAreaPct": 0.0,
            "achievedDensityPct": 0.0, "zones": [],
        })

        with self.assertRaisesRegex(ValueError, "missing"):
            true_core_zones({})
        invalid = dict(empty)
        invalid["grid_d1_l1_ratio"] = float("nan")
        with self.assertRaisesRegex(ValueError, "between 0 and 100"):
            true_core_zones(invalid)
        incomplete_total = dict(empty)
        incomplete_total["grid_d1_l1_ratio"] = 90.0
        with self.assertRaisesRegex(ValueError, "total 100"):
            true_core_zones(incomplete_total)

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

    def test_belgian_first_division_is_retained(self) -> None:
        metrics = extract_multi_season_metrics(_payload("First Division A", 999))
        self.assertIn("25/26_40", metrics)
        self.assertEqual(metrics["25/26_40"].league_id, 40)


class TacticalCoverageAuditTests(unittest.TestCase):
    @patch("tactical_ratio.get_tactical_ratio_for_session")
    def test_disabled_session_filter_never_requires_spatial_data(self, get_ratio) -> None:
        self.assertTrue(
            passes_final_third_filter(
                "792303", 0, "Liga Portugal", "2025/2026",
            )
        )
        get_ratio.assert_not_called()

    @patch("tactical_ratio.load_tactical_ratios")
    def test_session_lookup_never_falls_back_to_another_season(self, load_ratios) -> None:
        load_ratios.return_value = {"792303:8:old": {
            "fotmob_player_id": "792303",
            "competition_name": "LaLiga",
            "season_name": "2021/2022",
            "final_third_ratio": 60,
        }}

        self.assertIsNone(
            get_tactical_ratio_for_session(
                "792303", "Liga Portugal", "2025/2026",
            )
        )
        self.assertFalse(
            passes_final_third_filter(
                "792303", 50, "Liga Portugal", "2025/2026",
            )
        )

    @patch("tactical_ratio._with_current_spatial_definition", side_effect=lambda row: row)
    @patch("tactical_ratio.load_tactical_ratios")
    def test_session_filter_accepts_only_the_exact_session(
        self, load_ratios, _normalize_spatial,
    ) -> None:
        load_ratios.return_value = {"792303:61:current": {
            "fotmob_player_id": "792303",
            "competition_name": "Primeira Liga",
            "season_name": "2025/2026",
            "final_third_ratio": 55,
        }}

        self.assertTrue(
            passes_final_third_filter(
                "792303", 50, "Liga Portugal", "25/26",
            )
        )

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
    def test_resolves_official_v2_search_entity_shape(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str, max_attempts: int = 6):
                self.request = (path, key_scope, max_attempts)
                return {"success": True, "data": {"results": [{
                    "type": "player",
                    "score": 999,
                    "entity": {"id": 111505, "name": "Son Heung-min"},
                }]}}

        client = FakeClient()
        self.assertEqual(
            resolve_sportsapi_id(client, "Heung-Min Son"),
            "111505",
        )
        self.assertEqual(client.request[1:], ("player", 1))

    def test_v2_search_ignores_non_player_entities_with_same_name(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str, max_attempts: int = 6):
                return {"data": {"results": [{
                    "type": "team",
                    "entity": {"id": 1, "name": "Vitinha"},
                }]}}

        self.assertIsNone(resolve_sportsapi_id(FakeClient(), "Vitinha"))

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

    def test_maps_unique_name_with_given_and_family_order_reversed(self) -> None:
        players = {
            "111505": {"name": "Son Heung-min", "team_name": ""},
        }

        self.assertEqual(
            resolve_ranked_sportsapi_id(
                players, "Heung-Min Son", "Tottenham Hotspur",
            ),
            "111505",
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
    def test_belgian_catalog_omission_is_resolved_by_search(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str) -> dict:
                if path.startswith("search?"):
                    return {"results": [{
                        "type": "tournament",
                        "entity": {
                            "id": 38,
                            "name": "Pro League",
                            "category": {"name": "Belgium"},
                        },
                    }]}
                return {"leagues": []}

        with patch(
            "scripts.build_tactical_ratios.cached_tournament_discoveries",
            return_value={},
        ):
            discovered = discover_tournaments(FakeClient())

        self.assertEqual(
            {item["name"]: item["id"] for item in discovered},
            {"Belgian Pro League": 38, "Eredivisie": 37, "Primeira Liga": 238},
        )

    def test_belgian_search_rejects_non_belgian_pro_league(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str) -> dict:
                return {"results": [{
                    "type": "tournament",
                    "entity": {
                        "id": 999,
                        "name": "Pro League",
                        "category": {"name": "Iran"},
                    },
                }]}

        self.assertIsNone(search_belgian_tournament(FakeClient()))

    def test_distinctive_expanded_leagues_ignore_country_label_drift(self) -> None:
        class FakeClient:
            def get(self, path: str, key_scope: str) -> dict:
                self.request = (path, key_scope)
                return {"leagues": [
                    {"id": 37, "name": "Eredivisie", "countryName": "The Netherlands"},
                    {"id": 238, "name": "Liga Portugal", "countryName": "Portuguese Republic"},
                    {"id": 144, "name": "First Division A", "countryName": "Kingdom of Belgium"},
                ]}

        with patch(
            "scripts.build_tactical_ratios.cached_tournament_discoveries",
            return_value={},
        ):
            discovered = discover_tournaments(FakeClient())

        self.assertEqual(
            {item["name"]: item["id"] for item in discovered},
            {"Eredivisie": 37, "Primeira Liga": 238, "Belgian Pro League": 144},
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
