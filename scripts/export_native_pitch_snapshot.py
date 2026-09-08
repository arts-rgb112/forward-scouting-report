"""Deterministic offline export. Source harvest is read-only; no provider calls."""
import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api_server.pitch_source_provider import COMPETITIONS
from api_server.native_body_part_sources import aggregate_mapped_native_body_parts

VERSION = "native-pitch-source-snapshot-v2"
MAX_DECODED_BYTES = 32 * 1024 * 1024
HEATMAP_PACK_BYTES = 2 * 1024 * 1024


def artifact(document, relative, output, dry_run, limit):
    decoded = canonical(document)
    if len(decoded) > limit:
        raise ValueError(f"Decoded artifact exceeds cap: {relative}: {len(decoded)}")
    compressed = gzip.compress(decoded, compresslevel=9, mtime=0)
    if not dry_run:
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() != compressed:
            raise ValueError(f"Refusing to overwrite a different existing artifact: {relative}")
        target.write_bytes(compressed)
    return {"path": relative, "sha256": hashlib.sha256(compressed).hexdigest(),
            "gzipBytes": len(compressed), "decodedBytes": len(decoded)}


def heatmap_packs(header, payloads):
    """Sorted exact keys, indivisible payloads; byte cap includes the JSON wrapper."""
    pack = {}
    empty_bytes = len(canonical({**header, "payloads": {}}))
    size = empty_bytes
    for key in sorted(payloads):
        item_bytes = len(canonical(key)) + 1 + len(canonical(payloads[key]))
        if empty_bytes + item_bytes > HEATMAP_PACK_BYTES:
            raise ValueError(f"One heatmap payload exceeds the pack cap: {key}")
        addition = item_bytes + bool(pack)
        if size + addition > HEATMAP_PACK_BYTES:
            yield {**header, "payloads": pack}
            pack, size = {}, empty_bytes
            addition = item_bytes
        pack[key] = payloads[key]
        size += addition
    if pack:
        yield {**header, "payloads": pack}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def read_json(path):
    def unique_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("Duplicate source JSON key")
            value[key] = item
        return value
    before = path.stat()
    data = path.read_text(encoding="utf-8")
    after = path.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise ValueError("Source changed during export")
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite source JSON")))


def source_path(root, *parts):
    result = root.joinpath(*parts).resolve()
    if not result.is_relative_to(root):
        raise ValueError("Source path escapes root")
    return result


def shard_id(row):
    tournament, scope, slug = COMPETITIONS[row["competition_name"]]
    for field in ("fotmob_player_id", "sportsapi_player_id", "tournament_id", "season_id"):
        value = row[field]
        if not value.isascii() or not value.isdecimal() or value.startswith("0"):
            raise ValueError("Noncanonical mapping identity")
    if int(row["tournament_id"]) != tournament or row["heatmap_key"] != f"{row['fotmob_player_id']}:{tournament}:{row['season_id']}":
        raise ValueError("Mapping context mismatch")
    return f"{scope}/{slug}/{row['season_id']}"


def coverage(expected, payloads, kind):
    expected = sorted(expected)
    if kind == "heatmaps":
        return {"expectedKeys": expected, "observedKeys": [key for key in expected if key in payloads],
                "missingKeys": [key for key in expected if key not in payloads]}
    return {"expectedMatchIds": expected, "observedMatchIds": [key for key in expected if key in payloads and payloads[key] is not None],
            "missingMatchIds": [key for key in expected if key not in payloads],
            "invalidMatchIds": [key for key in expected if key in payloads and payloads[key] is None]}


def export_snapshot(source_root, mapping_csv, output, *, dry_run=True):
    source_root = Path(source_root).resolve(strict=True)
    mapping_csv = Path(mapping_csv).resolve(strict=True)
    output = Path(output).resolve()
    mapping_bytes = mapping_csv.read_bytes()
    rows = list(csv.DictReader(mapping_bytes.decode("utf-8-sig").splitlines()))
    groups = {}
    for row in rows:
        identity = shard_id(row)
        mappings = groups.setdefault(identity, {})
        if row["heatmap_key"] in mappings:
            raise ValueError("Duplicate exact mapping key")
        mappings[row["heatmap_key"]] = row
    index = {"definitionVersion": VERSION, "exporterRevision": "native-pitch-exporter-v2", "mappingCsvSha256": hashlib.sha256(mapping_bytes).hexdigest(),
             "mappingRows": len(rows), "native": {}, "heatmaps": {}}
    for identity, mappings in sorted(groups.items()):
        scope, slug, season_id = identity.split("/")
        first = next(iter(mappings.values()))
        manifest_path = source_path(source_root, "harvest", "match-event-manifests-v1", scope, slug, season_id, "manifest-main-stage.json")
        manifest = read_json(manifest_path) if manifest_path.exists() else None
        payloads = {}
        expected = []
        if manifest is not None:
            # Context validation before loading any match. Preserve complete decoded objects.
            aggregate_mapped_native_body_parts(first, manifest, {})
            expected = [str(value) for value in manifest["matchIds"]]
            for match_id in expected:
                path = source_path(source_root, "harvest", "match-shotmaps-v1", scope, slug, season_id, f"{match_id}.json")
                if path.exists():
                    try:
                        payloads[match_id] = read_json(path)
                    except json.JSONDecodeError:
                        payloads[match_id] = None
        native = {"definitionVersion": VERSION, "scope": scope, "slug": slug, "seasonId": season_id,
                  "manifest": manifest, "mappings": mappings, "payloads": payloads}
        heatmaps = {}
        for row in mappings.values():
            key = f"{row['sportsapi_player_id']}:{row['tournament_id']}:{season_id}"
            path = source_path(source_root, "harvest", "heatmaps", slug, season_id, f"{row['sportsapi_player_id']}.json")
            if path.exists():
                heatmaps[key] = read_json(path)
        heat_expected = {f"{r['sportsapi_player_id']}:{r['tournament_id']}:{season_id}" for r in mappings.values()}
        index["native"][identity] = {**artifact(native, f"native/{identity}.json.gz", output, dry_run, MAX_DECODED_BYTES),
                                     "mappingRows": len(mappings), "coverage": coverage(expected, payloads, "native")}
        heat_entry = {"mappingRows": len(mappings), "coverage": coverage(heat_expected, heatmaps, "heatmaps"), "keyToPack": {}, "packs": {}}
        header = {"definitionVersion": VERSION, "scope": scope, "slug": slug, "seasonId": season_id}
        for number, pack in enumerate(heatmap_packs(header, heatmaps)):
            pack_id = f"{number:04d}"
            heat_entry["packs"][pack_id] = artifact(pack, f"heatmaps/{identity}/{pack_id}.json.gz", output, dry_run, HEATMAP_PACK_BYTES)
            heat_entry["keyToPack"].update({key: pack_id for key in pack["payloads"]})
        index["heatmaps"][identity] = heat_entry
    index["sourceRevision"] = hashlib.sha256(canonical({kind: index[kind] for kind in ("mappingCsvSha256", "native", "heatmaps")})).hexdigest()
    if mapping_csv.read_bytes() != mapping_bytes:
        raise ValueError("Mapping changed during export")
    if not dry_run:
        output.mkdir(parents=True, exist_ok=True)
        target = output / "index.json"
        encoded = canonical(index)
        if target.exists() and target.read_bytes() != encoded:
            raise ValueError("Refusing to overwrite a different index")
        target.write_bytes(encoded)
    return index


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--mapping-csv", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--write", action="store_true", help="Default is read-only dry run")
    args = parser.parse_args()
    index = export_snapshot(args.source_root, args.mapping_csv, args.output, dry_run=not args.write)
    report = {"dryRun": not args.write, "mappingRows": index["mappingRows"], "mappingCsvSha256": index["mappingCsvSha256"]}
    for kind in ("native", "heatmaps"):
        items = list(index[kind].values())
        artifacts = items if kind == "native" else [pack for x in items for pack in x["packs"].values()]
        report[kind] = {"shards": len(items), "artifacts": len(artifacts), "gzipBytes": sum(x["gzipBytes"] for x in artifacts),
                        "decodedBytes": sum(x["decodedBytes"] for x in artifacts), "largestDecodedBytes": max((x["decodedBytes"] for x in artifacts), default=0),
                        **{key: sum(len(x["coverage"][key]) for x in items) for key in (("expectedMatchIds", "observedMatchIds", "missingMatchIds", "invalidMatchIds") if kind == "native" else ("expectedKeys", "observedKeys", "missingKeys"))}}
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
