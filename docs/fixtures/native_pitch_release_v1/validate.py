"""Reproduce pinned production pitch envelopes using shipped local v2 artifacts only."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

QUERY = {"season": "2025/2026", "mode": "league", "scope": "8", "competition": "all"}
CASES = {
    "native-included.json": ("native-pitch-events", True),
    "native-excluded.json": ("native-pitch-events", False),
    "body-included.json": ("body-part-shooting-stats", True),
    "body-excluded.json": ("body-part-shooting-stats", False),
    "legacy-box.json": ("box-subregion-stats", None),
}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_documents():
    index_path = ROOT / "data/pitch-native-v2/index.json"
    provider_path = ROOT / "api_server/pitch_snapshot_provider.py"
    # Missing shipped artifacts are a failed release, never a test skip.
    if not index_path.is_file():
        raise FileNotFoundError("Required shipped pitch-native-v2/index.json is missing")
    before = (sha(index_path), sha(provider_path))
    from fastapi.testclient import TestClient
    from api_server.main import app

    client = TestClient(app)
    documents = {}
    for name, (endpoint, penalties) in CASES.items():
        params = dict(QUERY)
        if penalties is not None:
            params["includePenalties"] = str(penalties).lower()
        response = client.get(f"/api/v2/players/194165/{endpoint}", params=params)
        if response.status_code != 200:
            raise AssertionError(f"Production {endpoint} returned {response.status_code}, not 200")
        documents[name] = response.json()
    if before != (sha(index_path), sha(provider_path)):
        raise ValueError("Source index/provider changed during fixture capture")
    full, nonpk = documents["native-included.json"], documents["native-excluded.json"]
    assert (full["bodyParts"]["totals"]["shots"], full["bodyParts"]["totals"]["goals"]) == (119, 36)
    assert (nonpk["bodyParts"]["totals"]["shots"], nonpk["bodyParts"]["totals"]["goals"]) == (108, 26)
    assert full["snapshotRevision"] == nonpk["snapshotRevision"]
    assert full["bodyParts"] == documents["body-included.json"]
    assert nonpk["bodyParts"] == documents["body-excluded.json"]
    assert all(event["destination"]["observedHeightMeters"] is None for event in full["events"])
    index = json.loads(index_path.read_bytes())
    metadata = {
        "definitionVersion": "native-pitch-release-fixtures-v1", "playerId": 194165, "query": QUERY,
        "sourceIndex": "data/pitch-native-v2/index.json", "sourceIndexSha256": before[0],
        "sourceRevision": index["sourceRevision"], "provider": "api_server/pitch_snapshot_provider.py", "providerSha256": before[1],
        "nativeSnapshotRevision": full["snapshotRevision"],
        "files": {name: {"sha256": hashlib.sha256(canonical(value)).hexdigest(), "bytes": len(canonical(value))} for name, value in documents.items()},
    }
    return documents, metadata


def verify():
    documents, metadata = build_documents()
    expected_metadata = json.loads((HERE / "provenance.json").read_bytes())
    if metadata != expected_metadata:
        raise AssertionError("Pinned release fixture provenance changed")
    for name, document in documents.items():
        expected = (HERE / name).read_bytes()
        if expected != canonical(document):
            raise AssertionError(f"Production payload differs from pinned fixture: {name}")
    return metadata


def verify_provider_only_refresh():
    """Read-only approval evidence: no payload/source drift may be rebaselined."""
    documents, metadata = build_documents()
    expected = json.loads((HERE / "provenance.json").read_bytes())
    old_provider = expected["providerSha256"]
    comparison = dict(metadata, providerSha256=old_provider)
    if comparison != expected:
        raise AssertionError("Provider-only refresh refused: another provenance field changed")
    for name, document in documents.items():
        if (HERE / name).read_bytes() != canonical(document):
            raise AssertionError(f"Provider-only refresh refused: payload changed: {name}")
    return {"reason": "additive full_activity_sources accessor; all v1 payloads and source pins unchanged",
            "previousProviderSha256": old_provider, "providerSha256": metadata["providerSha256"],
            "verifiedUnchangedFiles": metadata["files"], "sourceIndexSha256": metadata["sourceIndexSha256"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Explicit one-time capture; different existing fixtures are never replaced")
    parser.add_argument("--check-provider-only-refresh", action="store_true", help="Read-only proof permitting only the provider hash metadata field to change")
    args = parser.parse_args()
    if args.check_provider_only_refresh:
        if args.write:
            raise ValueError("Refresh check cannot write fixtures")
        print(json.dumps(verify_provider_only_refresh()))
        return
    if args.write:
        documents, metadata = build_documents()
        for name, value in {**documents, "provenance.json": metadata}.items():
            path, encoded = HERE / name, canonical(value)
            if path.exists() and path.read_bytes() != encoded:
                raise ValueError(f"Refusing to overwrite different pinned fixture: {name}")
            path.write_bytes(encoded)
    else:
        metadata = verify()
    print(json.dumps({"verified": not args.write, "captured": args.write, "cases": len(CASES), "fixtureBytes": sum(f["bytes"] for f in metadata["files"].values()), "sourceIndexSha256": metadata["sourceIndexSha256"], "providerSha256": metadata["providerSha256"]}))


if __name__ == "__main__":
    main()
