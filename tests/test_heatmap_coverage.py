import unittest
from unittest.mock import patch
from urllib.error import URLError

from metrics import extract_multi_season_metrics
from scripts.build_tactical_ratios import (
    SportsApiClient,
    discover_tournaments,
    missing_static_cohort_sessions,
    resolve_ranked_sportsapi_id,
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
