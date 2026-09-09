"""Lazy, integrity-checked offline pitch snapshots; no raw harvest fallback."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
import threading

from api_server.pitch_source_provider import PitchSourceProvider, COMPETITIONS
from api_server.box_subregion_contract import build_box_subregion_envelope
from api_server.box_subregion_core import calculate_box_subregions
from api_server.box_subregion_sources import aggregate_selected_box_sources
from api_server.native_body_part_sources import aggregate_mapped_native_body_parts

VERSION = "native-pitch-source-snapshot-v2"
MAX_DECODED_BYTES = 32 * 1024 * 1024
HEATMAP_PACK_BYTES = 2 * 1024 * 1024


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _decode(data):
    return json.loads(data, object_pairs_hook=_object, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))


def _keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected):
        raise ValueError("Snapshot keys contradict the pinned schema")


def _size(value, maximum):
    if type(value) is not int or not 0 < value <= maximum:
        raise ValueError("Snapshot size is invalid")


def _coverage(expected, values, kind):
    if kind == "heatmaps":
        return {"expectedKeys": sorted(expected), "observedKeys": sorted(k for k in expected if k in values), "missingKeys": sorted(k for k in expected if k not in values)}
    return {"expectedMatchIds": sorted(expected), "observedMatchIds": sorted(k for k in expected if k in values and values[k] is not None),
            "missingMatchIds": sorted(k for k in expected if k not in values), "invalidMatchIds": sorted(k for k in expected if k in values and values[k] is None)}


class PitchSnapshotProvider(PitchSourceProvider):
    """Keep exact cohort/CSV selection unchanged; only storage representation differs."""

    def __init__(self, data_root: Path, player_lookup):
        super().__init__(data_root, player_lookup)
        self.snapshot_root = self._path("pitch-native-v2")
        self.index = _decode(self._path("pitch-native-v2", "index.json").read_bytes())
        _keys(self.index, ("definitionVersion", "exporterRevision", "sourceRevision", "mappingCsvSha256", "mappingRows", "native", "heatmaps"))
        if self.index["definitionVersion"] != VERSION or self.index["exporterRevision"] != "native-pitch-exporter-v2":
            raise ValueError("Unsupported snapshot revision")
        encoded_sources = json.dumps({kind: self.index[kind] for kind in ("mappingCsvSha256", "native", "heatmaps")}, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if self.index["sourceRevision"] != hashlib.sha256(encoded_sources).hexdigest():
            raise ValueError("Snapshot source revision mismatch")
        mapping_hash = hashlib.sha256(self._path("tactical_3zone_ratio.csv").read_bytes()).hexdigest()
        if self.index["mappingCsvSha256"] != mapping_hash:
            raise ValueError("Snapshot mapping SHA does not match release CSV")
        self._groups = {}
        count = 0
        for rows in self._mapping_index.values():
            for row in rows:
                identity = self._identity(row)
                mappings = self._groups.setdefault(identity, {})
                if row["heatmap_key"] in mappings:
                    raise ValueError("Duplicate mapping key")
                mappings[row["heatmap_key"]] = row
                count += 1
        if type(self.index["mappingRows"]) is not int or self.index["mappingRows"] != count:
            raise ValueError("Snapshot mapping row count mismatch")
        paths = set()
        for kind in ("native", "heatmaps"):
            if not isinstance(self.index[kind], dict) or set(self.index[kind]) != set(self._groups):
                raise ValueError("Snapshot context set mismatch")
            for identity, entry in self.index[kind].items():
                _keys(entry, ("path", "sha256", "gzipBytes", "decodedBytes", "coverage", "mappingRows") if kind == "native" else ("mappingRows", "coverage", "keyToPack", "packs"))
                if type(entry["mappingRows"]) is not int or entry["mappingRows"] != len(self._groups[identity]):
                    raise ValueError("Shard mapping count mismatch")
                names = ("expectedMatchIds", "observedMatchIds", "missingMatchIds", "invalidMatchIds") if kind == "native" else ("expectedKeys", "observedKeys", "missingKeys")
                _keys(entry["coverage"], names)
                cov = entry["coverage"]
                for values in cov.values():
                    if not isinstance(values, list) or any(not isinstance(k, str) for k in values) or values != sorted(set(values)):
                        raise ValueError("Snapshot coverage keys invalid")
                partitions = sum((cov[name] for name in names[1:]), [])
                if len(partitions) != len(set(partitions)) or sorted(partitions) != cov[names[0]]:
                    raise ValueError("Snapshot coverage partition mismatch")
                if kind == "native":
                    self._validate_artifact(entry, f"native/{identity}.json.gz", paths, MAX_DECODED_BYTES)
                else:
                    expected = sorted({f"{r['sportsapi_player_id']}:{r['tournament_id']}:{r['season_id']}" for r in self._groups[identity].values()})
                    if cov["expectedKeys"] != expected:
                        raise ValueError("Heatmap expected keys differ from exact release mappings")
                    routing, packs = entry["keyToPack"], entry["packs"]
                    if not isinstance(routing, dict) or not isinstance(packs, dict) or set(routing) != set(cov["observedKeys"]):
                        raise ValueError("Heatmap key routing differs from observed coverage")
                    if any(not isinstance(value, str) for value in routing.values()) or set(routing.values()) != set(packs):
                        raise ValueError("Heatmap unknown/orphan pack")
                    if sorted(packs) != [f"{n:04d}" for n in range(len(packs))]:
                        raise ValueError("Heatmap pack IDs are noncanonical")
                    for pack_id, pack in packs.items():
                        _keys(pack, ("path", "sha256", "gzipBytes", "decodedBytes"))
                        self._validate_artifact(pack, f"heatmaps/{identity}/{pack_id}.json.gz", paths, HEATMAP_PACK_BYTES)
        self._cache_key = None
        self._cache_value = None
        self._lock = threading.RLock()

    def _validate_artifact(self, entry, expected_path, paths, cap):
        if entry["path"] != expected_path or entry["path"] in paths:
            raise ValueError("Snapshot path/context mismatch")
        paths.add(entry["path"])
        self._artifact_path(entry["path"])
        sha = entry["sha256"]
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise ValueError("Snapshot SHA is invalid")
        _size(entry["decodedBytes"], cap)
        _size(entry["gzipBytes"], cap + 1024 * 1024)

    @staticmethod
    def _identity(row):
        tournament, scope, slug = COMPETITIONS[row["competition_name"]]
        for field in ("fotmob_player_id", "sportsapi_player_id", "tournament_id", "season_id"):
            value = row[field]
            if not value.isascii() or not value.isdecimal() or value.startswith("0"):
                raise ValueError("Noncanonical mapping identity")
        if int(row["tournament_id"]) != tournament or row["heatmap_key"] != f"{row['fotmob_player_id']}:{tournament}:{row['season_id']}":
            raise ValueError("Mapping context mismatch")
        return f"{scope}/{slug}/{row['season_id']}"

    def _artifact_path(self, relative):
        path = self.snapshot_root.joinpath(relative).resolve()
        if not path.is_relative_to(self.snapshot_root):
            raise ValueError("Snapshot symlink/path escapes snapshot root")
        return path

    def _load(self, kind, identity, pack_id=None):
        source = self.index[kind][identity]
        entry = source if kind == "native" else source["packs"][pack_id]
        cap = MAX_DECODED_BYTES if kind == "native" else HEATMAP_PACK_BYTES
        path = self._artifact_path(entry["path"])
        stat = path.stat()  # An absent artifact is corruption, never source absence.
        cache_key = (kind, identity, pack_id, stat.st_size, stat.st_mtime_ns)
        with self._lock:
            if self._cache_key == cache_key:
                return self._cache_value
            # Evict before decompress/parse, not after retaining two decoded shards.
            self._cache_key, self._cache_value = None, None
            if stat.st_size != entry["gzipBytes"]:
                raise ValueError("Snapshot compressed size mismatch")
            compressed = path.read_bytes()
            if hashlib.sha256(compressed).hexdigest() != entry["sha256"]:
                raise ValueError("Snapshot compressed SHA mismatch")
            import io
            with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as handle:
                decoded = handle.read(cap + 1)
            if len(decoded) != entry["decodedBytes"] or len(decoded) > cap:
                raise ValueError("Snapshot decoded size mismatch")
            value = _decode(decoded)
            expected_keys = ("definitionVersion", "scope", "slug", "seasonId", "payloads")
            _keys(value, expected_keys + (("manifest", "mappings") if kind == "native" else ()))
            if value["definitionVersion"] != VERSION or [value["scope"], value["slug"], value["seasonId"]] != identity.split("/"):
                raise ValueError("Snapshot shard context mismatch")
            payloads = value["payloads"]
            if not isinstance(payloads, dict):
                raise ValueError("Snapshot payloads must be an object")
            mappings = self._groups[identity]
            if kind == "native":
                if value["mappings"] != mappings:
                    raise ValueError("Snapshot mapping payload mismatch")
                manifest = value["manifest"]
                expected = []
                if manifest is not None:
                    for row in mappings.values():
                        aggregate_mapped_native_body_parts(row, manifest, {})
                    expected = [str(x) for x in manifest["matchIds"]]
            else:
                expected = [key for key, destination in source["keyToPack"].items() if destination == pack_id]
            if kind == "native":
                if not set(payloads).issubset(expected) or _coverage(expected, payloads, kind) != entry["coverage"]:
                    raise ValueError("Snapshot source coverage mismatch")
            elif set(payloads) != set(expected):
                raise ValueError("Heatmap pack exact key membership mismatch")
            self._cache_key, self._cache_value = cache_key, value
            return value

    def native_sources(self, context):
        rows = self.selected_rows(context)
        if rows is None:
            return None
        result = []
        for row in rows:
            shard = self._load("native", self._identity(row))
            # Defensive copies: caller mutations cannot modify another request's sources/hash.
            result.append((row, copy.deepcopy(shard["manifest"]), {int(k): copy.deepcopy(v) for k, v in shard["payloads"].items()}))
        return result

    def full_activity_sources(self, context):
        """Return exact stored full-activity inputs, without display interpretation."""
        rows = self.selected_rows(context)
        if rows is None:
            return None
        result = []
        for row in rows:
            identity = self._identity(row)
            key = f"{row['sportsapi_player_id']}:{row['tournament_id']}:{row['season_id']}"
            pack_id = self.index["heatmaps"][identity]["keyToPack"].get(key)
            payload = None
            if pack_id is not None:
                payload = self._load("heatmaps", identity, pack_id)["payloads"][key]
            result.append((copy.deepcopy(row), copy.deepcopy(payload)))
        return result

    def box(self, context):
        rows = self.selected_rows(context)
        if rows is None:
            return None
        if not rows:
            coverage = {"state": "unavailable", "expectedKeys": [], "observedKeys": [], "missingKeys": []}
            return build_box_subregion_envelope(context, {"coverage": {"shots": coverage, "activity": coverage}, "aggregate": calculate_box_subregions(None, None)})
        try:
            shots_shard = self._json(self._path(f"tactical_shotmap_points_{context.season.replace('/', '_')}.json"))
        except FileNotFoundError:
            shots_shard = {}
        if not isinstance(shots_shard, dict):
            raise ValueError("Shot shard must be an exact-key object")
        contexts, shots, activity = [], {}, {}
        for row in rows:
            tournament, season, sports = int(row["tournament_id"]), int(row["season_id"]), int(row["sportsapi_player_id"])
            contexts.append({"fotmobPlayerId": context.playerId, "sportsapiPlayerId": sports, "tournamentId": tournament, "seasonId": season, "season": context.season})
            if row["heatmap_key"] in shots_shard:
                shots[row["heatmap_key"]] = shots_shard[row["heatmap_key"]]
            key = f"{sports}:{tournament}:{season}"
            identity = self._identity(row)
            pack_id = self.index["heatmaps"][identity]["keyToPack"].get(key)
            if pack_id is not None:
                heatmaps = self._load("heatmaps", identity, pack_id)["payloads"]
                activity[key] = copy.deepcopy(heatmaps[key])
        return build_box_subregion_envelope(context, aggregate_selected_box_sources(contexts, shots, activity))
