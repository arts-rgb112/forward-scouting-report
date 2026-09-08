"""Read-only exact-context sources for the additive pitch APIs.

No application/service import, provider call, writable cache, or default root.
The application must inject its authoritative cohort lookup explicitly.
"""
from collections.abc import Callable
import csv
from dataclasses import dataclass
import json
from pathlib import Path

from api_server.box_subregion_contract import BoxContext, BoxSubregionEnvelope, build_box_subregion_envelope
from api_server.box_subregion_core import calculate_box_subregions
from api_server.box_subregion_sources import aggregate_selected_box_sources
from api_server.native_body_part_sources import aggregate_mapped_native_body_parts


# Provider IDs, not the different FotMob leaderboard league IDs.
COMPETITIONS = {
    "Premier League": (17, "domestic", "premier-league"),
    "LaLiga": (8, "domestic", "laliga"),
    "Bundesliga": (35, "domestic", "bundesliga"),
    "Serie A": (23, "domestic", "serie-a"),
    "Ligue 1": (34, "domestic", "ligue-1"),
    "Eredivisie": (37, "domestic", "eredivisie"),
    "Primeira Liga": (238, "domestic", "primeira-liga"),
    "Belgian Pro League": (38, "domestic", "belgian-pro-league"),
    "UEFA Champions League": (7, "europe", "uefa-champions-league"),
    "UEFA Europa League": (679, "europe", "uefa-europa-league"),
    "UEFA Europa Conference League": (17015, "europe", "uefa-europa-conference-league"),
}
EUROPE = {"ucl": "UEFA Champions League", "uel": "UEFA Europa League", "uecl": "UEFA Europa Conference League"}


@dataclass(frozen=True)
class ResolvedPitchPlayer:
    player_id: int
    league_name: str


class PitchSourceProvider:
    def __init__(self, data_root: Path, player_lookup: Callable[[BoxContext], ResolvedPitchPlayer | None]):
        if not data_root.is_absolute():
            raise ValueError("An explicit absolute data root is required")
        self.root = data_root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("data root must be a directory")
        self.player_lookup = player_lookup
        self._mapping_index = {}
        path = self._path("tactical_3zone_ratio.csv")
        stat = path.stat()
        self._mapping_revision = (stat.st_mtime_ns, stat.st_size)
        with path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                key = (row.get("fotmob_player_id"), row.get("season_name"), row.get("competition_name"))
                self._mapping_index.setdefault(key, []).append(row)
        current = path.stat()
        if (current.st_mtime_ns, current.st_size) != self._mapping_revision:
            raise ValueError("Mapping changed while constructing its index")

    def _path(self, *parts: str) -> Path:
        path = self.root.joinpath(*parts).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Source path escapes the configured data root")
        return path

    @staticmethod
    def _json(path: Path):
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)

    def _mapping_rows(self, context: BoxContext, competition: str):
        path = self._path("tactical_3zone_ratio.csv")
        stat = path.stat()
        revision = (stat.st_mtime_ns, stat.st_size)
        if revision != self._mapping_revision:
            raise ValueError("Mapping revision changed; construct a new provider explicitly")
        return self._mapping_index.get((str(context.playerId), context.season, competition), [])

    def selected_rows(self, context: BoxContext):
        # Validate/copy at this public boundary even outside the HTTP router.
        context = BoxContext.model_validate(context.model_dump())
        player = self.player_lookup(context.model_copy(deep=True))
        if player is None:
            return None
        if not isinstance(player, ResolvedPitchPlayer) or isinstance(player.player_id, bool) or not isinstance(player.player_id, int) or player.player_id != context.playerId:
            raise ValueError("Cohort lookup returned the wrong player identity")
        if context.mode == "league":
            catalog = COMPETITIONS.get(player.league_name)
            if catalog is None or catalog[1] != "domestic":
                raise ValueError("Resolved domestic league is not in the source catalog")
            names = [player.league_name]
        else:
            names = list(EUROPE.values()) if context.competition == "all" else [EUROPE[context.competition]]
        selected = []
        for name in names:
            rows = self._mapping_rows(context, name)
            if len(rows) > 1:
                raise ValueError("Ambiguous exact player/context mapping")
            if not rows:
                continue
            row = rows[0]
            ids = {}
            for key in ("fotmob_player_id", "sportsapi_player_id", "tournament_id", "season_id"):
                value = row.get(key, "")
                if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or value.startswith("0"):
                    raise ValueError("Mapping contains a noncanonical native ID")
                ids[key] = int(value)
            if ids["tournament_id"] != COMPETITIONS[name][0] or row.get("heatmap_key") != f"{context.playerId}:{ids['tournament_id']}:{ids['season_id']}":
                raise ValueError("Mapping identity does not match its catalog/context")
            selected.append(dict(row))
        return selected

    def box(self, context: BoxContext) -> BoxSubregionEnvelope | None:
        rows = self.selected_rows(context)
        if rows is None:
            return None
        if not rows:
            coverage = {"state": "unavailable", "expectedKeys": [], "observedKeys": [], "missingKeys": []}
            return build_box_subregion_envelope(context, {
                "coverage": {"shots": coverage, "activity": coverage},
                "aggregate": calculate_box_subregions(None, None),
            })
        shot_path = self._path(f"tactical_shotmap_points_{context.season.replace('/', '_')}.json")
        try:
            shard = self._json(shot_path)
        except FileNotFoundError:
            shard = {}
        else:
            if not isinstance(shard, dict):
                raise ValueError("Shot shard must be an exact-key object")
        contexts, shots, activity = [], {}, {}
        for row in rows:
            tournament, season_id, sportsapi = int(row["tournament_id"]), int(row["season_id"]), int(row["sportsapi_player_id"])
            contexts.append({"fotmobPlayerId": context.playerId, "sportsapiPlayerId": sportsapi,
                             "tournamentId": tournament, "seasonId": season_id, "season": context.season})
            key = row["heatmap_key"]
            if key in shard:
                shots[key] = shard[key]
            slug = COMPETITIONS[row["competition_name"]][2]
            try:
                activity[f"{sportsapi}:{tournament}:{season_id}"] = self._json(self._path("harvest", "heatmaps", slug, str(season_id), f"{sportsapi}.json"))
            except FileNotFoundError:
                pass  # Genuine absence only; corrupt/denied reads are not no-data.
        return build_box_subregion_envelope(context, aggregate_selected_box_sources(contexts, shots, activity))

    def native_sources(self, context: BoxContext):
        """Read exact native inputs; body-part aggregate/DTO owns interpretation."""
        rows = self.selected_rows(context)
        if rows is None:
            return None
        sources = []
        for row in rows:
            _, group, slug = COMPETITIONS[row["competition_name"]]
            season_id = row["season_id"]
            try:
                manifest = self._json(self._path("harvest", "match-event-manifests-v1", group, slug, season_id, "manifest-main-stage.json"))
            except FileNotFoundError:
                sources.append((row, None, {}))
                continue
            # Validate the manifest's entire exact mapping before any match read.
            validated = aggregate_mapped_native_body_parts(row, manifest, {})
            ids = validated["aggregate"]["coverage"]["expectedMatchIds"]
            payloads = {}
            for match_id in ids:
                try:
                    payloads[match_id] = self._json(self._path("harvest", "match-shotmaps-v1", group, slug, season_id, f"{match_id}.json"))
                except FileNotFoundError:
                    continue
                except json.JSONDecodeError:
                    payloads[match_id] = None  # Present-invalid, not missing/empty.
            sources.append((row, manifest, payloads))
        return sources

    def body_parts(self, context: BoxContext, include_penalties: bool = True):
        from api_server.native_body_part_contract import build_native_body_part_envelope

        if not isinstance(include_penalties, bool):
            raise ValueError("include_penalties must be a boolean")
        selected = self.native_sources(context)
        if selected is None:
            return None
        results = []
        for row, manifest, snapshots in selected:
            if manifest is None:
                results.append({"source": {
                    "provider": "sportsapi", "fotmobPlayerId": context.playerId,
                    "sourcePlayerId": int(row["sportsapi_player_id"]), "tournamentId": int(row["tournament_id"]),
                    "seasonId": int(row["season_id"]), "season": context.season,
                    "competition": row["competition_name"], "mappingKey": row["heatmap_key"],
                }, "aggregate": None})
            else:
                results.append(aggregate_mapped_native_body_parts(row, manifest, snapshots, include_penalties=include_penalties))
        return build_native_body_part_envelope(context, results, include_penalties=include_penalties)
